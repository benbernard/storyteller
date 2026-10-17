"""A resumed audition must not silently reuse another cast or altered audio."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from audition_cache import cached_turn

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject


class AuditionCacheTest(unittest.TestCase):
    def test_changed_cast_is_rejected_even_when_text_matches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            receipt, audio, request = self.fixture(directory)
            with self.assertRaisesRegex(
                ValueError, "different text, voice, or settings"
            ):
                cached_turn(
                    receipt,
                    audio,
                    request={**request, "speaker": "Ryan"},
                    role="narrator",
                    index=0,
                )

    def test_modified_audio_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            receipt, audio, request = self.fixture(directory)
            audio.write_bytes(b"another generated recording")
            with self.assertRaisesRegex(ValueError, "does not match"):
                cached_turn(receipt, audio, request=request, role="narrator", index=0)

    def test_matching_turn_can_resume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            receipt, audio, request = self.fixture(directory)
            result = cached_turn(
                receipt, audio, request=request, role="narrator", index=0
            )
            self.assertEqual(result["job"]["id"], "original-job")

    def fixture(self, directory: Path) -> tuple[Path, Path, JsonObject]:
        receipt, audio = Path(directory) / "turn.json", Path(directory) / "turn.wav"
        request = {"text": "The door opened.", "speaker": "Serena", "seed": 12}
        audio.write_bytes(b"original generated recording")
        receipt.write_text(
            json.dumps(
                {
                    "request": request,
                    "role": "narrator",
                    "turn_index": 0,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "job": {"id": "original-job"},
                }
            )
        )
        return receipt, audio, request


if __name__ == "__main__":
    unittest.main()
