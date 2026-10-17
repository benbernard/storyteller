"""Native prompt test: reference order and one unsplit user message."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch
import mlx.core as mx
from fish_adapter import build_prompt

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mlx_speech.models.fish_s2_pro.prompt import Conversation
    from mlx_speech.models.fish_s2_pro.tokenizer import FishS2Tokenizer

seen = []


def capture(
    self: Conversation, tokenizer: FishS2Tokenizer | None, count: int
) -> mx.array:
    seen.extend(self.messages)
    return mx.zeros((count + 1, 1))


runtime = SimpleNamespace(
    tokenizer=None,
    config=SimpleNamespace(audio_decoder_config=SimpleNamespace(num_codebooks=10)),
)
text = "<|speaker:1|>Hello.\n<|speaker:0|>Good morning."
with patch("fish_adapter.Conversation.encode_for_inference", capture):
    build_prompt(
        runtime,
        text,
        [
            (1, "First reference.", mx.ones((10, 2))),
            (0, "Second reference.", mx.full((10, 3), 2)),
        ],
    )
assert len(seen) == 3
assert seen[1].parts[0].text == text
assert (
    seen[0].parts[1].text
    == "<|speaker:1|>First reference.\n<|speaker:0|>Second reference."
)
assert seen[0].parts[3].codes.tolist()[0] == [1, 1, 2, 2, 2]
assert seen[2].modality == "voice" and not seen[2].add_im_end
print("Fish reference ordering and one-message prompt: passed")
