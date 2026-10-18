#!/usr/bin/env python3
"""Retain stronger, contextual ASR evidence without changing chapter approvals."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

from render_chapter import digest, save

MODEL = "mlx-community/whisper-large-v3-turbo"
REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"


def requested_indices(value: object) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and re.fullmatch(r"\d{4}", item) for item in value):
        raise ValueError("Context review requires four-digit passage indices")
    if len(value) != len(set(value)):
        raise ValueError("Duplicate context review index")
    return [str(item) for item in value]


def main() -> None:
    if not os.environ.get("AUDITION_LEASE_OWNER"):
        raise SystemExit("Use generate.py with --model chapter-context-review")
    import mlx.core as mx
    import mlx_whisper
    import numpy as np
    import numpy.typing as npt
    import soundfile as sf
    from huggingface_hub import snapshot_download

    mx.set_memory_limit(6 * 1024**3)
    mx.set_cache_limit(128 * 1024**2)
    model = snapshot_download(MODEL, revision=REVISION, local_files_only=True)
    root = Path(sys.argv[1])
    indices = requested_indices(json.loads((root / "context-review-request.json").read_text()))
    destination = root / "context-review-large"
    destination.mkdir(exist_ok=True)
    for index in indices:
        if not (root / "segments" / (index + ".json")).exists():
            raise ValueError("Requested passage has no receipt")
        inputs: list[dict[str, str]] = []
        clips: list[npt.NDArray[np.float32]] = []
        for neighbor in range(max(0, int(index) - 1), int(index) + 2):
            name = f"{neighbor:04d}"
            receipt_path = root / "segments" / (name + ".json")
            if not receipt_path.exists():
                continue
            receipt: dict[str, object] = json.loads(receipt_path.read_text())
            audio_path = receipt_path.with_suffix(".wav")
            audio_hash = digest(audio_path)
            if audio_hash != receipt.get("sha256") or not isinstance(receipt.get("text"), str):
                raise ValueError("Context audio does not match receipt")
            inputs.append({"index": name, "receiptSha256": digest(receipt_path), "audioSha256": audio_hash,
                           "text": str(receipt["text"])})
            audio, rate = sf.read(audio_path, dtype="float32")
            if rate != 24000 or audio.ndim != 1:
                raise ValueError("Expected mono 24 kHz context audio")
            clips.append(audio)
        output = destination / (index + ".json")
        if output.exists():
            prior: dict[str, object] = json.loads(output.read_text())
            if prior.get("inputs") == inputs and prior.get("revision") == REVISION:
                continue
            history = destination / "history"
            history.mkdir(exist_ok=True)
            output.rename(history / (index + "-" + digest(output) + ".json"))
        # No source prompt: recognition must not be coerced toward expected words.
        context_audio = destination / (index + ".wav")
        sf.write(context_audio, np.concatenate(clips), 24000, subtype="FLOAT")
        result = mlx_whisper.transcribe(str(context_audio), path_or_hf_repo=model, language="en",
                                        verbose=None, temperature=0.0, condition_on_previous_text=False)
        transcript: object = result["text"]
        if not isinstance(transcript, str):
            raise ValueError("ASR did not return a transcript")
        save(output, {"requestedIndex": index, "inputs": inputs, "contextAudioSha256": digest(context_audio), "model": MODEL, "revision": REVISION,
                      "transcript": transcript.strip(),
                      "limitation": "Contextual ASR is evidence for review, not automatic approval or an acting assessment."})
        print(index, transcript.strip(), flush=True)


if __name__ == "__main__":
    main()
