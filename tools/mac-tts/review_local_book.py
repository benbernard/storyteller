#!/usr/bin/env python3
"""Read-only local audiobook ASR. Never calls or manages the TTS API.
Only remote mutations are JSON files beneath the batch's review/ directory.
"""

from __future__ import annotations

import argparse
import collections
import contextlib
import fcntl
import gc
import importlib
import json
import os
import re
import shlex
import signal
import subprocess
import time
from pathlib import Path
from local_book import digest, read, save, wav_data

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections import Counter
    from types import FrameType
    from tts_typing import JsonObject
    from collections.abc import Sequence

MODEL = "mlx-community/whisper-small-mlx"
REVISION = "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"
REVIEW_VERSION = 1
LIMITATION = "Local ASR is fallible, especially for names, short speech and expressive delivery. Flags request inspection; they do not establish an audio defect."


def tokens(text: str) -> list[str]:
    return [
        m.group().replace("’", "'")
        for m in re.finditer(r"[^\W_]+(?:['’][^\W_]+)*", text.casefold())
    ]


def align(
    expected: Sequence[str], recognized: Sequence[str]
) -> list[tuple[str, int, int]]:
    """Minimum unit-cost word edits, with stable indices for source/timing review."""
    n, m = len(expected), len(recognized)
    if n * m > 2_000_000:
        raise ValueError("ASR alignment exceeds bounded token matrix")
    costs = [list(range(m + 1))]
    for i in range(1, n + 1):
        row = [i]
        for j in range(1, m + 1):
            row.append(
                min(
                    costs[i - 1][j - 1] + (expected[i - 1] != recognized[j - 1]),
                    costs[i - 1][j] + 1,
                    row[j - 1] + 1,
                )
            )
        costs.append(row)
    edits = []
    i = n
    j = m
    while i or j:
        if (
            i
            and j
            and costs[i][j]
            == costs[i - 1][j - 1] + (expected[i - 1] != recognized[j - 1])
        ):
            edits.append(
                (
                    "equal" if expected[i - 1] == recognized[j - 1] else "replace",
                    i - 1,
                    j - 1,
                )
            )
            i -= 1
            j -= 1
        elif i and costs[i][j] == costs[i - 1][j] + 1:
            edits.append(("delete", i - 1, j))
            i -= 1
        else:
            edits.append(("insert", i, j - 1))
            j -= 1
    return list(reversed(edits))


