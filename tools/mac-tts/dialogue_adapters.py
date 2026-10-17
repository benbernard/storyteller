"""Pinned native MOSS and Higgs dialogue adapters. No HTTP or arbitrary paths."""

from __future__ import annotations

from pathlib import Path
import mlx.core as mx
from huggingface_hub import snapshot_download

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator
    from tts_typing import JsonObject
    from collections.abc import Mapping
    from tts_typing import Reference
    from collections.abc import Sequence


def codec_path(repo: str, revisions: Mapping[str, str]) -> str:
    path = Path(snapshot_download(repo, revision=revisions[repo]))
    return str(path / "mlx-int8" if (path / "mlx-int8").is_dir() else path)


class MossAdapter:
    def __init__(
        self, local: str | Path, root: str | Path, revisions: Mapping[str, str]
    ) -> None:
        from mlx_speech.models.moss_delay import (
            load_moss_tts_delay_model,
            MossTTSDelayProcessor,
        )
        from mlx_speech.models.moss_audio_tokenizer import (
            load_moss_audio_tokenizer_model,
        )

        self.loaded = load_moss_tts_delay_model(str(Path(local) / "mlx-int8"))
        codec = load_moss_audio_tokenizer_model(
            codec_path("appautomaton/openmoss-audio-tokenizer-mlx", revisions)
        )
        self.processor = MossTTSDelayProcessor.from_path(
            self.loaded.model_dir, audio_tokenizer=codec.model
        )
        self.root = Path(root)

    def generate(
        self, text: str | list[str], options: JsonObject, metrics: JsonObject
    ) -> Iterator[tuple[mx.array, int, int]]:
        from mlx_speech.models.moss_delay import (
            build_ttsd_conversation,
            resolve_ttsd_processor_mode,
        )
        from mlx_speech.generation import (
            MossTTSDelayGenerationConfig,
            synthesize_moss_tts_delay_conversations,
        )

        refs = options.pop("references", [])
        mode = options.pop("conditioning", "voice_clone" if refs else "generation")
        text_normalize = options.pop("text_normalize", False)
        rate_normalize = options.pop("sample_rate_normalize", False)
        audio_map = {
            r["speaker"]: str(self.root / "references" / (r["reference_id"] + ".wav"))
            for r in refs
        }
        text_map = {r["speaker"]: r["transcript"] for r in refs if r.get("transcript")}
        texts = text if isinstance(text, list) else [text]
        conversations = [
            build_ttsd_conversation(
                processor=self.processor,
                mode=mode,
                text=t,
                audio_map=audio_map,
                text_map=text_map,
                text_normalize_enabled=text_normalize,
                sample_rate_normalize_enabled=rate_normalize,
                n_vq=self.loaded.config.n_vq,
            )
            for t in texts
        ]
        config = MossTTSDelayGenerationConfig(safety_max_new_tokens=4096, **options)
        result = synthesize_moss_tts_delay_conversations(
            self.loaded.model,
            self.processor,
            conversations=conversations,
            mode=resolve_ttsd_processor_mode(mode),
            config=config,
        )
        metrics.update(
            single_native_generation=True,
            native_batch=len(texts),
            generated_rows=int(result.generation.generated_rows.shape[-2])
            if result.generation.generated_rows.ndim > 1
            else int(result.generation.generated_rows.size),
            stop_reason="eos" if result.generation.stop_reached else "token_limit",
        )
        for i, output in enumerate(result.outputs):
            yield output.waveform, output.sample_rate, i


class HiggsAdapter:
    def __init__(
        self, local: str | Path, root: str | Path, revisions: Mapping[str, str]
    ) -> None:
        from mlx_audio.tts.models.higgs_audio.serve import HiggsAudioServer

        self.server = HiggsAudioServer.from_pretrained(
            local, codec_path("mlx-community/higgs-audio-v2-tokenizer", revisions)
        )
        self.root = Path(root)
        self.references = {}

    def prompt(
        self, text: str, refs: Sequence[Reference], scene: str
    ) -> tuple[mx.array, mx.array, dict[str, int]]:
        from mlx_audio.tts.models.higgs_audio.serve import (
            encode_reference,
            _load_wav_as_24k_mono,
        )

        server = self.server
        embeddings = []
        masks = []

        def add_text(value: str) -> None:
            ids = server.tokenizer.encode(value, add_special_tokens=False)
            embeddings.append(
                server.model.embed_tokens(mx.array([ids], dtype=mx.int32))[0]
            )
            masks.append(mx.zeros((len(ids),), dtype=mx.bool_))

        add_text("<|begin_of_text|>")
        if scene:
            add_text(
                "<|start_header_id|>system<|end_header_id|>\n\nGenerate audio following instruction.\n\n<|scene_desc_start|>\n"
                + scene
                + "\n<|scene_desc_end|><|eot_id|>"
            )
        for ref in refs:
            key = ref["reference_id"]
            if key not in self.references:
                context = encode_reference(
                    _load_wav_as_24k_mono(
                        str(self.root / "references" / (key + ".wav"))
                    ),
                    ref["transcript"],
                    config=server.config,
                    tokenizer=server.tokenizer,
                    codec=server.codec,
                    embed_tokens=server.model.embed_tokens,
                    audio_codebook_embeddings=server.model.audio_codebook_embeddings,
                )
                self.references[key] = context
            context = self.references[key]
            add_text(
                "<|start_header_id|>user<|end_header_id|>\n\n"
                + ("[SPEAKER" + str(ref["speaker"]) + "] " if len(refs) > 1 else "")
                + ref["transcript"]
                + "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n<|audio_out_bos|>"
            )
            embeddings.append(context.audio_emb)
            masks.append(mx.ones((context.T_ref_delayed,), dtype=mx.bool_))
            add_text("<|audio_eos|><|eot_id|>")
        add_text(
            "<|start_header_id|>user<|end_header_id|>\n\n"
            + text
            + "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n<|audio_out_bos|>"
        )
        return (
            mx.concatenate(embeddings, axis=0)[None],
            mx.concatenate(masks)[None],
            {"references": len(refs)},
        )

    def generate(
        self, text: str | list[str], options: JsonObject, metrics: JsonObject
    ) -> Iterator[tuple[mx.array, int, int]]:
        refs = options.pop("references", [])
        scene = options.pop("scene_prompt", "")
        stream = options.pop("stream", False)
        # Scoped to this private worker, serialized requests; restore after completion.
        original = self.server._build_prompt
        self.server._build_prompt = lambda target, _ref_text, _ref_path: self.prompt(
            target, refs, scene
        )
        try:
            metrics["single_native_generation"] = True
            if stream:
                for wave in self.server.generate_stream_overlap_add(text, **options):
                    yield wave, 24000, 0
                metrics["stop_reason"] = (
                    "stream_complete; inspect transcript for truncation"
                )
            else:
                result = self.server.generate(text, **options)
                metrics.update(
                    stop_reason=result.stop_reason,
                    generated_frames=result.num_frames_aligned,
                )
                yield result.pcm, result.sampling_rate, 0
        finally:
            self.server._build_prompt = original
