"""Official FireRed dialogue on MPS, preserving generated-turn context."""

from __future__ import annotations

import re
import sys
import subprocess
from pathlib import Path
from unittest.mock import patch
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
import torch

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import FloatArray
    from collections.abc import Iterator
    from tts_typing import JsonObject
    from collections.abc import Mapping
    from typing import BinaryIO


class FireRedAdapter:
    def __init__(self, local: str | Path, root: str | Path) -> None:
        self.root = Path(root)
        source = self.root / "upstream/FireRedTTS2"
        revision = subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
        ).strip()
        if revision != "404f3f61d25bb4804859b588a6a734bf8468090c":
            raise RuntimeError("FireRed source revision differs from pinned setup")
        sys.path.insert(0, str(self.root / "upstream/FireRedTTS2"))
        from fireredtts2.fireredtts2 import FireRedTTS2

        if not torch.backends.mps.is_available():
            raise RuntimeError("MPS unavailable; no implicit fallback")
        load = torch.load

        def load_cpu(
            *args: str | Path | BinaryIO,
            **kwargs: str | bool | int | Mapping[str, str] | None,
        ) -> dict[str, torch.Tensor]:
            kwargs.setdefault("map_location", "cpu")
            return load(*args, **kwargs)

        with patch.object(torch, "load", load_cpu):
            self.model = FireRedTTS2(local, "dialogue", "mps", use_bf16=False)
        self.model.load_prompt_audio = self.read

    def read(self, path: str | Path) -> torch.Tensor:
        wave, rate = sf.read(path, dtype="float32")
        if wave.ndim > 1:
            wave = wave.mean(axis=1)
        if rate != 16000:
            wave = resample_poly(wave, 16000, rate)
        return torch.from_numpy(np.ascontiguousarray(wave)).unsqueeze(0)

    def generate(
        self, text: str, options: JsonObject, metrics: JsonObject
    ) -> Iterator[tuple[FloatArray, int, int]]:
        from fireredtts2.fireredtts2 import FireRedTTS2_Stream
        from fireredtts2.llm.utils import Segment

        refs = options.pop("references", [])
        stream = options.pop("stream", False)
        options.setdefault("max_audio_length_ms", 30000)
        context = []
        for ref in refs:
            speaker = "[S" + str(ref["speaker"]) + "]"
            context.append(
                self.model.prepare_prompt(
                    speaker + " " + ref["transcript"],
                    speaker,
                    str(self.root / "references" / (ref["reference_id"] + ".wav")),
                )
            )
        turns = [
            (m.group(1), m.group(2).strip())
            for m in re.finditer(r"(\[S[1-4]\])\s*(.*?)(?=\[S[1-4]\]|$)", text, re.S)
        ]
        if not turns:
            raise ValueError("Use [S1] through [S4] tags")
        with torch.inference_mode():
            for speaker, words in turns:
                args = dict(text=words, speaker=speaker, context=context, **options)
                chunks = []
                if stream:
                    for chunk in FireRedTTS2_Stream.generate(self.model, **args):
                        chunk = chunk.reshape(-1).cpu()
                        chunks.append(chunk)
                        yield chunk.numpy(), 24000, 0
                    audio = torch.cat(chunks)
                else:
                    audio = self.model.generate(**args).reshape(-1).cpu()
                    yield audio.numpy(), 24000, 0
                context.append(
                    Segment(
                        text=words,
                        speaker=speaker,
                        audio=torch.from_numpy(
                            resample_poly(audio.numpy(), 2, 3)
                        ).unsqueeze(0),
                    )
                )
        metrics.update(
            single_native_generation=False,
            context_retained_between_turns=True,
            turns=len(turns),
            stop_reason="backend does not report EOS; inspect transcript and per-turn duration cap",
        )
