"""Numerical regression checks for cached depth decoding on small real MLX layers."""
from __future__ import annotations
import unittest
from unittest.mock import patch
import mlx.core as mx
import mlx.nn as nn
from mlx_audio.tts.models.breeze_tts.breeze_tts import Model, _DepthDecoder
from mlx_audio.tts.models.breeze_tts.config import ModelConfig
from breeze_fast import FastDepth


class CachedDepthTests(unittest.TestCase):
    def test_cached_logits_and_compiled_greedy_match_stock(self) -> None:
        config = ModelConfig(hidden_size=32, intermediate_size=64, num_hidden_layers=2,
            num_attention_heads=4, num_key_value_heads=2, head_dim=8, num_codebooks=4,
            vocab_size=35, codebook_pad_token_id=34,
            depth_decoder_config={"hidden_size": 32, "intermediate_size": 64,
                "num_hidden_layers": 2, "num_attention_heads": 4, "num_key_value_heads": 2,
                "head_dim": 8, "num_codebooks": 4, "vocab_size": 35})
        model = Model.__new__(Model)
        nn.Module.__init__(model)
        model.config = config
        model.depth_decoder = _DepthDecoder(config)
        model.num_codebooks = 4
        model.vocab_size = 32
        engine = FastDepth(model)
        mx.random.seed(701)
        expected_random = mx.random.normal((4,)).tolist()
        mx.random.seed(701)
        first_error = engine.verify()
        self.assertLess(first_error, 0.0001)
        self.assertEqual(mx.random.normal((4,)).tolist(), expected_random)
        mx.random.seed(903)
        self.assertEqual(engine.verify(), first_error)
        # Reproducibility must not hide a broken cached implementation.
        original_logits = engine.logits
        with patch.object(engine, "logits", side_effect=lambda x, head: original_logits(x, head) + 1):
            with self.assertRaisesRegex(ValueError, "Cached decoder verification failed"):
                engine.verify()
        for cfg in (False, True):
            hidden = mx.random.normal((1, 32))
            uncond = mx.random.normal((1, 32)) if cfg else None
            expected = model._depth_tokens(3, hidden, unconditional_hidden=uncond,
                cfg_scale=4.0, temperature=0.0, top_p=1.0, top_k=50)
            actual = engine.generate(3, hidden, unconditional_hidden=uncond,
                cfg_scale=4.0, temperature=0.0, top_p=1.0, top_k=50)
            self.assertEqual(actual, expected)
            mx.random.seed(42)
            stochastic = engine.generate(3, hidden, unconditional_hidden=uncond,
                cfg_scale=4.0, temperature=0.9, top_p=1.0, top_k=20)
            mx.random.seed(42)
            self.assertEqual(engine.generate(3, hidden, unconditional_hidden=uncond,
                cfg_scale=4.0, temperature=0.9, top_p=1.0, top_k=20), stochastic)
            self.assertTrue(all(0 <= token < model.vocab_size for token in stochastic))
            # New frame must not inherit the previous frame's cache.
            self.assertEqual(engine.generate(3, hidden, unconditional_hidden=uncond,
                cfg_scale=4.0, temperature=0.0, top_p=1.0, top_k=50), expected)


if __name__ == "__main__":
    unittest.main()