def analyze(text: str, asr: JsonObject) -> JsonObject:
    expected = tokens(text)
    timed = []
    for segment in asr.get("segments", []):
        for word in segment.get("words", []):
            timed.extend(
                {
                    "word": w,
                    "start": word["start"],
                    "end": word["end"],
                    "probability": word.get("probability"),
                }
                for w in tokens(word["word"])
            )
    recognized = [w["word"] for w in timed]
    if not timed and tokens(asr.get("text", "")):
        timed = [
            {"word": w, "start": None, "end": None, "probability": None}
            for w in tokens(asr["text"])
        ]
        recognized = [w["word"] for w in timed]
    edits = align(expected, recognized)
    counts = collections.Counter(op for op, _, _ in edits)
    matched = {i for op, i, _ in edits if op == "equal"}
    tail = list(range(max(0, len(expected) - 6), len(expected)))
    tail_coverage = sum(i in matched for i in tail) / len(tail) if tail else 1.0
    ending_exact = bool(expected) and recognized[-len(tail) :] == expected[-len(tail) :]

    def grams(items: Sequence[str]) -> Counter[tuple[str, ...]]:
        return collections.Counter(
            tuple(items[i : i + 3]) for i in range(max(0, len(items) - 2))
        )

    observed, source = grams(recognized), grams(expected)
    repeats = [
        {"words": list(k), "recognized_count": v, "source_count": source[k]}
        for k, v in observed.items()
        if v >= 3 and v > source[k] + 1
    ]
    alignment = []
    for op, i, j in edits:
        point = timed[j] if j < len(timed) else (timed[-1] if timed else {})
        alignment.append(
            {
                "operation": op,
                "source_word_index": i if op != "insert" else None,
                "asr_word_index": j if op != "delete" else None,
                "expected": expected[i]
                if i < len(expected) and op != "insert"
                else None,
                "recognized": recognized[j]
                if j < len(recognized) and op != "delete"
                else None,
                "start_seconds": point.get("start"),
                "end_seconds": point.get("end"),
                "timing_note": "Neighbor boundary only" if op == "delete" else None,
            }
        )
    flags = []
    if counts["delete"]:
        flags.append("possible_omission")
    if counts["replace"]:
        flags.append("word_mismatch_or_asr_uncertainty")
    if counts["insert"]:
        flags.append("possible_extra_words")
    if not ending_exact:
        flags.append("ending_needs_review")
    if repeats:
        flags.append("possible_repetition")
    recall = counts["equal"] / len(expected) if expected else 1.0
    priority = (
        "high"
        if recall < 0.8 or tail_coverage < 0.67 or repeats
        else "inspect"
        if flags
        else "no_asr_flags"
    )
    return {
        "normalization": "Unicode casefold; punctuation excluded; apostrophes retained within words",
        "source_word_count": len(expected),
        "recognized_word_count": len(recognized),
        "matched_words": counts["equal"],
        "word_recall": recall,
        "word_precision": counts["equal"] / max(1, len(recognized)),
        "word_error_rate": (counts["replace"] + counts["insert"] + counts["delete"])
        / max(1, len(expected)),
        "insertions": counts["insert"],
        "deletions": counts["delete"],
        "substitutions": counts["replace"],
        "ending_words_checked": len(tail),
        "ending_coverage": tail_coverage,
        "ending_exact": ending_exact,
        "normalized_transcript_match": expected == recognized,
        "repetitions": repeats,
        "flags": flags,
        "priority": priority,
        "alignment": alignment,
        "recognized_text": asr.get("text", ""),
        "asr": asr,
        "uncertainty_reasons": (["short_utterance"] if len(expected) < 4 else [])
        + (
            ["low_asr_word_probability"]
            if any(
                w.get("probability") is not None and w["probability"] < 0.5
                for w in timed
            )
            else []
        ),
        "limitation": LIMITATION,
    }


def validate_segment(
    plan: JsonObject,
    chapter: JsonObject,
    segment: JsonObject,
    receipt: JsonObject,
    wav: bytes,
) -> tuple[int, bytes, float]:
    voice = plan["cast"]["voices"][segment["role"]]
    if segment["uid"] != digest(
        {
            "chapter": chapter["chapterId"],
            "spans": segment["spans"],
            "asset": segment["fingerprint"],
        }
    ):
        raise ValueError("Segment/source identity hash mismatch")
    expected = digest(
        {
            "request": segment["request"],
            "reference_sha256": voice["sha256"],
            "model": plan["cast"]["model"],
            "revision": plan["cast"]["revision"],
        }
    )
    if (
        expected != segment["fingerprint"]
        or receipt["fingerprint"] != expected
        or receipt["request"] != segment["request"]
    ):
        raise ValueError("Receipt/plan request or fingerprint mismatch")
    if segment["request"]["text"] != segment["text"]:
        raise ValueError("Segment text differs from inference request")
    if receipt["wav_sha256"] != digest(wav):
        raise ValueError("WAV differs from completed receipt hash")
    job = receipt["job"]
    if job["state"] != "succeeded" or job["model"] != plan["cast"]["model"]:
        raise ValueError("Receipt job not successful for planned model")
    rate, data = wav_data(wav)
    duration = len(data) / 4 / rate
    if rate != receipt["sample_rate"] or abs(duration - receipt["duration"]) > 1 / rate:
        raise ValueError("Receipt audio format/duration mismatch")
    return rate, data, duration


def cache_key(wav_hash: str, text: str, receipt: JsonObject, plan_identity: str) -> str:
    return digest(
        {
            "wav": wav_hash,
            "text": digest(text.encode()),
            "receipt": digest(receipt),
            "plan_identity": plan_identity,
            "asr_model": MODEL,
            "asr_revision": REVISION,
            "review_version": REVIEW_VERSION,
        }
    )


