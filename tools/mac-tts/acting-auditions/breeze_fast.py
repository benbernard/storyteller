# SPDX-License-Identifier: Apache-2.0
"""Cached Breeze depth decoding; keeps original weights, CFG and sampling rules.

Algorithm adapted from xzf-thu/BreezeTTS2_Mac_Streaming (Apache-2.0).
Copyright 2026 xzf-thu. See upstream NOTICE in breeze-fast-NOTICE.txt.
"""
from __future__ import annotations

from collections.abc import Callable
import mlx.core as mx
import mlx.nn as nn
from mlx_audio.lm.sample_utils import make_sampler
from mlx_audio.tts.models.breeze_tts.breeze_tts import Model


class FrameCache:
    """KV storage scoped to one acoustic frame; never shared between frames."""

    def __init__(self) -> None:
        self.keys: mx.array | None = None
        self.values: mx.array | None = None
        self.offset = 0

    def update_and_fetch(self, keys: mx.array, values: mx.array) -> tuple[mx.array, mx.array]:
        self.keys = keys if self.keys is None else mx.concatenate((self.keys, keys), axis=2)
        self.values = values if self.values is None else mx.concatenate((self.values, values), axis=2)
        self.offset += keys.shape[2]
        return self.keys, self.values


class FastDepth:
    def __init__(self, model: Model, *, compiled: bool = True) -> None:
        self.model = model
        self.compiled = compiled
        self.functions: dict[tuple[float, float, int, float, bool], Callable[[mx.array, mx.array], mx.array]] = {}

    def initial(self, first: mx.array, hidden: mx.array) -> tuple[mx.array, list[FrameCache]]:
        m = self.model.depth_decoder.model
        if m.backbone_hidden_state_projector is not None:
            hidden = m.backbone_hidden_state_projector(hidden)
        ids = mx.broadcast_to(first.reshape(1, 1), (hidden.shape[0], 1))
        x = m.inputs_embeds_projector(mx.concatenate((hidden[:, None, :], m.embed_tokens(ids)), axis=1))
        caches = [FrameCache() for _ in m.layers]
        for layer, cache in zip(m.layers, caches, strict=True):
            x = layer(x, "causal", cache)
        return x, caches

    def advance(self, token: mx.array, index: int, caches: list[FrameCache], batch: int) -> mx.array:
        m = self.model.depth_decoder.model
        ids = mx.broadcast_to(token.reshape(1, 1), (batch, 1))
        x = m.inputs_embeds_projector(m.embed_tokens(ids + index * m.vocab_size))
        for layer, cache in zip(m.layers, caches, strict=True):
            x = layer(x, None, cache)
        return x

    def logits(self, x: mx.array, head: int) -> mx.array:
        decoder = self.model.depth_decoder
        return decoder.model.norm(x[:, -1, :]) @ decoder.codebooks_head.weight[head]

    def function(self, temperature: float, top_p: float, top_k: int, scale: float,
                 cfg: bool) -> Callable[[mx.array, mx.array], mx.array]:
        key = (temperature, top_p, top_k, scale, cfg)
        if key in self.functions:
            return self.functions[key]
        valid = self.model.vocab_size
        k = min(top_k, valid) if top_k else 0
        sampler = make_sampler(temp=temperature, top_p=top_p, top_k=0 if k == valid else k)

        def frame(first: mx.array, hidden: mx.array) -> mx.array:
            x, caches = self.initial(first, hidden)
            tokens = [first.reshape(1)]
            for head in range(self.model.num_codebooks - 1):
                scores = self.logits(x, head)
                if cfg:
                    scores = scores[1:2] + scale * (scores[:1] - scores[1:2])
                scores = self.model._mask_reserved_codec_logits(scores)[..., :valid]
                token = sampler(nn.log_softmax(scores, axis=-1)).astype(mx.int32).reshape(1)
                tokens.append(token)
                if head + 1 < self.model.num_codebooks - 1:
                    x = self.advance(token, head + 1, caches, hidden.shape[0])
            return mx.concatenate(tokens)

        fn = mx.compile(frame, inputs=mx.random.state, outputs=mx.random.state) if self.compiled else frame
        self.functions[key] = fn
        return fn

    def generate(self, first_codebook: int, conditional_hidden: mx.array, *,
                 unconditional_hidden: mx.array | None, cfg_scale: float,
                 temperature: float, top_p: float, top_k: int) -> list[int]:
        if conditional_hidden.shape[0] != 1:
            raise ValueError("Cached Breeze supports one utterance at a time")
        if temperature < 0 or not 0 <= top_p <= 1 or top_k < 0:
            raise ValueError("Invalid sampling settings")
        hidden = conditional_hidden
        if unconditional_hidden is not None:
            hidden = mx.concatenate((hidden, unconditional_hidden), axis=0)
        fn = self.function(temperature, top_p, top_k, cfg_scale, unconditional_hidden is not None)
        return fn(mx.array([first_codebook], dtype=mx.int32), hidden).tolist()

    def verify(self) -> float:
        """Compare every head and CFG batching with a reproducible native-precision probe.

        An explicit key keeps initialization independent of prior random operations
        and leaves generation sampling untouched. The original tolerance is retained.
        """
        worst = 0.0
        m = self.model.depth_decoder.model
        for batch in (1, 2):
            hidden = mx.random.normal((batch, m.backbone_hidden_size), key=mx.random.key(42)).astype(
                self.model.depth_decoder.codebooks_head.weight.dtype)
            ids = [(3 + 17 * j) % self.model.vocab_size for j in range(self.model.num_codebooks)]
            x, caches = self.initial(mx.array([ids[0]], dtype=mx.int32), hidden)
            for head in range(self.model.num_codebooks - 1):
                expected = mx.concatenate([self.model.depth_decoder.next_logits(
                    mx.array([[0] + ids[:head + 1]], dtype=mx.int32), hidden[i:i + 1])
                    for i in range(batch)]).astype(mx.float32)
                actual = self.logits(x, head).astype(mx.float32)
                error = float(mx.max(mx.abs(actual - expected)).item())
                scale = max(float(mx.max(mx.abs(expected)).item()), 1e-6)
                worst = max(worst, error / scale)
                if not bool(mx.all(mx.isfinite(actual)).item()) or error > 0.03 * scale + 1e-4:
                    raise ValueError(f"Cached decoder verification failed: head={head}, batch={batch}, error={error}")
                if head + 1 < self.model.num_codebooks - 1:
                    x = self.advance(mx.array([ids[head + 1]], dtype=mx.int32), head + 1, caches, batch)
        return worst


def install(model: Model, *, compiled: bool = True) -> FastDepth:
    """Override only this model instance; leave installed MLX files unchanged."""
    engine = FastDepth(model, compiled=compiled)

    class CachedModel(type(model)):
        def _depth_tokens(self, first_codebook: int, conditional_hidden: mx.array, *,
                          unconditional_hidden: mx.array | None, cfg_scale: float,
                          temperature: float, top_p: float, top_k: int) -> list[int]:
            return engine.generate(first_codebook, conditional_hidden,
                unconditional_hidden=unconditional_hidden, cfg_scale=cfg_scale,
                temperature=temperature, top_p=top_p, top_k=top_k)

    model.__class__ = CachedModel
    return engine
