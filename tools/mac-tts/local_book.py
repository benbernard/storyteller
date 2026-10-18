#!/usr/bin/env python3
"""Resumable local chapter renders using reviewed spans and an explicit reference cast."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import struct
import shutil
import subprocess
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import BookAPI
    from collections.abc import Iterator
    from tts_typing import JsonObject
    from tts_typing import JsonValue
    from collections.abc import Sequence


def digest(value: JsonValue | bytes) -> str:
    if not isinstance(value, bytes):
        value = json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    return hashlib.sha256(value).hexdigest()


def read(path: str | Path) -> JsonObject:
    return json.loads(Path(path).read_text())


def save(path: str | Path, value: JsonValue) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".pending")
    with open(tmp, "w") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def split_text(text: str, limit: int) -> Iterator[str]:
    """Keep every character; prefer sentence and whitespace boundaries."""
    while len(text) > limit:
        cuts = list(re.finditer(r"[.!?][”\"\']?\s+|\n+", text[:limit]))
        cut = cuts[-1].end() if cuts else text.rfind(" ", 0, limit) + 1
        if cut < limit // 3:
            cut = limit
        yield text[:cut]
        text = text[cut:]
    if text:
        yield text


def plan_chapter(
    chapter: JsonObject, analysis: JsonObject, cast: JsonObject, limit: int = 550,
    presentation: JsonObject | None = None,
) -> list[JsonObject]:
    assert (
        hashlib.sha256(chapter["text"].encode()).hexdigest() == chapter["contentHash"]
    ), "Source hash mismatch"
    assert analysis["source"] == chapter["contentHash"], "Analysis source mismatch"
    assert "".join(s["text"] for s in analysis["spans"]) == chapter["text"], (
        "Analysis coverage mismatch"
    )
    segments = []
    cursor = 0
    for span in analysis["spans"]:
        assert span["start"] == cursor and span["end"] == cursor + units(
            span["text"]
        ), "Span offsets mismatch"
        role = span["speaker"]
        section = "author-note" if span.get("section") == "author-note" else None
        if role not in cast["voices"]:
            raise ValueError("Missing explicit voice for " + role)
        for part in split_text(span["text"], limit):
            entry = {"uid": span["uid"], "start": cursor, "end": cursor + units(part)}
            cursor = entry["end"]
            if (
                segments
                and segments[-1]["role"] == role
                and segments[-1].get("sectionKind") == section
                and len(segments[-1]["text"]) + len(part) <= limit
            ):
                segments[-1]["text"] += part
                segments[-1]["spans"].append(entry)
            else:
                segments.append({"role": role, "text": part, "spans": [entry],
                                 **({"sectionKind": section} if section else {})})
    assert "".join(s["text"] for s in segments) == chapter["text"]
    # Keep body seeds stable so a repair reuses every unchanged passage.
    for i, segment in enumerate(segments):
        segment["seed"] = 810 + i
    extras = presentation or {}
    title = chapter.get("title", "").strip()
    if title and not re.search(r"\b(chapter|interlude|intermission|prologue|epilogue|volume)\b", title, re.I) and chapter.get("sequence") and not chapter["chapterId"].startswith(("guide-", "recap-")):
        title = f"Chapter {chapter['sequence']}: {title}"
    def supplement(text: str, role: str, kind: str) -> list[JsonObject]:
        return [{"role": role, "text": part, "spans": [], "presentation": kind, "seed": 1810 + i}
                for i, part in enumerate(split_text(text, limit))]
    if extras.get("before") or extras.get("after"):
        if "author-note" not in cast["voices"] or cast["voices"]["author-note"]["sha256"] == cast["voices"]["narrator"]["sha256"]:
            raise ValueError("Author notes need a distinct explicit voice")
    segments = (supplement(title, "narrator", "title")
                + supplement(extras.get("before", ""), "author-note", "author-note-before")
                + segments
                + supplement(extras.get("after", ""), "author-note", "author-note-after"))
    for segment in segments:
        voice = cast["voices"][segment["role"]]
        common = {
            "text": segment["text"],
            "reference_id": voice["reference_id"],
            "seed": segment.pop("seed"),
            "max_tokens": 1024,
        }
        if cast["model"] == "breeze-tts-2":
            segment["request"] = {
                **common,
                "ref_text": voice["transcript"],
                "cfg_scale": 4.0,
                "max_tokens": 1500,
            }
        elif cast["model"] == "qwen-base":
            segment["request"] = {
                **common,
                "ref_text": voice["transcript"],
                "language": "English",
                "temperature": 0.85,
                "top_p": 0.9,
                "repetition_penalty": 1.5,
            }
        elif cast["model"] == "chatterbox":
            segment["request"] = {
                **common,
                "exaggeration": voice["exaggeration"],
                "cfg_weight": 0.5,
                "temperature": 0.8,
                "top_p": 0.95,
                "min_p": 0.05,
                "repetition_penalty": 1.2,
            }
        else:
            raise ValueError("Unsupported local book model: " + cast["model"])
        segment["fingerprint"] = digest(
            {
                "request": segment["request"],
                "reference_sha256": voice["sha256"],
                "model": cast["model"],
                "revision": cast["revision"],
            }
        )
        segment["uid"] = digest(
            {
                "chapter": chapter["chapterId"],
                "spans": segment["spans"],
                "asset": segment["fingerprint"],
            }
        )
    return segments


class API:
    def __init__(self, credential: str | Path) -> None:
        self.credential = read(credential)

    def call(
        self,
        path: str,
        value: JsonValue = None,
        raw: bool = False,
        upload: bytes | None = None,
    ) -> JsonValue | bytes:
        data = (
            upload
            if upload is not None
            else json.dumps(value).encode()
            if value is not None
            else None
        )
        req = urllib.request.Request(
            self.credential["endpoint"] + path,
            data=data,
            headers={
                "Authorization": "Bearer " + self.credential["token"],
                "Content-Type": "audio/wav"
                if upload is not None
                else "application/json",
                **(
                    {"X-Worker-Lease": os.environ["MAC_TTS_LEASE"]}
                    if os.environ.get("MAC_TTS_LEASE")
                    else {}
                ),
            },
        )
        with urllib.request.urlopen(req, timeout=90) as response:
            result = response.read()
            return result if raw else json.loads(result)

    def wait(self, job: JsonObject) -> JsonObject:
        deadline = time.monotonic() + 1500
        while job["state"] in ["queued", "running"]:
            if time.monotonic() > deadline:
                raise TimeoutError("Job still active; resume with saved ID")
            time.sleep(1)
            job = self.call("/v1/jobs/" + job["id"])
        if job["state"] != "succeeded":
            raise RuntimeError(
                "Local job failed: " + job["id"] + " " + str(job.get("error"))
            )
        return job


def wav_data(wav: bytes) -> tuple[int, bytes]:
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    pos, fmt = 12, None
    while pos + 8 <= len(wav):
        name, length = struct.unpack_from("<4sI", wav, pos)
        chunk = wav[pos + 8 : pos + 8 + length]
        assert len(chunk) == length, "Truncated WAV"
        if name == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", chunk)
        if name == b"data":
            assert fmt and fmt[0] == 3 and fmt[1] == 1 and fmt[5] == 32, (
                "Expected mono float32"
            )
            assert length > 0 and length % 4 == 0
            assert all(math.isfinite(v[0]) for v in struct.iter_unpack("<f", chunk)), (
                "Nonfinite audio"
            )
            return fmt[2], chunk
        pos += 8 + length + length % 2
    raise ValueError("No audio data")


def wav_header(size: int, rate: int) -> bytes:
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        size + 36,
        b"WAVE",
        b"fmt ",
        16,
        3,
        1,
        rate,
        rate * 4,
        4,
        32,
        b"data",
        size,
    )


def prepare(
    state: Path,
    directory: Path,
    cast_path: str | Path,
    chapter_ids: Sequence[str] | None = None,
    presentation_path: str | Path | None = None,
    reuse_root: str | Path | None = None,
) -> None:
    cast = read(cast_path)
    presentation = read(presentation_path) if presentation_path else {}
    assert cast["model"] in {"qwen-base", "chatterbox", "breeze-tts-2"}
    index = read(state / "index.json")
    chapters = []
    entries = sorted(index["chapters"], key=lambda e: e["sequence"])
    if chapter_ids is None:
        entries = entries[:5]
    else:
        if not chapter_ids or len(chapter_ids) != len(set(chapter_ids)):
            raise ValueError("Choose distinct explicit chapter IDs")
        missing = set(chapter_ids) - {e["id"] for e in entries}
        if missing:
            raise ValueError("Unknown chapter IDs: " + ", ".join(sorted(missing)))
        entries = [e for e in entries if e["id"] in chapter_ids]
    for entry in entries:
        head = read(state / "heads" / (entry["id"] + ".json"))
        assert head["source"] == entry["current"], "Stale reviewed analysis"
        source = read(state / "sources" / (head["source"] + ".json"))
        analysis = read(state / "analyses" / (head["analysis"] + ".json"))
        chapters.append(
            {
                "chapterId": entry["id"],
                "sequence": entry["sequence"],
                "title": source["title"],
                "source": head["source"],
                "analysis": head["analysis"],
                "sourceSha256": source["contentHash"],
                "segments": plan_chapter({**source, "sequence": entry["sequence"]}, analysis, cast, presentation=presentation.get(entry["id"])),
            }
        )
    assert len(chapters) == (5 if chapter_ids is None else len(chapter_ids)), (
        "Selected reviewed chapters required"
    )
    plan = {
        "schemaVersion": 1,
        "fictionId": index["fictionId"],
        "policy": {"model": cast["model"], "joinPauseMs": 120},
        "cast": cast,
        "chapters": chapters,
    }
    path = directory / "plan.json"
    if path.exists() and read(path) != plan:
        raise ValueError("Existing batch plan differs; choose a new batch directory")
    save(path, plan)
    if reuse_root:
        for chapter in chapters:
            for old in Path(reuse_root).glob("*/" + chapter["chapterId"] + "/segments"):
                for segment in chapter["segments"]:
                    key = segment["fingerprint"]
                    target = directory / "segments" / key
                    source_folder = old / key
                    if not target.exists() and (source_folder / "receipt.json").exists() and (source_folder / "audio.wav").exists():
                        # render() verifies request, checksum and WAV before reuse.
                        shutil.copytree(source_folder, target)
    print(
        json.dumps(
            {
                "chapters": len(chapters),
                "segments": sum(len(c["segments"]) for c in chapters),
                "plan": digest(plan),
            }
        )
    )


def punctuation_only(text: str) -> bool:
    """Structural punctuation has no spoken content; symbols and emoji still do."""
    return bool(text) and all(
        char.isspace() or unicodedata.category(char).startswith("P") for char in text
    )


def render(directory: Path, api: BookAPI) -> None:
    plan = read(directory / "plan.json")
    assert plan["cast"]["model"] in {"qwen-base", "chatterbox"}
    model_id = plan["cast"]["model"]
    health = api.call("/health")
    if (health["active"] or health["queued"]) and not os.environ.get("MAC_TTS_LEASE"):
        raise RuntimeError("Mac API is busy; leave the other job intact")
    catalog = api.call("/v1/models")
    models = catalog if isinstance(catalog, list) else catalog["models"]
    model = next(m for m in models if m["id"] == model_id)
    assert model["revision"] == plan["cast"]["revision"], "Model revision changed"
    for voice in plan["cast"]["voices"].values():
        assert (
            digest(api.call("/v1/references/" + voice["reference_id"], raw=True))
            == voice["sha256"]
        ), "Reference changed"
    save(
        directory / "runtime.json",
        {"health": health, "model": model, "plan": digest(plan)},
    )
    total = sum(len(c["segments"]) for c in plan["chapters"])
    done = 0
    api.wait(api.call("/v1/switch", {"model": model_id}))
    try:
        for chapter in plan["chapters"]:
            for i, segment in enumerate(chapter["segments"]):
                if (directory / "cancel.requested").exists():
                    raise RuntimeError(
                        "Cancelled at a passage boundary; completed audio is retained"
                    )
                key = segment["fingerprint"]
                folder = directory / "segments" / key
                folder.mkdir(parents=True, exist_ok=True)
                receipt_path = folder / "receipt.json"
                if receipt_path.exists():
                    receipt = read(receipt_path)
                    assert (
                        receipt["request"] == segment["request"]
                        and receipt["fingerprint"] == key
                    )
                    assert (
                        digest((folder / "audio.wav").read_bytes())
                        == receipt["wav_sha256"]
                    ), "Cached WAV changed"
                elif punctuation_only(segment["text"]):
                    # Keep source offsets and the immutable plan intact. A standalone
                    # bracket is a short pause, not an empty model generation.
                    rate = 24000
                    wav = wav_header(2400 * 4, rate) + bytes(2400 * 4)
                    (folder / "audio.wav.pending").write_bytes(wav)
                    os.replace(folder / "audio.wav.pending", folder / "audio.wav")
                    save(receipt_path, {
                        "fingerprint": key, "request": segment["request"],
                        "wav_sha256": digest(wav), "duration": 0.1,
                        "sample_rate": rate, "provider_credits": 0,
                        "rendering": "punctuation-only-pause-v1",
                    })
                else:
                    pending = folder / "pending.json"
                    if pending.exists():
                        saved = read(pending)
                        assert saved["request"] == segment["request"]
                        try:
                            job = api.call("/v1/jobs/" + saved["job"]["id"])
                        except urllib.error.HTTPError as error:
                            if error.code != 404:
                                raise
                            # A controller restart loses its registry. Preserve the old
                            # receipt before submitting another free local attempt.
                            save(
                                folder / ("expired-" + saved["job"]["id"] + ".json"),
                                saved,
                            )
                            job = api.call(
                                "/v1/jobs",
                                {"model": model_id, "input": segment["request"]},
                            )
                            save(pending, {"job": job, "request": segment["request"]})
                    else:
                        job = api.call(
                            "/v1/jobs", {"model": model_id, "input": segment["request"]}
                        )
                        save(pending, {"job": job, "request": segment["request"]})
                    job = api.wait(job)
                    wav = api.call("/v1/jobs/" + job["id"] + "/audio", raw=True)
                    rate, data = wav_data(wav)
                    duration = len(data) / 4 / rate
                    assert (
                        max(0.1, len(segment["text"].strip()) / 100)
                        <= duration
                        <= max(30, len(segment["text"]) * 2)
                    ), "Duration outside bounds"
                    (folder / "audio.wav.pending").write_bytes(wav)
                    os.replace(folder / "audio.wav.pending", folder / "audio.wav")
                    save(
                        receipt_path,
                        {
                            "fingerprint": key,
                            "request": segment["request"],
                            "wav_sha256": digest(wav),
                            "job": job,
                            "duration": duration,
                            "sample_rate": rate,
                            "provider_credits": 0,
                        },
                    )
                done += 1
                progress = {
                    "phase": "rendering",
                    "chapter": chapter["sequence"],
                    "segment": i + 1,
                    "completed": done,
                    "total": total,
                    "updated": time.time(),
                    "provider_credits": 0,
                }
                save(directory / "progress.json", progress)
                print(json.dumps(progress), flush=True)
        save(
            directory / "progress.json",
            {
                "phase": "rendered",
                "completed": done,
                "total": total,
                "updated": time.time(),
            },
        )
    finally:
        api.call("/v1/stop", {})


def assemble(state: Path, directory: Path, batch: str) -> None:
    plan = read(directory / "plan.json")
    plan_key = digest(plan)
    assert read(directory / "runtime.json")["plan"] == plan_key, (
        "Plan changed after rendering"
    )
    save(state / "plans" / (plan_key + ".json"), plan)
    deliveries = []
    for chapter in plan["chapters"]:
        receipts = [
            read(directory / "segments" / s["fingerprint"] / "receipt.json")
            for s in chapter["segments"]
        ]
        key = digest(
            {
                "plan": plan_key,
                "chapter": chapter["chapterId"],
                "wavs": [r["wav_sha256"] for r in receipts],
                "assembler": 1,
            }
        )
        folder = state / "assemblies" / key
        if (folder / "metadata.json").exists():
            assert (
                digest((folder / "chapter.mp3").read_bytes())
                == read(folder / "metadata.json")["checksum"]
            )
            deliveries.append({"sequence": chapter["sequence"], "assembly": key})
            continue
        folder.mkdir(parents=True, exist_ok=True)
        timeline, frames, rate = [], 0, 24000
        wav_path = folder / "chapter.wav"
        with open(wav_path, "wb") as f:
            f.write(wav_header(0, rate))
            for i, (segment, receipt) in enumerate(zip(chapter["segments"], receipts)):
                wav = (
                    directory / "segments" / segment["fingerprint"] / "audio.wav"
                ).read_bytes()
                assert (
                    receipt["request"] == segment["request"]
                    and receipt["fingerprint"] == segment["fingerprint"]
                ), "Stale request receipt"
                assert digest(wav) == receipt["wav_sha256"]
                actual_rate, data = wav_data(wav)
                assert actual_rate == rate
                start = frames / rate
                f.write(data)
                frames += len(data) // 4
                timeline.append(
                    {
                        "segmentId": segment["uid"],
                        "asset": segment["fingerprint"],
                        "start": start,
                        "end": frames / rate,
                        "spans": segment["spans"],
                        **({"sectionKind": "author-note"} if segment.get("sectionKind") == "author-note" else {}),
                        **({"presentation": {"kind": segment["presentation"], "text": segment["text"], "speaker": segment["role"]}} if "presentation" in segment else {}),
                    }
                )
                if i + 1 < len(receipts):
                    gap = round(rate * plan["policy"]["joinPauseMs"] / 1000)
                    f.write(bytes(gap * 4))
                    frames += gap
            f.seek(0)
            f.write(wav_header(frames * 4, rate))
        # Containers use their pinned ffmpeg directly. The NAS helper retains its
        # established Docker fallback without giving the production worker a socket.
        native = shutil.which("ffmpeg") and shutil.which("ffprobe")
        prefix = (
            []
            if native
            else [
                "sudo",
                "-n",
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                "-v",
                str(folder) + ":/audio",
                "--entrypoint",
            ]
        )
        source = str(folder / "chapter.wav") if native else "/audio/chapter.wav"
        output = str(folder / "chapter.mp3") if native else "/audio/chapter.mp3"
        command = (
            ["ffmpeg"]
            if native
            else prefix + ["ffmpeg", "audiobook-system:local"]
        )
        subprocess.run(
            command
            + [
                "-v",
                "error",
                "-y",
                "-i",
                source,
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                output,
            ],
            check=True,
        )
        command = (
            ["ffprobe"]
            if native
            else prefix + ["ffprobe", "audiobook-system:local"]
        )
        probe = subprocess.check_output(
            command
            + [
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                output,
            ],
            text=True,
        )
        assert (
            abs(float(json.loads(probe)["format"]["duration"]) - frames / rate) < 0.15
        ), "Encoded chapter duration mismatch"
        metadata = {
            "schemaVersion": 1,
            "id": key,
            "chapterId": chapter["chapterId"],
            "sequence": chapter["sequence"],
            "source": chapter["source"],
            "analysis": chapter["analysis"],
            "plan": plan_key,
            "checksum": digest((folder / "chapter.mp3").read_bytes()),
            "duration": frames / rate,
            "timeline": timeline,
        }
        if "quality" in plan:
            metadata["quality"] = plan["quality"]
        save(folder / "metadata.json", metadata)
        deliveries.append({"sequence": chapter["sequence"], "assembly": key})
    save(
        state / "deliveries" / batch / "manifest.json",
        {"chapters": deliveries, "localPlan": plan_key},
    )
    save(
        directory / "delivery.json",
        {"batch": batch, "chapters": deliveries, "localPlan": plan_key},
    )
    print(json.dumps({"batch": batch, "chapters": len(deliveries)}))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["prepare", "render", "assemble"])
    p.add_argument("--state", required=True)
    p.add_argument("--directory", required=True)
    p.add_argument("--cast")
    p.add_argument("--presentation")
    p.add_argument("--reuse-root")
    p.add_argument(
        "--chapters",
        nargs="+",
        help="Explicit chapter IDs in story order; default first five",
    )
    p.add_argument("--batch", default="local-qwen-five")
    p.add_argument("--credential", default="data/credentials/mac-client.json")
    a = p.parse_args()
    assert re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}", a.batch)
    directory = Path(a.directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(directory / "render.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if a.command == "prepare":
            prepare(Path(a.state), directory, a.cast, a.chapters, a.presentation, a.reuse_root)
        elif a.command == "render":
            render(directory, API(a.credential))
        else:
            assemble(Path(a.state), directory, a.batch)


if __name__ == "__main__":
    main()
