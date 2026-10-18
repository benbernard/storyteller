"""Model-free checks for exact offline phoneme snapshots and cache selection."""
from __future__ import annotations

import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from phonemes import MODEL, REVISION, model_snapshot, verify_model_snapshot


class PhonemeSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.files = {"config.json": b"fixed config", "preprocessor_config.json": b"fixed processor",
                      "pytorch_model.bin": b"fixed weights"}
        self.checksums = {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}

    def install(self, cache: Path, revision: str = REVISION) -> Path:
        snapshot = cache / ("models--" + MODEL.replace("/", "--")) / "snapshots" / revision
        snapshot.mkdir(parents=True)
        for name, data in self.files.items():
            (snapshot / name).write_bytes(data)
        return snapshot

    def test_default_snapshot_is_exact_verified_and_does_not_need_refs_or_network(self) -> None:
        snapshot = self.install(self.home / ".cache/huggingface/hub")
        with patch("socket.socket", side_effect=AssertionError("No network lookup allowed")):
            self.assertEqual(model_snapshot({}, self.home, self.checksums), snapshot)

    def test_custom_cache_and_mac_tts_home_are_considered_without_accepting_another_revision(self) -> None:
        custom = self.home / "custom-cache"
        self.install(custom, "different-revision")
        with self.assertRaises(FileNotFoundError):
            model_snapshot({"HF_HUB_CACHE": str(custom)}, self.home, self.checksums)
        mac_home = self.home / "mac-tts"
        snapshot = self.install(mac_home / "cache/huggingface/hub")
        self.assertEqual(model_snapshot({"MAC_TTS_HOME": str(mac_home)}, self.home, self.checksums), snapshot)

    def test_incomplete_or_corrupt_cache_is_not_used_and_a_verified_alternative_can_resolve(self) -> None:
        custom = self.home / "custom-cache"
        corrupt = self.install(custom)
        (corrupt / "pytorch_model.bin").write_bytes(b"wrong weights")
        with self.assertRaisesRegex(ValueError, "checksum differs"):
            verify_model_snapshot(corrupt, self.checksums)
        with self.assertRaisesRegex(FileNotFoundError, "--bootstrap-model"):
            model_snapshot({"HF_HUB_CACHE": str(custom)}, self.home, self.checksums)
        fallback = self.install(self.home / ".cache/huggingface/hub")
        self.assertEqual(model_snapshot({"HF_HUB_CACHE": str(custom)}, self.home, self.checksums), fallback)
        (fallback / "preprocessor_config.json").unlink()
        with self.assertRaisesRegex(FileNotFoundError, "--bootstrap-model"):
            model_snapshot({"HF_HUB_CACHE": str(custom)}, self.home, self.checksums)

    def test_explicit_snapshot_cannot_fall_back_silently_or_change_revision(self) -> None:
        verified = self.install(self.home / ".cache/huggingface/hub")
        other = self.install(self.home / "other", "different-revision")
        with self.assertRaisesRegex(ValueError, "exact pinned revision"):
            model_snapshot({"STORYTELLER_PHONEME_SNAPSHOT": str(other)}, self.home, self.checksums)
        self.assertEqual(model_snapshot({"STORYTELLER_PHONEME_SNAPSHOT": str(verified)}, self.home,
                                        self.checksums), verified)

    def test_unverified_weights_or_tokenizer_files_cannot_override_the_checked_files(self) -> None:
        snapshot = self.install(self.home / ".cache/huggingface/hub")
        for name in ("model.safetensors", "model.safetensors.index.json", "added_tokens.json",
                     "tokenizer.json", "processor_config.json"):
            with self.subTest(name=name):
                extra = snapshot / name
                extra.write_bytes(b"unverified override")
                with self.assertRaisesRegex(ValueError, "unverified extra files"):
                    verify_model_snapshot(snapshot, self.checksums)
                extra.unlink()