class Reviewer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.root = Path(args.local)
        self.inputs = self.root / "input"
        self.output = self.root / "review"
        self.stop = False
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.output.mkdir(exist_ok=True, mode=0o700)
        self.inputs.mkdir(exist_ok=True, mode=0o700)
        self.model_path = None
        self.imported = False
        self.source_commit = args.source_commit

    def command(self, args: Sequence[str | Path]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args, check=True, capture_output=True, text=True, timeout=120
        )

    def sync_inputs(self) -> None:
        filters = [
            "/plan.json",
            "/cast.json",
            "/references/",
            "/references/*/",
            "/references/*/reference.wav",
            "/references/*/voice.json",
            "/segments/",
            "/segments/*/",
            "/segments/*/audio.wav",
            "/segments/*/receipt.json",
        ]
        self.command(
            [
                "rsync",
                "-a",
                "--checksum",
                *[f"--include={f}" for f in filters],
                "--exclude=*",
                f"{self.args.nas}:{shlex.quote(self.args.remote.rstrip('/') + '/')}",
                str(self.inputs) + "/",
            ]
        )

    def export(self) -> None:
        target = self.args.remote.rstrip("/") + "/review"
        self.command(["ssh", self.args.nas, "mkdir -p " + shlex.quote(target)])
        self.command(
            [
                "rsync",
                "-a",
                "--checksum",
                "--include=*/",
                "--include=*.json",
                "--exclude=*",
                str(self.output) + "/",
                f"{self.args.nas}:{shlex.quote(target + '/')}",
            ]
        )

    def memory_free(self) -> int | None:
        if not Path("/usr/bin/memory_pressure").exists():
            return None
        p = subprocess.run(
            ["/usr/bin/memory_pressure", "-Q"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        m = re.search(r"free percentage:\s*(\d+)%", p.stdout)
        return int(m[1]) if m else None

    def release(self) -> None:
        if self.imported:
            holder = importlib.import_module("mlx_whisper.transcribe").ModelHolder
            holder.model = None
            holder.model_path = None
            gc.collect()
            import mlx.core as mx

            mx.clear_cache()

    def transcribe(self, wav: bytes) -> tuple[JsonObject, JsonObject]:
        free = self.memory_free()
        if free is not None and free < self.args.min_free_percent:
            self.release()
            raise MemoryError("Paused ASR for system memory pressure")
        import numpy as np
        import mlx.core as mx
        import mlx_whisper
        from scipy.signal import resample_poly
        from huggingface_hub import snapshot_download

        self.imported = True
        mx.set_memory_limit(3 * 1024**3)
        mx.set_cache_limit(128 * 1024**2)
        if self.model_path is None:
            self.model_path = snapshot_download(
                MODEL, revision=REVISION, local_files_only=True
            )
        rate, data, duration = self.audio(wav)
        audio = np.frombuffer(data, dtype="<f4").copy()
        stats = {
            "duration_seconds": duration,
            "sample_rate": rate,
            "peak_amplitude": float(np.max(np.abs(audio))),
            "rms_amplitude": float(np.sqrt(np.mean(audio**2))),
            "samples_at_or_above_full_scale": int(np.sum(np.abs(audio) >= 1.0)),
        }
        if rate != 16000:
            audio = resample_poly(audio, 16000, rate)
        started = time.monotonic()
        mx.reset_peak_memory()
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_path,
            language="en",
            verbose=None,
            word_timestamps=True,
            temperature=0.0,
            condition_on_previous_text=False,
        )
        stats.update(
            asr_seconds=time.monotonic() - started,
            asr_metal_peak_bytes=mx.get_peak_memory(),
            system_free_percent_before=free,
        )
        return result, stats

    @staticmethod
    def audio(wav: bytes) -> tuple[int, bytes, float]:
        rate, data = wav_data(wav)
        return rate, data, len(data) / 4 / rate

    def report(
        self, wav: bytes, text: str, metadata: JsonObject, key: str
    ) -> JsonObject:
        asr, stats = self.transcribe(wav)
        analysis = analyze(text, asr)
        if stats["samples_at_or_above_full_scale"]:
            analysis["flags"].append("possible_clipping")
        if stats["rms_amplitude"] < 0.0001:
            analysis["flags"].append("near_silence")
            analysis["priority"] = "high"
        return {
            "schema_version": 1,
            "review_status": "complete",
            "review_version": REVIEW_VERSION,
            "review_key": key,
            "reviewer_source_commit": self.source_commit,
            "asr_model": MODEL,
            "asr_revision": REVISION,
            "wav_sha256": digest(wav),
            "source_text_sha256": digest(text.encode()),
            "reviewed_at": time.time(),
            **metadata,
            "audio": stats,
            **analysis,
        }

    def references(self, plan: JsonObject) -> list[JsonObject]:
        summaries = []
        voices = plan["cast"]["voices"]
        for role, voice in sorted(
            voices.items(), key=lambda kv: ("request" not in kv[1], kv[0])
        ):
            folder = self.inputs / "references" / role
            wav = (folder / "reference.wav").read_bytes()
            receipt = read(folder / "voice.json")
            path = self.output / "references" / (role + ".json")
            try:
                if (
                    digest(wav) != voice["sha256"]
                    or receipt["sha256"] != voice["sha256"]
                    or receipt["reference_id"] != voice["reference_id"]
                    or receipt["transcript"] != voice["transcript"]
                ):
                    raise ValueError("Reference WAV/voice receipt/cast mismatch")
                key = cache_key(
                    digest(wav), voice["transcript"], receipt, digest(voice)
                )
                cached = read(path) if path.exists() else None
                if (
                    not cached
                    or cached.get("review_key") != key
                    or cached.get("review_status") != "complete"
                ):
                    cached = self.report(
                        wav,
                        voice["transcript"],
                        {
                            "kind": "reference",
                            "role": role,
                            "reference_id": voice["reference_id"],
                            "newly_designed": "request" in voice,
                            "declared_transcript": voice["transcript"],
                        },
                        key,
                    )
                    save(path, cached)
                summaries.append(
                    {
                        k: cached[k]
                        for k in [
                            "role",
                            "reference_id",
                            "newly_designed",
                            "wav_sha256",
                            "normalized_transcript_match",
                            "word_recall",
                            "ending_coverage",
                            "flags",
                            "priority",
                        ]
                    }
                )
            except MemoryError:
                raise
            except Exception as e:
                save(
                    path,
                    {
                        "review_status": "invalid_input",
                        "role": role,
                        "updated": time.time(),
                        "validation_error": type(e).__name__ + ": " + str(e),
                    },
                )
                summaries.append(
                    {
                        "role": role,
                        "newly_designed": "request" in voice,
                        "validation_error": type(e).__name__ + ": " + str(e),
                    }
                )
        save(
            self.output / "reference-review.json",
            {
                "source_commit": self.source_commit,
                "updated": time.time(),
                "complete": len(summaries) == len(voices),
                "references": summaries,
                "new_supporting_count": sum("request" in v for v in voices.values()),
                "limitation": LIMITATION,
            },
        )
        self.export()
        return summaries

    def cycle(self) -> bool:
        self.sync_inputs()
        plan = read(self.inputs / "plan.json")
        cast = read(self.inputs / "cast.json")
        if plan["cast"] != cast:
            raise ValueError("Plan cast differs from cast.json")
        plan_key = digest(plan)
        for chapter in plan["chapters"]:
            if (
                digest("".join(s["text"] for s in chapter["segments"]).encode())
                != chapter["sourceSha256"]
            ):
                raise ValueError("Plan chapter source hash mismatch")
        self.references(plan)
        total = sum(len(c["segments"]) for c in plan["chapters"])
        complete = reviewed = processed = 0
        errors = []
        summaries = []
        for chapter in plan["chapters"]:
            for index, segment in enumerate(chapter["segments"]):
                folder = self.inputs / "segments" / segment["fingerprint"]
                receipt_path = folder / "receipt.json"
                if not receipt_path.exists():
                    continue
                complete += 1
                path = self.output / "segments" / (segment["fingerprint"] + ".json")
                try:
                    receipt_bytes = receipt_path.read_bytes()
                    receipt = json.loads(receipt_bytes)
                    wav = (folder / "audio.wav").read_bytes()
                    validate_segment(plan, chapter, segment, receipt, wav)
                    identity = {
                        "chapter_id": chapter["chapterId"],
                        "source_id": chapter["source"],
                        "analysis_id": chapter["analysis"],
                        "source_sha256": chapter["sourceSha256"],
                        "segment_uid": segment["uid"],
                        "spans": segment["spans"],
                    }
                    key = cache_key(
                        receipt["wav_sha256"],
                        segment["text"],
                        receipt,
                        digest(identity),
                    )
                    report = read(path) if path.exists() else None
                    if (
                        not report
                        or report.get("review_key") != key
                        or report.get("review_status") != "complete"
                    ):
                        if processed >= self.args.batch_size or self.stop:
                            save(
                                path,
                                {
                                    "review_status": "pending",
                                    "wav_sha256": receipt["wav_sha256"],
                                    "expected_review_key": key,
                                    **identity,
                                },
                            )
                            continue
                        report = self.report(
                            wav,
                            segment["text"],
                            {
                                "kind": "segment",
                                "fingerprint": segment["fingerprint"],
                                "role": segment["role"],
                                "chapter_sequence": chapter["sequence"],
                                "segment_index": index,
                                "plan_sha256": plan_key,
                                **identity,
                                "receipt_sha256": digest(receipt),
                                "receipt_file_sha256": digest(
                                    receipt_path.read_bytes()
                                ),
                                "job_id": receipt["job"]["id"],
                            },
                            key,
                        )
                        save(path, report)
                        processed += 1
                    current_receipt_hash = digest(receipt_bytes)
                    if report.get("receipt_file_sha256") != current_receipt_hash:
                        report["receipt_file_sha256"] = current_receipt_hash
                        report["metadata_verified_source_commit"] = self.source_commit
                        save(path, report)
                    reviewed += 1
                    summaries.append(
                        {
                            k: report[k]
                            for k in [
                                "fingerprint",
                                "segment_uid",
                                "chapter_id",
                                "chapter_sequence",
                                "segment_index",
                                "role",
                                "wav_sha256",
                                "word_recall",
                                "ending_coverage",
                                "flags",
                                "priority",
                            ]
                        }
                    )
                except MemoryError:
                    raise
                except Exception as e:
                    error = {
                        "fingerprint": segment["fingerprint"],
                        "segment_uid": segment["uid"],
                        "chapter_id": chapter["chapterId"],
                        "error": type(e).__name__ + ": " + str(e),
                    }
                    errors.append(error)
                    save(
                        self.output
                        / "validation-errors"
                        / (segment["fingerprint"] + ".json"),
                        {
                            **error,
                            "updated": time.time(),
                            "source_commit": self.source_commit,
                        },
                    )
        status = {
            "phase": "complete"
            if reviewed == total
            else "reviewing"
            if processed
            else "waiting_for_completed_segments",
            "updated": time.time(),
            "reviewer_pid": os.getpid(),
            "reviewer_source_commit": self.source_commit,
            "plan_sha256": plan_key,
            "total_segments": total,
            "completed_receipts": complete,
            "reviewed_segments": reviewed,
            "processed_this_cycle": processed,
            "flagged_segments": sum(bool(r["flags"]) for r in summaries),
            "high_priority_segments": sum(r["priority"] == "high" for r in summaries),
            "validation_errors": errors,
            "memory_limit_bytes": 3 * 1024**3,
            "tts_api_actions": "none",
            "limitation": LIMITATION,
        }
        save(
            self.output / "segments-index.json",
            {
                "updated": time.time(),
                "source_commit": self.source_commit,
                "plan_sha256": plan_key,
                "segments": summaries,
            },
        )
        self.release()
        if self.args.speaker_python and not self.stop:
            free = self.memory_free()
            if free is None or free >= max(25, self.args.min_free_percent):
                try:
                    self.command(
                        [
                            self.args.speaker_python,
                            str(
                                Path(__file__).with_name(
                                    "review_local_book_speakers.py"
                                )
                            ),
                            "--local",
                            str(self.root),
                            "--source-commit",
                            self.source_commit,
                        ]
                    )
                except Exception as e:
                    status["speaker_review_error_type"] = type(e).__name__
        save(self.output / "status.json", status)
        self.export()
        print(
            json.dumps(
                {
                    k: status[k]
                    for k in [
                        "phase",
                        "completed_receipts",
                        "reviewed_segments",
                        "total_segments",
                        "flagged_segments",
                        "high_priority_segments",
                    ]
                }
            ),
            flush=True,
        )
        return reviewed == total


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--nas", required=True)
    p.add_argument("--remote", required=True)
    p.add_argument("--local", required=True)
    p.add_argument("--source-commit", required=True)
    p.add_argument("--speaker-python")
    p.add_argument("--poll-seconds", type=int, default=45)
    p.add_argument("--batch-size", type=int, default=12)
    p.add_argument("--min-free-percent", type=int, default=15)
    p.add_argument("--once", action="store_true")
    p.add_argument("--watch-after-complete", action="store_true")
    p.add_argument("--max-hours", type=float, default=24)
    p.add_argument("--references-only", action="store_true")
    a = p.parse_args()
    if (
        not re.fullmatch(r"[A-Za-z0-9_.@-]+", a.nas)
        or not a.remote.startswith("/")
        or ".." in Path(a.remote).parts
    ):
        raise SystemExit("Invalid trusted SSH host or absolute batch path")
    if not 10 <= a.poll_seconds <= 300 or not 1 <= a.batch_size <= 32:
        raise SystemExit("Polling/batch bounds exceeded")
    os.umask(0o077)
    os.nice(10)
    reviewer = Reviewer(a)
    lock = open(reviewer.root / "reviewer.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Reviewer already running for this local directory")

    def stop(_sig: int, _frame: FrameType | None) -> None:
        reviewer.stop = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    previous_exit = reviewer.root / "exit.json"
    if previous_exit.exists():
        history = reviewer.root / "history"
        history.mkdir(exist_ok=True)
        previous_exit.replace(
            history / ("exit-" + str(read(previous_exit)["pid"]) + ".json")
        )
    save(
        reviewer.root / "process.json",
        {
            "pid": os.getpid(),
            "source_commit": a.source_commit,
            "started": time.time(),
            "remote_review_directory": a.remote.rstrip("/") + "/review",
            "log_file": str(reviewer.root / "reviewer.log"),
            "mode": "read-only inputs; review JSON export only",
        },
    )
    failures = 0
    deadline = time.monotonic() + max(0.01, min(a.max_hours, 24)) * 3600
    while not reviewer.stop and time.monotonic() < deadline:
        try:
            if a.references_only:
                reviewer.sync_inputs()
                reviewer.references(read(reviewer.inputs / "plan.json"))
                reviewer.release()
                break
            done = reviewer.cycle()
            failures = 0
            if a.once or (done and not a.watch_after_complete):
                break
        except Exception as e:
            reviewer.release()
            failures += 1
            # Never echo subprocess command output or private text into progress/logs.
            kind = "memory_pressure" if isinstance(e, MemoryError) else type(e).__name__
            save(
                reviewer.output / "status.json",
                {
                    "phase": "paused_for_memory"
                    if kind == "memory_pressure"
                    else "retrying",
                    "error_type": kind,
                    "consecutive_failures": failures,
                    "reviewer_pid": os.getpid(),
                    "source_commit": a.source_commit,
                    "updated": time.time(),
                    "tts_api_actions": "none",
                },
            )
            with contextlib.suppress(Exception):
                reviewer.export()
            print(
                json.dumps(
                    {
                        "phase": "retrying",
                        "error_type": kind,
                        "consecutive_failures": failures,
                    }
                ),
                flush=True,
            )
            if a.once or a.references_only:
                raise
        end = time.monotonic() + a.poll_seconds
        while not reviewer.stop and time.monotonic() < end:
            time.sleep(min(1, end - time.monotonic()))
    reviewer.release()
    save(
        reviewer.root / "exit.json",
        {
            "pid": os.getpid(),
            "source_commit": a.source_commit,
            "finished": time.time(),
            "requested_stop": reviewer.stop,
        },
    )


if __name__ == "__main__":
    main()
