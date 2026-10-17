"""Private newline-JSON inference worker. Never binds a network socket."""

from __future__ import annotations

import sys
import os
import json
import time
import traceback
import resource
import hashlib
from pathlib import Path

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject
    from tts_typing import JsonValue

protocol = sys.stdout
sys.stdout = sys.stderr  # Third-party progress messages must not corrupt stdio.
os.umask(0o077)


def emit(value: JsonValue) -> None:
    protocol.write(json.dumps(value, allow_nan=False) + "\n")
    protocol.flush()


model = None
spec = None
root = Path(os.environ["MAC_TTS_HOME"])


def load(config: JsonObject) -> JsonObject:
    global model, spec
    spec = config
    from huggingface_hub import snapshot_download

    revisions = json.loads((Path(__file__).parent / "models.lock.json").read_text())
    spec["revision"] = revisions[spec["repo"]]
    patterns = (
        [
            "config_*.json",
            "codec.pt",
            "llm_posttrain.pt",
            "Qwen2.5-1.5B/*.json",
            "Qwen2.5-1.5B/*.txt",
        ]
        if spec["mode"] == "firered"
        else None
    )
    local = snapshot_download(
        spec["repo"], revision=spec["revision"], allow_patterns=patterns
    )
    if spec["mode"] == "text":
        from text_adapter import TextAdapter

        model = TextAdapter(local)
    elif spec["mode"] in {"moss", "higgs", "vibe"}:
        import mlx.core as mx

        mx.set_memory_limit(32 * 1024**3)
        mx.set_cache_limit(1024**3)
        from dialogue_adapters import MossAdapter, HiggsAdapter

        from more_dialogue_adapters import VibeAdapter

        adapter = {
            "moss": MossAdapter,
            "higgs": HiggsAdapter,
            "vibe": VibeAdapter,
        }[spec["mode"]]
        model = adapter(local, root, revisions)
    elif spec["runtime"] == "firered":
        from firered_adapter import FireRedAdapter

        model = FireRedAdapter(local, root)
    elif spec["runtime"] == "fish":
        from fish_adapter import FishAdapter

        model = FishAdapter(local, root, spec["revision"])
    elif spec["runtime"] == "mlx":
        from mlx_audio.tts.utils import load_model

        model = load_model(spec["repo"], revision=revisions[spec["repo"]])
    else:
        import torch
        from qwen_tts import Qwen3TTSModel

        if not torch.backends.mps.is_available():
            raise RuntimeError("MPS unavailable; no implicit CPU fallback")
        model = Qwen3TTSModel.from_pretrained(
            local, device_map="mps", dtype=torch.float32, attn_implementation="eager"
        )
    return {
        "loaded": spec["id"],
        "rss_peak_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }


def generate(request: JsonObject, request_id: str) -> JsonObject:
    if spec["mode"] == "text":
        return model.generate(request["input"])
    import numpy as np
    import soundfile as sf

    opts = dict(request["input"])
    text = opts.pop("text")
    seed = opts.pop("seed", None)
    opts.pop("voice_id", None)
    reference_id = opts.pop("reference_id", None)
    reference = (
        str(root / "references" / (reference_id + ".wav")) if reference_id else None
    )
    started = time.monotonic()
    folder = root / "audio" / request["job_id"]
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    chunks = []
    rate = 24000
    extra_metrics = {}
    if spec["mode"] in {"moss", "higgs", "vibe"}:
        import mlx.core as mx

        mx.reset_peak_memory()
        if seed is not None:
            mx.random.seed(seed)
        iterable = model.generate(text, opts, extra_metrics)
    elif spec["runtime"] == "firered":
        import torch

        if seed is not None:
            torch.manual_seed(seed)
        iterable = model.generate(text, opts, extra_metrics)
    elif spec["runtime"] == "fish":
        import mlx.core as mx

        mx.reset_peak_memory()
        if seed is not None:
            mx.random.seed(seed)
        wave, rate, extra_metrics = model.generate(text, opts)
        iterable = [(wave, rate, 0)]
    elif spec["runtime"] == "qwen":
        import torch

        if seed is not None:
            torch.manual_seed(seed)
        if "max_tokens" in opts:
            opts["max_new_tokens"] = opts.pop("max_tokens")
        if spec["mode"] == "base":
            ref_text = opts.pop("ref_text", None)
            xvector = opts.pop("x_vector_only_mode", False)
            key = hashlib.sha256(
                json.dumps(
                    [reference_id, ref_text, xvector, spec["repo"], spec["revision"]]
                ).encode()
            ).hexdigest()
            cache = root / "prompts" / (key + ".pt")
            if cache.exists():
                # Only server-created tensors, never a user-supplied pickle.
                prompt = torch.load(cache, weights_only=True, map_location="mps")
            else:
                items = model.create_voice_clone_prompt(
                    ref_audio=reference, ref_text=ref_text, x_vector_only_mode=xvector
                )
                prompt = {
                    k: [getattr(item, k) for item in items]
                    for k in [
                        "ref_code",
                        "ref_spk_embedding",
                        "x_vector_only_mode",
                        "icl_mode",
                    ]
                }
                torch.save(prompt, cache)
            from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

            items = [
                VoiceClonePromptItem(
                    **{k: v[i] for k, v in prompt.items()}, ref_text=ref_text
                )
                for i in range(len(prompt["icl_mode"]))
            ]
            waves, rate = model.generate_voice_clone(
                text=text, voice_clone_prompt=items, **opts
            )
        elif spec["mode"] == "custom":
            waves, rate = model.generate_custom_voice(text=text, **opts)
        else:
            waves, rate = model.generate_voice_design(text=text, **opts)
        iterable = ((w, rate, i) for i, w in enumerate(waves))
    else:
        import mlx.core as mx

        mx.reset_peak_memory()
        if seed is not None:
            mx.random.seed(seed)
        mode = spec["mode"]
        if mode in ["custom", "design", "base"]:
            if isinstance(text, list):
                opts["lang_code"] = opts.pop("language", "auto")

                def per_item(value: str | list[str] | None) -> list[str | None]:
                    return value if isinstance(value, list) else [value] * len(text)

                if mode == "custom":
                    opts["voices"] = per_item(opts.pop("speaker"))
                    opts["instructs"] = per_item(opts.pop("instruct", None))
                else:
                    opts.pop("x_vector_only_mode", None)
                    opts["ref_audio"] = reference
                result = model.batch_generate(texts=text, verbose=False, **opts)
            elif mode == "base":
                opts["lang_code"] = opts.pop("language", "auto")
                if opts.pop("x_vector_only_mode", False):
                    opts.pop("ref_text", None)
                opts["ref_audio"] = reference
                result = model.generate(text=text, verbose=False, **opts)
            elif mode == "custom":
                result = model.generate_custom_voice(text=text, verbose=False, **opts)
            else:
                result = model.generate_voice_design(text=text, verbose=False, **opts)
        elif mode == "chatterbox":
            from mlx_audio.utils import load_audio

            if reference:
                opts["audio_prompt"] = load_audio(
                    reference, sample_rate=model.sample_rate
                )
                opts["audio_prompt_sr"] = model.sample_rate
            opts["lang_code"] = opts.pop("language", "en")
            result = model.generate(text=text, verbose=False, **opts)
        elif mode == "turbo":
            opts["split_pattern"] = {
                "sentence": r"(?<=[.!?])\s+",
                "newline": r"\n+",
                "none": None,
            }[opts.pop("split", "sentence")]
            # Always restore default conditioning after a previous reference request.
            if not reference and hasattr(model, "_mac_default_conds"):
                model._conds = model._mac_default_conds
            elif not hasattr(model, "_mac_default_conds"):
                model._mac_default_conds = model._conds
            result = model.generate(text=text, ref_audio=reference, **opts)
        else:
            language = opts.pop("language", "a")
            pipeline = model._get_pipeline(language)
            blend = opts.pop("blend", None)
            voice = opts.pop("voice", "af_heart")
            if blend:
                total = sum(v["weight"] for v in blend)
                pipeline.voices["__api_blend"] = sum(
                    (
                        pipeline.load_single_voice(v["voice"]) * v["weight"] / total
                        for v in blend
                    )
                )
                voice = "__api_blend"
            split = {"newline": r"\n+", "sentence": r"(?<=[.!?])\s+", "none": None}[
                opts.pop("split", "newline")
            ]
            if opts.pop("phonemes", False):
                # Token-free phoneme input follows the runtime's public pipeline method.
                result = pipeline.generate_from_tokens(
                    text, voice=voice, speed=opts.pop("speed", 1.0)
                )
            else:
                result = pipeline(
                    text, voice=voice, speed=opts.pop("speed", 1.0), split_pattern=split
                )
            iterable = (
                (r.audio, model.sample_rate, 0)
                if hasattr(r, "audio")
                else (r[2], model.sample_rate, 0)
                for r in result
            )
        if mode != "kokoro":
            iterable = (
                (r.audio, r.sample_rate, getattr(r, "sequence_idx", 0)) for r in result
            )
    first = None
    sequence_chunks = {}
    for index, (audio, sample_rate, sequence) in enumerate(iterable):
        wave = np.asarray(audio, dtype=np.float32).reshape(-1)
        if not wave.size or not np.isfinite(wave).all():
            raise ValueError("Runtime produced empty or non-finite audio")
        if chunks and rate != sample_rate:
            raise ValueError("Runtime changed sample rate mid-request")
        rate = sample_rate
        if first is None:
            first = time.monotonic() - started
        filename = f"chunk-{index:04d}.wav"
        sf.write(folder / filename, wave, rate, subtype="FLOAT")
        chunks.append(wave)
        sequence_chunks.setdefault(sequence, []).append(wave)
        emit(
            {
                "id": request_id,
                "event": "chunk",
                "chunk": filename,
                "index": index,
                "sequence": sequence,
                "sample_rate": rate,
                "samples": len(wave),
            }
        )
    if not chunks:
        raise ValueError("Runtime returned no audio")
    joined = np.concatenate(
        [np.concatenate(sequence_chunks[i]) for i in sorted(sequence_chunks)]
    )
    sf.write(folder / "output.wav", joined, rate, subtype="FLOAT")
    elapsed = time.monotonic() - started
    metrics = {
        "sample_rate": rate,
        "samples": len(joined),
        "duration_seconds": len(joined) / rate,
        "generation_seconds": elapsed,
        "first_chunk_seconds": first,
        "real_time_factor": elapsed / (len(joined) / rate),
        "rss_peak_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "chunks": len(chunks),
        "sequences": len(sequence_chunks),
        "format": "WAV float32",
        "peak_amplitude": float(np.max(np.abs(joined))),
        "rms_amplitude": float(np.sqrt(np.mean(joined**2))),
    }
    metrics.update(extra_metrics)
    if spec["runtime"] in {"mlx", "fish"}:
        metrics["metal_peak_bytes"] = mx.get_peak_memory()
    else:
        metrics["metal_allocated_bytes"] = torch.mps.driver_allocated_memory()
    return metrics


for line in sys.stdin:
    try:
        req = json.loads(line)
        value = load(req["model"]) if req["op"] == "load" else generate(req, req["id"])
        emit({"id": req["id"], "event": "done", "result": value})
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit(
            {
                "id": req.get("id"),
                "event": "error",
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
