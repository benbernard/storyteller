"""Bounded local text inference in the same exclusive worker as speech."""

from __future__ import annotations

import time

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject
    from pathlib import Path


class TextAdapter:
    def __init__(self, path: str | Path) -> None:
        import mlx.core as mx
        from mlx_lm import load

        mx.set_memory_limit(24 * 1024**3)
        mx.set_cache_limit(512 * 1024**2)
        self.model, self.tokenizer = load(
            path, tokenizer_config={"trust_remote_code": False}
        )

    def generate(self, options: JsonObject) -> JsonObject:
        import mlx.core as mx
        from mlx_lm import generate
        from mlx_lm.sample_utils import make_sampler

        mx.random.seed(options.get("seed", 810))
        prompt = self.tokenizer.apply_chat_template(
            [
                {"role": "system", "content": options["system"]},
                {"role": "user", "content": options["text"]},
            ],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        tokens = len(self.tokenizer.encode(prompt))
        maximum = options.get("max_tokens", 12000)
        if tokens + maximum > 32768:
            raise ValueError("Chapter analysis exceeds the pinned model context window")
        start = time.monotonic()
        text = generate(
            self.model,
            self.tokenizer,
            prompt=prompt,
            max_tokens=maximum,
            sampler=make_sampler(temp=options.get("temperature", 0.2)),
            verbose=False,
        )
        return {
            "text": text,
            "prompt_tokens": tokens,
            "generation_seconds": time.monotonic() - start,
            "model_revision": "ba63a5141812f9870287df53341123a71ba41433",
            "provider_credits": 0,
        }
