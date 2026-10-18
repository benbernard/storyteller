#!/usr/bin/env python3
"""Check new Breeze chapter passages, retaining audio-bound ASR evidence."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from render_chapter import digest, save


def main() -> None:
    if not os.environ.get("AUDITION_LEASE_OWNER"):
        raise SystemExit("Use generate.py with --model chapter-review")
    import mlx.core as mx
    import mlx_whisper
    from huggingface_hub import snapshot_download
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from review_local_book import align, tokens

    mx.set_memory_limit(3 * 1024**3)
    mx.set_cache_limit(128 * 1024**2)
    model = snapshot_download("mlx-community/whisper-small-mlx", revision="45f3915923c7a79a5a5b5a7d909d39aeb0e5630e", local_files_only=True)
    root = Path(sys.argv[1])
    reports = root / "review"
    reports.mkdir(exist_ok=True)
    flagged = []
    for path in sorted((root / "segments").glob("*.json")):
        receipt = json.loads(path.read_text())
        if receipt["model"] != "breeze-tts-2":
            continue
        audio = path.with_suffix(".wav")
        if digest(audio) != receipt["sha256"]:
            raise ValueError("Audio changed after generation")
        output = reports / path.name
        report = json.loads(output.read_text()) if output.exists() else None
        if not report or report["receiptSha256"] != digest(path):
            result = mlx_whisper.transcribe(str(audio), path_or_hf_repo=model, language="en",
                verbose=None, temperature=0.0, condition_on_previous_text=False)
            expected, recognized = tokens(receipt["text"]), tokens(result["text"])
            edits = align(expected, recognized)
            errors = sum(op != "equal" for op, _, _ in edits)
            # Flags are inspection requests, never automatic proof of a defect.
            ratio = errors / max(1, len(expected))
            tail = expected[-3:]
            ending = not tail or tail == recognized[-len(tail):]
            report = {"receiptSha256": digest(path), "audioSha256": receipt["sha256"],
                "text": receipt["text"], "transcript": result["text"].strip(),
                "wordErrorRate": ratio, "endingMatches": ending,
                "needsInspection": ratio > 0.2 or not ending,
                "reviewer": "whisper-small-mlx@45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"}
            save(output, report)
        if report["needsInspection"]:
            flagged.append(path.stem)
        print(path.stem, report["transcript"], flush=True)
    save(root / "review-status.json", {"flagged": flagged, "limitation": "ASR does not establish acting quality or voice consistency"})


if __name__ == "__main__":
    main()
