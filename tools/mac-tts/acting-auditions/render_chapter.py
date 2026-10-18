#!/usr/bin/env python3
"""Resume a Breeze chapter trial from an immutable reviewed plan and directions."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
import sys
import time

from speech_parts import speech_parts, synthesis_text, delivery_instruction
from sequence_gate import verify_sequence_gate


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def main() -> None:
    if not os.environ.get("AUDITION_LEASE_OWNER"):
        raise SystemExit("Use generate.py: an exclusive GPU lease is required")
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.utils import load_model

    root = Path(sys.argv[1]).resolve()
    verify_sequence_gate(root)
    phase_config = json.loads((root / "phase.json").read_text())
    phase = phase_config["phase"]
    if phase not in {"hybrid", "breeze-narrator", "breeze-full"}:
        raise ValueError("Unknown chapter trial phase")
    plan = json.loads((root / "plan.json").read_text())
    directions = json.loads((root / "directions.json").read_text())
    if digest(root / "plan.json") != directions["planSha256"]:
        raise ValueError("Plan changed after acting review")
    if digest(root / "casting-review.json") != directions["castingReviewSha256"]:
        raise ValueError("Casting review changed after acting review")
    if len(plan["chapters"]) != 1:
        raise ValueError("This trial requires one chapter")
    chapter = plan["chapters"][0]
    segments = chapter["segments"]
    source = json.loads((root / "source.json").read_text())
    body = "".join(s["text"] for s in segments if "presentation" not in s)
    if body != source["text"] or hashlib.sha256(body.encode()).hexdigest() != chapter["sourceSha256"]:
        raise ValueError("Plan does not preserve the exact chapter source")
    if [s["uid"] for s in segments] != [d["uid"] for d in directions["directions"]]:
        raise ValueError("Acting directions do not cover the exact ordered plan")
    for voice in plan["cast"]["voices"].values():
        reference = root / "references" / (voice["reference_id"] + ".wav")
        if digest(reference) != voice["sha256"]:
            raise ValueError("Reviewed voice reference changed")
    spec = json.loads((root / "model.json").read_text())
    if spec["repo"] != "mlx-community/Breeze-TTS-2-mlx" or spec["revision"] != "3c8829fb7fd335818f085cd2ef49b4100c0e46c8":
        raise ValueError("Model differs from the auditioned Breeze revision")
    identity = hashlib.sha256((digest(root / "plan.json") + digest(root / "directions.json") + digest(root / "model.json") + digest(root / "phase.json")).encode()).hexdigest()
    retake_path = root / "retakes.json"
    retakes = json.loads(retake_path.read_text()) if retake_path.exists() else {}
    receipts = root / "segments"
    receipts.mkdir(exist_ok=True)
    mx.set_memory_limit(30 * 1024**3)
    mx.set_cache_limit(1024**3)
    runtime_path = root / "inference.json"
    runtime = json.loads(runtime_path.read_text()) if runtime_path.exists() else {"engine": "stock-bf16"}
    if runtime not in ({"engine": "stock-bf16"}, {"engine": "cached-depth-v1", "bits": 8, "groupSize": 64, "compiled": True}):
        raise ValueError("Unreviewed Breeze inference configuration")
    runtime_evidence: dict[str, object] = {"configuration": runtime, "rendererSha256": digest(Path(__file__))}
    model = None
    for index, (segment, direction) in enumerate(zip(segments, directions["directions"], strict=True)):
        if (root / "cancel.requested").exists():
            raise RuntimeError("Trial paused; completed passages retained")
        name = f"{index:04d}"
        receipt_path = receipts / (name + ".json")
        audio_path = receipts / (name + ".wav")
        if receipt_path.exists():
            old = json.loads(receipt_path.read_text())
            if old["identity"] != identity or old["sha256"] != digest(audio_path):
                raise ValueError("Cached passage changed; refusing reuse")
            continue
        save(root / "progress.json", {"status": "rendering", "completed": index, "total": len(segments),
             "role": segment["role"], "updatedAt": time.time(), "identity": identity})
        retake = retakes.get(name)
        effective_seed = segment["request"]["seed"]
        if retake is not None:
            if retake["uid"] != segment["uid"] or not retake["reason"] or not isinstance(retake["seed"], int):
                raise ValueError("Retake does not match reviewed passage")
            effective_seed = retake["seed"]
        voice = plan["cast"]["voices"][segment["role"]]
        reference = root / "references" / (voice["reference_id"] + ".wav")
        instruction = direction["instruction"]
        reuse_qwen = phase == "hybrid" and segment["role"] in {"narrator", "author-note"}
        reuse_hybrid = phase == "breeze-narrator" and segment["role"] != "narrator"
        if reuse_qwen or reuse_hybrid:
            if reuse_qwen:
                original = root / "qwen-original" / "segments" / segment["fingerprint"]
                saved = json.loads((original / "receipt.json").read_text())
                original_audio = original / "audio.wav"
                if (saved["request"] != segment["request"] or saved["fingerprint"] != segment["fingerprint"]
                        or saved["job"]["model"] != "qwen-base" or saved["job"]["state"] != "succeeded"
                        or saved["wav_sha256"] != digest(original_audio)):
                    raise ValueError("Original Qwen passage failed verification")
                provider = "qwen-base"
            else:
                original = Path(phase_config["hybridDirectory"]) / "segments"
                saved = json.loads((original / (name + ".json")).read_text())
                original_audio = original / (name + ".wav")
                if (saved["uid"] != segment["uid"] or saved["text"] != segment["text"]
                        or saved["referenceSha256"] != voice["sha256"] or saved["sha256"] != digest(original_audio)):
                    raise ValueError("Hybrid passage failed verification")
                provider = saved["model"]
            shutil.copy2(original_audio, audio_path)
            info = sf.info(audio_path)
            save(receipt_path, {"identity": identity, "index": index, "uid": segment["uid"],
                "role": segment["role"], "text": segment["text"], "instruction": None if reuse_qwen else saved["instruction"],
                "rationale": "Retain the original Qwen recording" if reuse_qwen else saved["rationale"],
                "referenceSha256": voice["sha256"], "audio": audio_path.name, "sha256": digest(audio_path),
                "duration": info.duration, "sampleRate": info.samplerate, "model": provider,
                "reusedFrom": str(original_audio)})
            continue
        if model is None:
            model = load_model(snapshot_download(spec["repo"], revision=spec["revision"], local_files_only=True))
            if runtime["engine"] == "cached-depth-v1":
                import mlx.nn as nn
                from importlib.metadata import version
                from breeze_fast import install
                if version("mlx-audio") != "0.5.7" or version("mlx") != "0.32.3":
                    raise ValueError("Cached Breeze requires the verified MLX runtime versions")
                nn.quantize(model.backbone_model, group_size=64, bits=8)
                nn.quantize(model.depth_decoder, group_size=64, bits=8)
                engine = install(model)
                runtime_evidence["depthMaxRelativeError"] = engine.verify()
                runtime_evidence["adapterSha256"] = digest(Path(__file__).with_name("breeze_fast.py"))
                runtime_evidence["mlxAudio"] = version("mlx-audio")
                runtime_evidence["mlx"] = version("mlx")
        started = time.monotonic()
        mx.random.seed(effective_seed)
        mx.reset_peak_memory()
        synthesis_parts = speech_parts(segment["text"])
        audio_parts = []
        rate = 24000
        for part in synthesis_parts:
            if part["kind"] == "pause":
                audio_parts.append(np.zeros(8400, dtype=np.float32))
                continue
            if not part["text"].strip():
                continue
            generated = []
            for result in model.generate(text=synthesis_text(part), voice="S0", instruct=delivery_instruction(instruction, part),
                    ref_audio=str(reference), ref_text=voice["transcript"], cfg_scale=4.0,
                    seed=effective_seed, max_tokens=1500, stream=False, split_pattern=None):
                mx.eval(result.audio)
                generated.append(np.asarray(result.audio).reshape(-1))
                if result.sample_rate != rate:
                    raise ValueError("Breeze changed sample rate")
            if not generated:
                raise ValueError("Breeze returned no audio")
            audio_parts.extend(generated)
        if not audio_parts:
            audio_parts.append(np.zeros(2400, dtype=np.float32))
        audio = np.concatenate(audio_parts)
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError("Invalid Breeze audio")
        sf.write(audio_path, audio, rate, subtype="PCM_16")
        receipt = {"identity": identity, "index": index, "uid": segment["uid"], "role": segment["role"],
            "text": segment["text"], "instruction": instruction, "rationale": direction["rationale"],
            "referenceSha256": voice["sha256"], "audio": audio_path.name, "sha256": digest(audio_path),
            "model": "breeze-tts-2", "duration": len(audio) / rate, "generationSeconds": time.monotonic() - started,
            "sampleRate": rate, "peakMetalGB": mx.get_peak_memory() / 1024**3,
            "seed": effective_seed, "originalSeed": segment["request"]["seed"], "retake": retake, "cfgScale": 4.0, "maxTokens": 1500,
            "clippedFraction": float(np.mean(np.abs(audio) >= 1)), "inference": runtime_evidence, "synthesisParts": [{**part, "spokenText": synthesis_text(part) if part["kind"] != "pause" else "", "instruction": delivery_instruction(instruction, part) if part["kind"] != "pause" else None} for part in synthesis_parts]}
        save(receipt_path, receipt)
        print(f"Completed {index + 1}/{len(segments)}: {segment['role']} ({receipt['duration']:.1f}s)", flush=True)
    save(root / "progress.json", {"status": "rendered-awaiting-review", "completed": len(segments),
         "total": len(segments), "updatedAt": time.time(), "identity": identity})


if __name__ == "__main__":
    main()
