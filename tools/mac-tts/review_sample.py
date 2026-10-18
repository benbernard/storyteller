#!/usr/bin/env python3
"""Retain independent ASR evidence for the three public sample assemblies."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import threading
import urllib.request
import uuid

from review_local_book import analyze

MODEL = "mlx-community/whisper-large-v3-turbo"
REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("data/sample"))
    parser.add_argument("--credential", type=Path, required=True)
    parser.add_argument("--text", type=Path, default=Path("samples/maltese-falcon/excerpt.txt"))
    args = parser.parse_args()
    os.environ.setdefault("HF_HOME", str(Path(os.environ.get("MAC_TTS_HOME", "data/mac-tts")) / "cache/huggingface"))
    credential = json.loads(args.credential.read_text())
    owner = str(uuid.uuid4())

    def call(path: str, payload: dict[str, str | int] | None = None) -> dict[str, object]:
        request = urllib.request.Request(credential["endpoint"] + path,
            data=json.dumps(payload).encode() if payload is not None else None, headers={"Authorization": "Bearer " + credential["token"],
            "Content-Type": "application/json", "X-Worker-Lease": owner})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    call("/v1/lease", {"owner": owner, "seconds": 120})
    stop = threading.Event()
    failures: list[str] = []

    def renew() -> None:
        while not stop.wait(30):
            try:
                call("/v1/lease", {"owner": owner, "seconds": 120})
            except Exception:
                failures.append("GPU lease renewal failed")
                return

    thread = threading.Thread(target=renew, daemon=True)
    thread.start()
    try:
        status = call("/v1/status")
        if status.get("active") or status.get("queued"):
            raise RuntimeError("Other production work is active")
        call("/v1/stop", {})
        import mlx.core as mx
        import mlx_whisper
        from huggingface_hub import snapshot_download

        mx.set_memory_limit(6 * 1024**3)
        mx.set_cache_limit(128 * 1024**2)
        model = snapshot_download(MODEL, revision=REVISION, local_files_only=True)
        text = args.text.read_text()
        for provider in ("breeze", "qwen", "inworld"):
            root = args.directory / provider
            state = root / "state"
            manifest = json.loads((state / "deliveries/public-sample/manifest.json").read_text())
            assembly = state / "assemblies" / manifest["chapters"][0]["assembly"]
            audio = assembly / "chapter.mp3"
            audio_hash = hashlib.sha256(audio.read_bytes()).hexdigest()
            metadata = json.loads((assembly / "metadata.json").read_text())
            if audio_hash != metadata["checksum"]:
                raise ValueError("Assembly checksum mismatch")
            output = root / "sample-review.json"
            if output.exists():
                prior = json.loads(output.read_text())
                if prior.get("audioSha256") == audio_hash and prior.get("sourceSha256") == hashlib.sha256(text.encode()).hexdigest() and prior.get("revision") == REVISION:
                    print(provider, "reused bound review", flush=True)
                    continue
                raise ValueError("Review inputs changed; archive the previous evidence before rerunning")
            # No expected-source prompt: the recognizer must hear the recording independently.
            result = mlx_whisper.transcribe(str(audio), path_or_hf_repo=model, language="en", verbose=None,
                temperature=0.0, condition_on_previous_text=False, word_timestamps=True)
            if failures:
                raise RuntimeError(failures[0])
            report = {"provider": provider, "audioSha256": audio_hash,
                "sourceSha256": hashlib.sha256(text.encode()).hexdigest(), "model": MODEL, "revision": REVISION,
                "assessment": analyze(text, result),
                "limitation": "Automated transcript evidence only; no human listening or acting-quality rating is claimed."}
            output.write_text(json.dumps(report, indent=2) + "\n")
            print(provider, result["text"], flush=True)
    finally:
        stop.set()
        thread.join(timeout=35)
        call("/v1/lease/release", {"owner": owner})


if __name__ == "__main__":
    main()
