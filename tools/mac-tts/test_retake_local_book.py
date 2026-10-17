from __future__ import annotations
import hashlib
import tempfile
import unittest
from pathlib import Path

from local_book import digest, plan_chapter, read, save, units, wav_header
from retake_local_book import prepare_retakes, select_retakes

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject


class RetakeBookTests(unittest.TestCase):
    def fixture(self, root: Path) -> tuple[Path, JsonObject]:
        source = root / "original"
        text = "The first line. The second line. The last line."
        chapter = {
            "text": text,
            "contentHash": hashlib.sha256(text.encode()).hexdigest(),
            "chapterId": "one",
        }
        analysis = {
            "source": chapter["contentHash"],
            "spans": [
                {
                    "text": text,
                    "start": 0,
                    "end": units(text),
                    "speaker": "narrator",
                    "uid": "span",
                }
            ],
        }
        wav = wav_header(24000 * 4, 24000) + bytes(24000 * 4)
        cast = {
            "model": "chatterbox",
            "revision": "fixed",
            "voices": {
                "narrator": {
                    "reference_id": "reference",
                    "sha256": digest(wav),
                    "exaggeration": 0.45,
                }
            },
        }
        segments = plan_chapter(chapter, analysis, cast, 17)
        plan = {"cast": cast, "chapters": [{"chapterId": "one", "segments": segments}]}
        save(source / "plan.json", plan)
        ref = source / "references/narrator/reference.wav"
        ref.parent.mkdir(parents=True)
        ref.write_bytes(wav)
        for segment in segments:
            folder = source / "segments" / segment["fingerprint"]
            save(
                folder / "receipt.json",
                {
                    "fingerprint": segment["fingerprint"],
                    "request": segment["request"],
                    "wav_sha256": digest(wav),
                    "sample_rate": 24000,
                    "duration": 1,
                    "job": {"model": "chatterbox", "state": "succeeded"},
                },
            )
            (folder / "audio.wav").write_bytes(wav)
        return source, plan

    def test_retake_preserves_source_and_original_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, original = self.fixture(root)
            before = (source / "plan.json").read_bytes()
            selected = original["chapters"][0]["segments"][1]
            target = root / "retry"
            plan = prepare_retakes(
                source,
                target,
                [{"segment_uid": selected["uid"], "reason": "Possible omitted phrase"}],
            )
            old = original["chapters"][0]["segments"]
            new = plan["chapters"][0]["segments"]
            self.assertEqual([s["text"] for s in old], [s["text"] for s in new])
            self.assertEqual([s["spans"] for s in old], [s["spans"] for s in new])
            self.assertEqual([s["role"] for s in old], [s["role"] for s in new])
            self.assertEqual(old[0], new[0])
            self.assertNotEqual(old[1]["fingerprint"], new[1]["fingerprint"])
            self.assertEqual(
                new[1]["request"]["seed"], old[1]["request"]["seed"] + 1000
            )
            self.assertEqual((source / "plan.json").read_bytes(), before)
            cached = target / "segments" / old[0]["fingerprint"] / "audio.wav"
            cached.write_bytes(b"modified copy")
            self.assertNotEqual(
                cached.read_bytes(),
                (
                    source / "segments" / old[0]["fingerprint"] / "audio.wav"
                ).read_bytes(),
            )
            self.assertEqual(plan["parentPlan"], digest(original))

    def test_composition_keeps_only_explicitly_accepted_retakes(self) -> None:
        import shutil

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, original = self.fixture(root)
            old = original["chapters"][0]["segments"]
            candidate = root / "retry"
            retry = prepare_retakes(
                source,
                candidate,
                [{"segment_uid": s["uid"], "reason": "inspection"} for s in old[:2]],
            )
            new = retry["chapters"][0]["segments"]
            for s, replacement in zip(old[:2], new[:2]):
                folder = candidate / "segments" / replacement["fingerprint"]
                receipt = read(source / "segments" / s["fingerprint"] / "receipt.json")
                receipt.update(
                    fingerprint=replacement["fingerprint"],
                    request=replacement["request"],
                )
                save(folder / "receipt.json", receipt)
                shutil.copy2(
                    source / "segments" / s["fingerprint"] / "audio.wav",
                    folder / "audio.wav",
                )
            save(
                candidate / "runtime.json",
                {"model": {"id": "chatterbox", "revision": "fixed"}},
            )
            plan = select_retakes(source, candidate, root / "final", [old[0]["uid"]])
            final = plan["chapters"][0]["segments"]
            self.assertEqual(final[0], new[0])
            self.assertEqual(final[1:], old[1:])
            self.assertEqual(read(root / "final/runtime.json")["plan"], digest(plan))
            self.assertEqual(
                read(root / "final/retake-provenance.json")["rejected"], [old[1]["uid"]]
            )

    def test_bad_selection_or_corrupt_source_fails_before_target_created(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, original = self.fixture(root)
            target = root / "retry"
            with self.assertRaisesRegex(ValueError, "Unknown segment"):
                prepare_retakes(
                    source, target, [{"segment_uid": "absent", "reason": "test"}]
                )
            self.assertFalse(target.exists())
            segment = original["chapters"][0]["segments"][0]
            (source / "segments" / segment["fingerprint"] / "audio.wav").write_bytes(
                b"bad"
            )
            with self.assertRaisesRegex(ValueError, "WAV differs"):
                prepare_retakes(
                    source, target, [{"segment_uid": segment["uid"], "reason": "test"}]
                )
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
