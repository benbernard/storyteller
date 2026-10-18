#!/usr/bin/env python3
"""Design synthetic Breeze reference voices from an explicit voices.json brief."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def validate_brief(value: object) -> list[dict[str, str | int]]:
    if not isinstance(value, dict) or not isinstance(value.get("voices"), list):
        raise ValueError("voices.json must contain a voices array")
    voices: list[dict[str, str | int]] = []
    seen: set[str] = set()
    for item in value["voices"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid voice brief")
        role, text, instruction, seed = (item.get(k) for k in ("role", "text", "instruction", "seed"))
        if not isinstance(role, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", role) or role in seen:
            raise ValueError("Voice roles must be unique safe IDs")
        if not isinstance(text, str) or not 40 <= len(text) <= 600 or not isinstance(instruction, str) or len(instruction) < 20:
            raise ValueError("Supply a short reference transcript and a descriptive voice instruction")
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**31:
            raise ValueError("Supply an explicit nonnegative 31-bit seed")
        seen.add(role)
        voices.append({"role": role, "text": text, "instruction": instruction, "seed": seed})
    if not {"narrator", "anonymous"}.issubset(seen):
        raise ValueError("Design distinct narrator and anonymous voices")
    return voices


def main() -> None:
    if not os.environ.get("AUDITION_LEASE_OWNER"):
        raise SystemExit("Use generate.py: an exclusive GPU lease is required")
    root = Path(sys.argv[1]).resolve()
    brief = root / "voices.json"
    voices = validate_brief(json.loads(brief.read_text()))
    spec = json.loads(Path(__file__).with_name("models.json").read_text())["breeze"]
    dependency = hashlib.sha256((digest(brief) + json.dumps(spec, sort_keys=True)).encode()).hexdigest()
    receipt = root / "cast.json"
    if receipt.exists():
        old = json.loads(receipt.read_text())
        if old["dependency"] != dependency:
            raise ValueError("Voice brief changed; create a new reference directory")
        for role, voice in old["voices"].items():
            if digest(root / "references" / role / "reference.wav") != voice["sha256"]:
                raise ValueError("Saved reference changed")
        print("Verified existing reference set; no generation needed")
        return
    import mlx.core as mx
    import mlx.nn as nn
    import numpy as np
    import soundfile as sf
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.utils import load_model
    from importlib.metadata import version
    from breeze_fast import install

    if version("mlx-audio") != "0.5.7" or version("mlx") != "0.32.3":
        raise ValueError("Breeze requires the pinned MLX runtime")
    model = load_model(snapshot_download(spec["repo"], revision=spec["revision"], local_files_only=True))
    nn.quantize(model.backbone_model, group_size=64, bits=8)
    nn.quantize(model.depth_decoder, group_size=64, bits=8)
    engine = install(model)
    error = engine.verify()
    cast: dict[str, object] = {}
    for voice in voices:
        role, text, instruction, seed = str(voice["role"]), str(voice["text"]), str(voice["instruction"]), int(voice["seed"])
        folder = root / "references" / role
        folder.mkdir(parents=True, exist_ok=True)
        wav, record = folder / "reference.wav", folder / "design.json"
        identity = hashlib.sha256((dependency + role).encode()).hexdigest()
        if record.exists():
            saved = json.loads(record.read_text())
            if saved["identity"] != identity or digest(wav) != saved["voice"]["sha256"]:
                raise ValueError("Saved voice does not match the brief")
            cast[role] = saved["voice"]
            continue
        mx.random.seed(seed)
        chunks = []
        rate = 24000
        for result in model.generate(text=text, voice="S0", instruct=instruction, cfg_scale=4.0,
                                     seed=seed, max_tokens=1500, stream=False, split_pattern=None):
            mx.eval(result.audio)
            if result.sample_rate != rate:
                raise ValueError("Unexpected sample rate")
            chunks.append(np.asarray(result.audio).reshape(-1))
        audio = np.concatenate(chunks) if chunks else np.array([], dtype=np.float32)
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError("Breeze returned invalid audio")
        sf.write(wav, audio, rate, subtype="PCM_16")
        entry = {"reference_id": str(uuid.uuid4()), "sha256": digest(wav), "transcript": text,
                 "provenance": "Synthetic Breeze voice: " + instruction}
        save(record, {"identity": identity, "voice": entry, "seed": seed, "model": spec,
                      "depthMaxRelativeError": error, "duration": len(audio) / rate})
        cast[role] = entry
        print(f"Designed {role}; listen to {wav} before using it", flush=True)
    save(receipt, {"model": "breeze-tts-2", "revision": spec["revision"], "dependency": dependency, "voices": cast})


if __name__ == "__main__":
    main()
