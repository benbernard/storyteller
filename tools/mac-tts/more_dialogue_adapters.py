"""VibeVoice native one-context inference."""

from __future__ import annotations

from pathlib import Path
import mlx.core as mx
import soundfile as sf
from scipy.signal import resample_poly

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator
    from tts_typing import JsonObject
    from collections.abc import Mapping
    from tts_typing import Reference


def reference_wave(root: str | Path, ref: Reference, rate: int) -> mx.array:
    wave, sr = sf.read(
        Path(root) / "references" / (ref["reference_id"] + ".wav"), dtype="float32"
    )
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    if sr != rate:
        wave = resample_poly(wave, rate, sr)
    return mx.array(wave)


class VibeAdapter:
    def __init__(
        self, local: str | Path, root: str | Path, revisions: Mapping[str, str]
    ) -> None:
        from mlx_speech.models.vibevoice.checkpoint import load_vibevoice_model
        from mlx_speech.models.vibevoice.tokenizer import VibeVoiceTokenizer

        self.loaded = load_vibevoice_model(str(Path(local) / "mlx-int8"))
        self.tokenizer = VibeVoiceTokenizer.from_path(self.loaded.model_dir)
        self.root = root
        # Diffusion connectors return float32, while token embeddings are bf16.
        # Preserve the LM cache dtype established during reference prefill.
        model = self.loaded.model
        dtype = model.embed_tokens(mx.array([[0]], dtype=mx.int32)).dtype
        forward = model.lm_forward

        def stable_forward(
            *,
            inputs_embeds: mx.array,
            cache: list[tuple[mx.array, mx.array]] | None = None,
        ) -> tuple[mx.array, mx.array, list[tuple[mx.array, mx.array]]]:
            return forward(inputs_embeds=inputs_embeds.astype(dtype), cache=cache)

        model.lm_forward = stable_forward

    def generate(
        self, text: str, options: JsonObject, metrics: JsonObject
    ) -> Iterator[tuple[mx.array, int, int]]:
        from mlx_speech.generation.vibevoice import (
            VibeVoiceGenerationConfig,
            synthesize_vibevoice,
        )

        refs = options.pop("references", [])
        voices = [
            reference_wave(self.root, r, 24000).reshape(1, 1, -1)
            for r in sorted(refs, key=lambda r: r["speaker"])
        ]
        result = synthesize_vibevoice(
            self.loaded.model,
            self.tokenizer,
            text,
            voice_samples=voices or None,
            config=VibeVoiceGenerationConfig(safety_max_new_tokens=2048, **options),
        )
        metrics.update(
            single_native_generation=True,
            semantic_feedback=True,
            generated_tokens=result.generated_tokens,
            stop_reason="eos" if result.stop_reached else "token_limit",
        )
        yield result.waveform, result.sample_rate, 0
