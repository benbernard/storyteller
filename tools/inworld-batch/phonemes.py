"""Collect independent CPU phonemes for disputed Inworld passages."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
from typing import TypedDict

MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft"
REVISION = "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4"


class PhonemeRecord(TypedDict):
    audioSha256: str
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
    indices: list[str] = json.loads((root / "phoneme-request.json").read_text())
    if not all(isinstance(index, str) and index.replace("_", "").isalnum() for index in indices):
        raise ValueError("Invalid passage IDs")
    destination = root / "phoneme-review"
    destination.mkdir(exist_ok=True)
    processor = None
    model = None
    torch.set_num_threads(2)
    for index in indices:
        audio_path = root / "audio" / (index + ".wav")
        audio_hash = hashlib.sha256(audio_path.read_bytes()).hexdigest()
        output = destination / (index + ".json")
        if output.exists():
            previous: dict[str, object] = json.loads(output.read_text())
            if previous.get("audioSha256") == audio_hash and previous.get("revision") == REVISION:
                continue
        if model is None:
            processor = Wav2Vec2Processor.from_pretrained(MODEL, revision=REVISION, do_phonemize=False,
                                                        local_files_only=True)
            model = Wav2Vec2ForCTC.from_pretrained(MODEL, revision=REVISION, local_files_only=True).to("cpu").eval()
        audio, rate = sf.read(audio_path, dtype="float32")
        if audio.ndim != 1 or rate != 48000:
            raise ValueError("Expected mono 48 kHz Inworld audio")
        if processor is None:
            raise ValueError("Phoneme processor missing")
        values = processor(resample_poly(audio, 1, 3), return_tensors="pt", sampling_rate=16000).input_values
        with torch.no_grad():
            tokens = model(values).logits.argmax(dim=-1)
        record: PhonemeRecord = {"audioSha256": audio_hash, "revision": REVISION,
                                "inputPrompt": None, "phonemes": processor.batch_decode(tokens)[0]}
        temporary = output.with_suffix(".tmp")
        temporary.write_text(json.dumps(record) + "\n")
        temporary.replace(output)
        print(index, "phonemes recorded", flush=True)


if __name__ == "__main__":
    main()
