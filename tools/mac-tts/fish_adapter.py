"""Local Fish S2 Pro generation with original multi-reference prompt assembly.

Generation loop adapted from mlx-speech 4577ad28 (MIT; LICENSE-mlx-speech).
Prompt layout matches fish-speech 214da3cd generate_long. Each request is ONE
user message and ONE autoregressive cache, never a loop over dialogue turns.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import mlx.core as mx
from mlx_speech.generation.fish_s2_pro import FishS2ProRuntime, _sample_token_id
from mlx_speech.models.fish_s2_pro.prompt import Conversation, Message, TextPart, VQPart

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject
    from collections.abc import Sequence


def build_prompt(
    runtime: FishS2ProRuntime,
    text: str,
    references: Sequence[tuple[int, str, mx.array]],
) -> mx.array:
    if references:
        transcript = "\n".join(
            f"<|speaker:{speaker}|>{transcript}"
            for speaker, transcript, codes in references
        )
        codes = mx.concatenate(
            [codes for speaker, transcript, codes in references], axis=1
        )
        parts = [
            TextPart(
                "convert the provided text to speech reference to the following:\n\nText:\n"
            ),
            TextPart(transcript),
            TextPart("\n\nSpeech:\n"),
            VQPart(codes),
        ]
    else:
        parts = [TextPart("convert the provided text to speech")]
    return Conversation(
        [
            Message(role="system", parts=parts),
            Message(role="user", parts=[TextPart(text)]),
            Message(role="assistant", modality="voice", parts=[], add_im_end=False),
        ]
    ).encode_for_inference(
        runtime.tokenizer, runtime.config.audio_decoder_config.num_codebooks
    )


class FishAdapter:
    def __init__(self, local: str | Path, root: str | Path, revision: str) -> None:
        self.runtime = FishS2ProRuntime.from_dir(local)
        self.root = Path(root)
        self.revision = revision

    def generate(
        self, text: str, options: JsonObject
    ) -> tuple[mx.array, int, JsonObject]:
        runtime = self.runtime
        refs = []
        for ref in options.pop("references", []):
            path = self.root / "references" / (ref["reference_id"] + ".wav")
            audio_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            key = hashlib.sha256(
                json.dumps([audio_hash, self.revision]).encode()
            ).hexdigest()
            cache = self.root / "prompts" / ("fish-" + key + ".safetensors")
            if cache.exists():
                codes = mx.load(str(cache))["codes"]
            else:
                codes = runtime.encode_reference(
                    str(path), ref["transcript"]
                ).reference_codes
                mx.eval(codes)
                temporary = cache.with_suffix(".tmp.safetensors")
                mx.save_safetensors(str(temporary), {"codes": codes})
                temporary.replace(cache)
            refs.append((ref["speaker"], ref["transcript"], codes))
        if "<|speaker:" not in text:
            text = "<|speaker:0|>" + text
        prompt = build_prompt(runtime, text, refs)
        limit = options.pop("max_tokens", 2048)
        prompt_tokens = int(prompt.shape[1])
        if prompt_tokens + limit > 32768:
            raise ValueError(
                "Fish prompt plus max_tokens exceeds its 32768-token context"
            )
        temperature = options.pop("temperature", 0.8)
        top_p = options.pop("top_p", 0.8)
        top_k = options.pop("top_k", 30)
        ras_window = options.pop("ras_window", 10)
        ras_temperature = options.pop("ras_temperature", 1.0)
        ras_top_p = options.pop("ras_top_p", 0.9)
        if options:
            raise ValueError("Unsupported Fish options: " + ", ".join(options))
        count = runtime.config.audio_decoder_config.num_codebooks
        cache = runtime._make_cache(prompt_tokens, limit)
        forward = runtime.model(prompt[None, :, :], cache=cache)
        mx.eval(forward.logits, forward.hidden_states)
        fast = mx.compile(runtime.model.fast_forward)
        generated = []
        recent = []
        stop_reason = "token_limit"
        for _ in range(limit):
            logits = runtime._apply_semantic_logit_bias(forward.logits[:, -1, :])
            token = _sample_token_id(
                logits, temperature=temperature, top_p=top_p, top_k=top_k
            )
            # Repetition-aware sampling, matching the upstream implementation.
            fallback = _sample_token_id(
                logits, temperature=ras_temperature, top_p=ras_top_p, top_k=top_k
            )
            if token in recent:
                token = fallback
            if token in runtime._stop_ids:
                stop_reason = "eos"
                break
            semantic = runtime._semantic_code_from_token_id(token)
            recent = (recent + [token])[-ras_window:] if ras_window else []
            previous = mx.array([[semantic]], dtype=mx.int32)
            step = [mx.array([semantic], dtype=mx.int32)]
            for _ in range(1, count):
                logits = fast(forward.hidden_states[:, -1:, :], previous)
                code = mx.array(
                    [
                        _sample_token_id(
                            logits, temperature=temperature, top_p=top_p, top_k=top_k
                        )
                    ],
                    dtype=mx.int32,
                )
                previous = mx.concatenate([previous, code[:, None]], axis=1)
                step.append(code)
            generated.append(mx.stack(step, axis=0))
            frame = mx.zeros((1, count + 1, 1), dtype=mx.int32)
            frame[:, 0, 0] = mx.array([token], dtype=mx.int32)
            frame[:, 1:, 0] = previous
            forward = runtime.model(frame, cache=cache)
            mx.eval(forward.logits, forward.hidden_states)
        if not generated:
            raise ValueError("Fish returned no audio tokens")
        codes = mx.stack(generated, axis=1).squeeze(2)
        wave = runtime.codec.decode(codes).squeeze()
        mx.eval(wave)
        return (
            wave,
            runtime.codec.sample_rate,
            {
                "generated_tokens": len(generated),
                "prompt_tokens": prompt_tokens,
                "stop_reason": stop_reason,
                "single_native_generation": True,
                "speaker_ids": [speaker for speaker, _, _ in refs],
                "text_completion": "requires listening/ASR; EOS alone is not proof",
                "model_revision": self.revision,
                "quantization": "8bit",
            },
        )
