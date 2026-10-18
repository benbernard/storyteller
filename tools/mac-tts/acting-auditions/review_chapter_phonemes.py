#!/usr/bin/env python3
"""Record independent CPU phoneme evidence for selected trial recordings."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from typing import TypedDict

from render_chapter import digest, save
from review_chapter_context import requested_indices

MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft"
REVISION = "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4"


class PhonemeRecord(TypedDict):
    index: str
    audioSha256: str
    receiptSha256: str
    model: str
    revision: str
    inputPrompt: None
    phonemes: str


def main() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    root = Path(sys.argv[1])
    indices = requested_indices(json.loads((root / "context-review-request.json").read_text()))
    destination = root / "phoneme-review"
    destination.mkdir(exist_ok=True)
    processor = None
    model = None
    torch.set_num_threads(4)
    for index in indices:
        receipt_path = root / "segments" / (index + ".json")
        audio_path = receipt_path.with_suffix(".wav")
        receipt: dict[str, object] = json.loads(receipt_path.read_text())
        audio_hash, receipt_hash = digest(audio_path), digest(receipt_path)
        if audio_hash != receipt.get("sha256"):
            raise ValueError("Phoneme input does not match receipt")
        output = destination / (index + ".json")
        if output.exists():
            previous: dict[str, object] = json.loads(output.read_text())
            if (previous.get("audioSha256") == audio_hash and previous.get("receiptSha256") == receipt_hash
                    and previous.get("revision") == REVISION):
                continue
            history = destination / "history"
            history.mkdir(exist_ok=True)
            output.rename(history / (index + "-" + digest(output) + ".json"))
        if model is None:
            processor = Wav2Vec2Processor.from_pretrained(MODEL, revision=REVISION, do_phonemize=False,
                                                        local_files_only=True)
            model = Wav2Vec2ForCTC.from_pretrained(MODEL, revision=REVISION, local_files_only=True).to("cpu").eval()
        audio, rate = sf.read(audio_path, dtype="float32")
        if rate != 24000 or audio.ndim != 1:
            raise ValueError("Expected mono 24 kHz phoneme input")
        if processor is None:
            raise ValueError("Phoneme processor missing")
        values = processor(resample_poly(audio, 16000, rate), return_tensors="pt", sampling_rate=16000).input_values
        with torch.no_grad():
            tokens = model(values).logits.argmax(dim=-1)
        phonemes: str = processor.batch_decode(tokens)[0]
        record: PhonemeRecord = {"index": index, "audioSha256": audio_hash, "receiptSha256": receipt_hash,
                                "model": MODEL, "revision": REVISION, "inputPrompt": None, "phonemes": phonemes}
        save(output, record)
        print(index, "phoneme evidence recorded", flush=True)


if __name__ == "__main__":
    main()
