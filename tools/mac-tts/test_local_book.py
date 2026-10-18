from __future__ import annotations
import copy
import hashlib
import shutil
import struct
import tempfile
from pathlib import Path
import unittest

from local_book import (
    digest,
    assemble,
    plan_chapter,
    punctuation_only,
    prepare,
    read,
    render,
    save,
    units,
    wav_data,
    wav_header,
)

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject
    from tts_typing import JsonValue


class LocalBookTests(unittest.TestCase):
    def fixture(self) -> tuple[JsonObject, JsonObject, JsonObject]:
        text = "A 🌙 rose. " * 100 + "“Hello,” she said.\n"
        chapter = {
            "text": text,
            "contentHash": hashlib.sha256(text.encode()).hexdigest(),
            "chapterId": "one",
        }
        analysis = {
            "source": chapter["contentHash"],
            "spans": [
                {
                    "text": text[:-18],
                    "start": 0,
                    "end": units(text[:-18]),
                    "speaker": "narrator",
                    "uid": "a",
                },
                {
                    "text": text[-18:],
                    "start": units(text[:-18]),
                    "end": units(text),
                    "speaker": "violet",
                    "uid": "b",
                },
            ],
        }
        cast = {
            "model": "qwen-base",
            "revision": "fixed",
            "voices": {
                role: {
                    "reference_id": role,
                    "transcript": "A sample.",
                    "sha256": role + "-hash",
                }
                for role in ["narrator", "violet"]
            },
        }
        return chapter, analysis, cast

    def test_exact_coverage_and_utf16_offsets_survive_splitting(self) -> None:
        chapter, analysis, cast = self.fixture()
        segments = plan_chapter(chapter, analysis, cast, 90)
        self.assertEqual("".join(s["text"] for s in segments), chapter["text"])
        spans = [p for s in segments for p in s["spans"]]
        self.assertEqual(spans[-1]["end"], units(chapter["text"]))
        self.assertTrue(all(a["end"] == b["start"] for a, b in zip(spans, spans[1:])))
        self.assertTrue(all(len(s["text"]) <= 90 for s in segments))

    def test_breeze_plan_records_its_actual_controls_and_preserves_source(self) -> None:
        chapter, analysis, cast = self.fixture()
        cast["model"] = "breeze-tts-2"
        segments = plan_chapter(chapter, analysis, cast)
        self.assertEqual("".join(segment["text"] for segment in segments), chapter["text"])
        for segment in segments:
            request = segment["request"]
            self.assertEqual(request["cfg_scale"], 4.0)
            self.assertEqual(request["max_tokens"], 1500)
            self.assertNotIn("repetition_penalty", request)
            self.assertEqual(request["ref_text"], "A sample.")

    def section_fixture(self) -> tuple[JsonObject, JsonObject, JsonObject]:
        chapter, _, cast = self.fixture()
        pieces = ["Author note: Thanks! ", "A 🌙 rose over the city. ", "Author note: Until tomorrow."]
        text = "".join(pieces)
        chapter.update(text=text, contentHash=hashlib.sha256(text.encode()).hexdigest())
        spans: list[JsonObject] = []
        cursor = 0
        for i, piece in enumerate(pieces):
            span: JsonObject = {"uid": f"span-{i}", "start": cursor, "end": cursor + units(piece),
                                "text": piece, "speaker": "narrator"}
            if i != 1:
                span["section"] = "author-note"
            spans.append(span)
            cursor += units(piece)
        return chapter, {"source": chapter["contentHash"], "spans": spans}, cast

    def test_local_models_preserve_note_boundaries_source_and_legacy_plan_shape(self) -> None:
        chapter, analysis, cast = self.section_fixture()
        original = copy.deepcopy((chapter, analysis, cast))
        cast["voices"]["narrator"]["exaggeration"] = 0.5
        for model in ["qwen-base", "breeze-tts-2", "chatterbox"]:
            cast["model"] = model
            segments = plan_chapter(chapter, analysis, cast, 3000)
            self.assertEqual([s.get("sectionKind") for s in segments], ["author-note", None, "author-note"])
            self.assertEqual("".join(s["text"] for s in segments), chapter["text"])
            self.assertEqual([p for s in segments for p in s["spans"]],
                             [{k: span[k] for k in ["uid", "start", "end"]} for span in analysis["spans"]])
            legacy = copy.deepcopy(analysis)
            for span in legacy["spans"]:
                span.pop("section", None)
            ordinary = plan_chapter(chapter, legacy, cast, 3000)
            self.assertEqual(len(ordinary), 1)
            self.assertTrue(all("sectionKind" not in s for s in ordinary))
        self.assertEqual((chapter, analysis), original[:2])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Requires local audio tools")
    def test_local_assembly_retains_source_note_timings_and_reuses_immutable_metadata(self) -> None:
        chapter, analysis, cast = self.section_fixture()
        segments = plan_chapter(chapter, analysis, cast, 3000)
        plan: JsonObject = {"policy": {"joinPauseMs": 120}, "chapters": [{"chapterId": chapter["chapterId"],
                            "sequence": 1, "source": "source", "analysis": "analysis", "segments": segments}]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state, directory = root / "state", root / "job"
            save(directory / "plan.json", plan)
            save(directory / "runtime.json", {"plan": digest(plan)})
            audio = wav_header(24000 * 4, 24000) + struct.pack("<f", .05) * 24000
            for segment in segments:
                folder = directory / "segments" / segment["fingerprint"]
                folder.mkdir(parents=True)
                (folder / "audio.wav").write_bytes(audio)
                save(folder / "receipt.json", {"request": segment["request"], "fingerprint": segment["fingerprint"],
                                              "wav_sha256": digest(audio)})
            assemble(state, directory, "first")
            delivery = read(state / "deliveries/first/manifest.json")
            path = state / "assemblies" / delivery["chapters"][0]["assembly"] / "metadata.json"
            before = path.read_bytes()
            timeline = read(path)["timeline"]
            self.assertEqual([entry.get("sectionKind") for entry in timeline], ["author-note", None, "author-note"])
            self.assertEqual([entry["spans"] for entry in timeline], [segment["spans"] for segment in segments])
            self.assertTrue(all(entry["end"] > entry["start"] for entry in timeline))
            assemble(state, directory, "again")
            self.assertEqual(path.read_bytes(), before)

    def test_titles_and_author_notes_keep_body_assets_and_offsets(self) -> None:
        chapter, analysis, cast = self.fixture()
        body = plan_chapter(chapter, analysis, cast)
        chapter.update(title="Volume 2 - Chapter 76 - The Plan", sequence=260)
        cast["voices"]["author-note"] = {**cast["voices"]["violet"]}
        updated = plan_chapter(chapter, analysis, cast, presentation={"before": "Before note.", "after": "After note."})
        self.assertEqual(updated[0]["text"], chapter["title"])
        self.assertEqual([s["role"] for s in updated[:2]], ["narrator", "author-note"])
        self.assertEqual(updated[-1]["role"], "author-note")
        self.assertEqual([s["fingerprint"] for s in body], [s["fingerprint"] for s in updated if s["spans"]])
        self.assertTrue(all(not s["spans"] for s in updated if "presentation" in s))
        chapter["title"] = "The Invasion Begins"
        self.assertEqual(plan_chapter(chapter, analysis, cast)[0]["text"], "Chapter 260: The Invasion Begins")
        cast["voices"]["author-note"] = cast["voices"]["narrator"]
        with self.assertRaisesRegex(ValueError, "distinct"):
            plan_chapter(chapter, analysis, cast, presentation={"before": "A note."})

    def test_stale_analysis_and_missing_cast_fail_before_render(self) -> None:
        chapter, analysis, cast = self.fixture()
        broken = copy.deepcopy(analysis)
        broken["spans"][0]["text"] = "Different text"
        with self.assertRaises(AssertionError):
            plan_chapter(chapter, broken, cast)
        del cast["voices"]["violet"]
        with self.assertRaisesRegex(ValueError, "Missing explicit voice"):
            plan_chapter(chapter, analysis, cast)

    def test_voice_or_model_changes_invalidate_audio_key(self) -> None:
        chapter, analysis, cast = self.fixture()
        first = plan_chapter(chapter, analysis, cast)[0]["fingerprint"]
        cast["voices"]["narrator"]["sha256"] = "replacement"
        second = plan_chapter(chapter, analysis, cast)[0]["fingerprint"]
        self.assertNotEqual(first, second)
        cast["revision"] = "new-model"
        self.assertNotEqual(
            second, plan_chapter(chapter, analysis, cast)[0]["fingerprint"]
        )

    def test_chatterbox_keeps_text_and_cast_with_supported_controls(self) -> None:
        chapter, analysis, cast = self.fixture()
        qwen = plan_chapter(chapter, analysis, cast)
        cast["model"] = "chatterbox"
        for voice in cast["voices"].values():
            voice["exaggeration"] = 0.45
        chatter = plan_chapter(chapter, analysis, cast)
        self.assertEqual([s["spans"] for s in qwen], [s["spans"] for s in chatter])
        self.assertEqual([s["text"] for s in qwen], [s["text"] for s in chatter])
        self.assertNotEqual(qwen[0]["fingerprint"], chatter[0]["fingerprint"])
        self.assertNotIn("ref_text", chatter[0]["request"])
        self.assertNotIn("language", chatter[0]["request"])
        self.assertEqual(chatter[0]["request"]["cfg_weight"], 0.5)
        cast["voices"]["narrator"]["exaggeration"] = 0.6
        self.assertNotEqual(
            chatter[0]["fingerprint"],
            plan_chapter(chapter, analysis, cast)[0]["fingerprint"],
        )

    def test_explicit_chapters_and_legacy_first_five(self) -> None:
        import tempfile
        from pathlib import Path

        chapter, analysis, cast = self.fixture()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / "state"
            entries = []
            for i in range(6):
                chapter_id = "chapter-" + str(i + 1)
                source_id = "source-" + str(i)
                analysis_id = "analysis-" + str(i)
                entries.append(
                    {"id": chapter_id, "current": source_id, "sequence": i + 1}
                )
                save(
                    state / "heads" / (chapter_id + ".json"),
                    {"source": source_id, "analysis": analysis_id},
                )
                save(
                    state / "sources" / (source_id + ".json"),
                    {**chapter, "chapterId": chapter_id, "title": chapter_id},
                )
                save(state / "analyses" / (analysis_id + ".json"), analysis)
            save(state / "index.json", {"fictionId": "story", "chapters": entries})
            save(root / "cast.json", cast)
            prepare(state, root / "legacy", root / "cast.json")
            self.assertEqual(
                [c["sequence"] for c in read(root / "legacy/plan.json")["chapters"]],
                [1, 2, 3, 4, 5],
            )
            prepare(
                state, root / "explicit", root / "cast.json", ["chapter-6", "chapter-2"]
            )
            self.assertEqual(
                [c["sequence"] for c in read(root / "explicit/plan.json")["chapters"]],
                [2, 6],
            )
            with self.assertRaisesRegex(ValueError, "Unknown chapter"):
                prepare(state, root / "unknown", root / "cast.json", ["chapter-7"])
            with self.assertRaisesRegex(ValueError, "distinct"):
                prepare(
                    state,
                    root / "duplicate",
                    root / "cast.json",
                    ["chapter-2", "chapter-2"],
                )

    def test_chatterbox_render_routes_and_resumes_without_new_job(self) -> None:
        import tempfile
        from pathlib import Path

        chapter, analysis, cast = self.fixture()
        cast["model"] = "chatterbox"
        for voice in cast["voices"].values():
            voice.update(exaggeration=0.45, sha256=digest(b"reference"))
        segment = plan_chapter(chapter, analysis, cast, 20)[0]
        punctuation = {**segment, "text": "]\n\n", "fingerprint": "punctuation",
                       "request": {**segment["request"], "text": "]\n\n"}}
        wav = wav_header(24000 * 4, 24000) + bytes(24000 * 4)

        class FakeAPI:
            def __init__(self) -> None:
                self.calls = []

            def call(
                self, path: str, value: JsonValue = None, raw: bool = False
            ) -> JsonValue | bytes:
                self.calls.append((path, value))
                if path == "/health":
                    return {"active": None, "queued": 0}
                if path == "/v1/models":
                    return {"models": [{"id": "chatterbox", "revision": "fixed"}]}
                if path.startswith("/v1/references/"):
                    return b"reference"
                if path.endswith("/audio"):
                    return wav
                return {"id": "test", "state": "succeeded", "model": "chatterbox"}

            def wait(self, job: JsonObject) -> JsonObject:
                return job

        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            save(
                directory / "plan.json",
                {"cast": cast, "chapters": [{"sequence": 1, "segments": [segment, punctuation]}]},
            )
            # A failed earlier TTS attempt must not be polled for punctuation.
            save(directory / "segments/punctuation/pending.json", {"job": {"id": "failed"}})
            api = FakeAPI()
            render(directory, api)
            jobs = [value for path, value in api.calls if path == "/v1/jobs"]
            self.assertEqual(
                jobs, [{"model": "chatterbox", "input": segment["request"]}]
            )
            self.assertIn(("/v1/switch", {"model": "chatterbox"}), api.calls)
            receipt = read(directory / "segments/punctuation/receipt.json")
            self.assertEqual(receipt["rendering"], "punctuation-only-pause-v1")
            rate, data = wav_data((directory / "segments/punctuation/audio.wav").read_bytes())
            self.assertEqual((rate, len(data)), (24000, 9600))
            self.assertFalse(any(data))
            api.calls.clear()
            render(directory, api)
            self.assertFalse(any(path == "/v1/jobs" for path, _ in api.calls))
            self.assertEqual(api.calls[-1], ("/v1/stop", {}))

    def test_truncated_or_nonfinite_wav_is_rejected(self) -> None:
        import struct

        with self.assertRaises(AssertionError):
            wav_data(wav_header(8, 24000) + bytes(4))
        with self.assertRaises(AssertionError):
            wav_data(wav_header(4, 24000) + struct.pack("<f", float("nan")))


if __name__ == "__main__":
    unittest.main()


class PunctuationTests(unittest.TestCase):
    def test_only_structural_punctuation_is_silent(self) -> None:
        for text in ["]\n\n", "—", "…", " ( ) "]:
            self.assertTrue(punctuation_only(text))
        for text in ["Hello!", "42", "👍", "$", "+", ""]:
            self.assertFalse(punctuation_only(text))
