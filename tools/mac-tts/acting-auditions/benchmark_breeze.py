"""Benchmark cached Breeze on exact saved chapter passages under the GPU lease."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def main() -> None:
    if not os.environ.get("AUDITION_LEASE_OWNER"):
        raise SystemExit("Use generate.py with the exclusive GPU lease")
    import mlx.core as mx
    import mlx.nn as nn
    import numpy as np
    import soundfile as sf
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.utils import load_model
    from breeze_fast import install
    from speech_parts import speakable_text

    root = Path(sys.argv[1])
    config = json.loads((root / "benchmark.json").read_text())
    trial = Path(config["trial"])
    spec = json.loads((trial / "model.json").read_text())
    plan = json.loads((trial / "plan.json").read_text())
    directions = json.loads((trial / "directions.json").read_text())["directions"]
    mx.set_memory_limit(30 * 1024**3)
    mx.set_cache_limit(1024**3)
    model = load_model(snapshot_download(spec["repo"], revision=spec["revision"], local_files_only=True))
    if config.get("bits"):
        nn.quantize(model.backbone_model, group_size=64, bits=config["bits"])
        nn.quantize(model.depth_decoder, group_size=64, bits=config["bits"])
    engine = install(model, compiled=config.get("compiled", True))
    verification = engine.verify()
    print(f"Depth logits verified; maximum relative error {verification:.5f}", flush=True)
    records = []
    for index in config["indices"]:
        segment = plan["chapters"][0]["segments"][index]
        voice = plan["cast"]["voices"][segment["role"]]
        reference = trial / "references" / (voice["reference_id"] + ".wav")
        if hashlib.sha256(reference.read_bytes()).hexdigest() != voice["sha256"]:
            raise ValueError("Reference hash mismatch")
        if (root / f"{index:04d}.wav").exists():
            raise ValueError("Benchmark output exists; use a new output directory")
        started = time.monotonic()
        parts = []
        for result in model.generate(text=speakable_text(segment["text"]) if config.get("spokenNotation") else segment["text"], voice="S0", instruct=directions[index]["instruction"],
                ref_audio=str(reference), ref_text=voice["transcript"], cfg_scale=4.0,
                seed=segment["request"]["seed"], max_tokens=1500, stream=False, split_pattern=None if config.get("spokenNotation") else "\n"):
            mx.eval(result.audio)
            parts.append(np.asarray(result.audio).reshape(-1))
        audio = np.concatenate(parts)
        elapsed = time.monotonic() - started
        output = root / f"{index:04d}.wav"
        sf.write(output, audio, result.sample_rate, subtype="PCM_16")
        baseline = json.loads((trial / "segments" / f"{index:04d}.json").read_text())
        record = {"index": index, "text": segment["text"], "instruction": directions[index]["instruction"],
            "audioSeconds": len(audio) / result.sample_rate, "generationSeconds": elapsed,
            "baselineSeconds": baseline.get("generationSeconds"), "baselineAudioSeconds": baseline["duration"],
            "depthMaxRelativeError": verification, "cfgScale": 4.0, "referenceSha256": voice["sha256"],
            "compiled": engine.compiled, "bits": config.get("bits", 16), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
        records.append(record)
        (root / "results.json").write_text(json.dumps(records, indent=2) + "\n")
        print(json.dumps(record), flush=True)


if __name__ == "__main__":
    main()
