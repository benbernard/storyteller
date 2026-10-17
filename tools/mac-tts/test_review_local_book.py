"""ASR reviews must preserve source identity and never reuse stale audio."""

from __future__ import annotations

import copy
import struct
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock
from local_book import digest, wav_header, save
from review_local_book import analyze, cache_key, validate_segment, Reviewer

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject


def asr(text: str) -> JsonObject:
    words = text.split()
    return {
        "text": text,
        "segments": [
            {
                "words": [
                    {"word": w, "start": i * 0.2, "end": (i + 1) * 0.2}
                    for i, w in enumerate(words)
                ]
            }
        ],
    }


class ReviewTests(unittest.TestCase):
    def test_alignment_keeps_missing_ending_and_insertions(self) -> None:
        report = analyze(
            "We went to the quiet room.", asr("We really went to the quiet")
        )
        self.assertEqual(report["deletions"], 1)
        self.assertEqual(report["insertions"], 1)
        self.assertFalse(report["ending_exact"])
        self.assertIn("ending_needs_review", report["flags"])
        self.assertTrue(
            any(
                r["expected"] == "room" and r["operation"] == "delete"
                for r in report["alignment"]
            )
        )

    def test_repeated_output_is_flagged_but_source_repetition_is_not(self) -> None:
        self.assertIn(
            "possible_repetition",
            analyze("We are ready.", asr("We are ready " * 4))["flags"],
        )
        self.assertNotIn(
            "possible_repetition",
            analyze("We are ready " * 4, asr("We are ready " * 4))["flags"],
        )

    def test_normalized_reference_match_is_explicit(self) -> None:
        self.assertTrue(
            analyze("Hello, we’re ready!", asr("Hello we're ready"))[
                "normalized_transcript_match"
            ]
        )
        self.assertFalse(
            analyze("Hello, we are ready!", asr("Hello we ready"))[
                "normalized_transcript_match"
            ]
        )

    def test_resume_identity_changes_with_audio_text_receipt_or_source(self) -> None:
        baseline = cache_key("wav", "Text", {"receipt": 1}, "source")
        for value in [
            cache_key("other", "Text", {"receipt": 1}, "source"),
            cache_key("wav", "Changed", {"receipt": 1}, "source"),
            cache_key("wav", "Text", {"receipt": 2}, "source"),
            cache_key("wav", "Text", {"receipt": 1}, "other"),
        ]:
            self.assertNotEqual(baseline, value)

    def test_reference_summary_never_regresses_to_partial_on_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reviewer = Reviewer(SimpleNamespace(local=directory, source_commit="test"))
            voices = {}
            for role in ["one", "two"]:
                wave = role.encode()
                voice = {
                    "reference_id": role,
                    "sha256": digest(wave),
                    "transcript": "Hello",
                }
                folder = reviewer.inputs / "references" / role
                folder.mkdir(parents=True)
                (folder / "reference.wav").write_bytes(wave)
                save(folder / "voice.json", voice)
                voices[role] = voice
            reviewer.report = Mock(
                side_effect=lambda wav, text, metadata, key: {
                    **metadata,
                    "review_status": "complete",
                    "review_key": key,
                    "wav_sha256": digest(wav),
                    "normalized_transcript_match": True,
                    "word_recall": 1,
                    "ending_coverage": 1,
                    "flags": [],
                    "priority": "no_asr_flags",
                }
            )
            publications = []

            def capture() -> None:
                import json

                value = json.loads(
                    (reviewer.output / "reference-review.json").read_text()
                )
                publications.append((len(value["references"]), value["complete"]))

            reviewer.export = capture
            reviewer.references({"cast": {"voices": voices}})
            reviewer.references({"cast": {"voices": voices}})
            self.assertEqual(publications, [(2, True), (2, True)])
            self.assertEqual(reviewer.report.call_count, 2)

    def test_receipt_and_wave_hashes_are_both_required(self) -> None:
        request = {"text": "A test."}
        voice = {"sha256": "ref"}
        plan = {
            "cast": {
                "voices": {"narrator": voice},
                "model": "qwen-base",
                "revision": "fixed",
            }
        }
        key = digest(
            {
                "request": request,
                "reference_sha256": "ref",
                "model": "qwen-base",
                "revision": "fixed",
            }
        )
        segment = {
            "role": "narrator",
            "text": "A test.",
            "request": request,
            "fingerprint": key,
        }
        segment["spans"] = [{"uid": "source-span", "start": 0, "end": 7}]
        chapter = {"chapterId": "chapter-one"}
        segment["uid"] = digest(
            {"chapter": chapter["chapterId"], "spans": segment["spans"], "asset": key}
        )
        data = struct.pack("<100f", *[0.1] * 100)
        wav = wav_header(len(data), 24000) + data
        receipt = {
            "request": request,
            "fingerprint": key,
            "wav_sha256": digest(wav),
            "sample_rate": 24000,
            "duration": 100 / 24000,
            "job": {"state": "succeeded", "model": "qwen-base"},
        }
        validate_segment(plan, chapter, segment, receipt, wav)
        with self.assertRaisesRegex(ValueError, "WAV differs"):
            validate_segment(plan, chapter, segment, receipt, wav[:-1] + b"\xff")
        changed = copy.deepcopy(receipt)
        changed["request"]["text"] = "Other"
        with self.assertRaisesRegex(ValueError, "Receipt/plan"):
            validate_segment(plan, chapter, segment, changed, wav)


if __name__ == "__main__":
    unittest.main()
