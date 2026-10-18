"""Collect independent CPU phonemes for disputed Inworld passages."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
from collections.abc import Mapping
from typing import TypedDict

MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft"
REVISION = "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4"
# Public files at the pinned revision, verified against its Git/LFS objects.
MODEL_SHA256: dict[str, str] = {
    "config.json": "4609fb49b7e1d28aecb2840da1926c40bd915bc6f1120a940afacf7159bbfb13",
    "preprocessor_config.json": "a2254a5b58f72cd4de3632f8eee64f3f098b7c1402128d2f419e7d00ae13e335",
    "pytorch_model.bin": "3173bde9e9ce490fa0f989e413c42f25bc1820c020adc1e6b9b87025b3cfcc5e",
    "special_tokens_map.json": "bb7068de1150661a10b55f9e4b12a0e77af8bf91f5e45e1b58afaf1d0e17f675",
    "tokenizer_config.json": "1273ec458332cc55226ec596904bae811420755ace7e5d69462b61c4f480b457",
    "vocab.json": "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0",
}


def verify_model_snapshot(snapshot: Path, checksums: Mapping[str, str] = MODEL_SHA256) -> Path:
    if snapshot.name != REVISION:
        raise ValueError("Phoneme snapshot must use the exact pinned revision")
    if snapshot.is_dir() and any(path.name not in {*checksums, "README.md", ".gitattributes"}
                                 for path in snapshot.iterdir()):
        raise ValueError("Pinned phoneme snapshot contains unverified extra files")
    for name, expected in checksums.items():
        path = snapshot / name
        if not path.is_file():
            raise ValueError("Pinned phoneme snapshot is incomplete: " + name)
        hasher = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
        if hasher.hexdigest() != expected:
            raise ValueError("Pinned phoneme snapshot checksum differs: " + name)
    return snapshot.resolve()


def model_snapshot(environment: Mapping[str, str] | None = None, home: Path | None = None,
                   checksums: Mapping[str, str] = MODEL_SHA256) -> Path:
    """Find an exact complete local snapshot without consulting Hub APIs or refs."""
    env = os.environ if environment is None else environment
    base = Path.home() if home is None else home
    explicit = env.get("STORYTELLER_PHONEME_SNAPSHOT")
    if explicit:
        return verify_model_snapshot(Path(explicit).expanduser(), checksums)
    roots = [Path(env[key]).expanduser() for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE")
             if env.get(key)]
    if env.get("HF_HOME"):
        roots.append(Path(env["HF_HOME"]).expanduser() / "hub")
    if env.get("XDG_CACHE_HOME"):
        roots.append(Path(env["XDG_CACHE_HOME"]).expanduser() / "huggingface/hub")
    roots.append(base / ".cache/huggingface/hub")
    roots.append(Path(env.get("MAC_TTS_HOME", str(base / ".local/share/mac-tts"))).expanduser()
                 / "cache/huggingface/hub")
    for root in dict.fromkeys(roots):
        snapshot = root / ("models--" + MODEL.replace("/", "--")) / "snapshots" / REVISION
        try:
            return verify_model_snapshot(snapshot, checksums)
        except ValueError:
            continue
    raise FileNotFoundError("Exact pinned phoneme snapshot is missing, incomplete or corrupt. "
                            "Run phonemes.py --bootstrap-model in the configured phoneme Python environment.")


def bootstrap_model(cache: Path | None = None) -> Path:
    """Explicit setup only; normal phoneme collection never downloads a model."""
    from huggingface_hub import snapshot_download

    snapshot = snapshot_download(MODEL, revision=REVISION, token=False, allow_patterns=list(MODEL_SHA256),
                                 cache_dir=str(cache) if cache else None)
    return verify_model_snapshot(Path(snapshot))


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
            snapshot = str(model_snapshot())
            processor = Wav2Vec2Processor.from_pretrained(snapshot, do_phonemize=False,
                                                        local_files_only=True)
            model = Wav2Vec2ForCTC.from_pretrained(snapshot, local_files_only=True,
                                                  use_safetensors=False).to("cpu").eval()
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
    if len(sys.argv) > 1 and sys.argv[1] == "--bootstrap-model":
        print(bootstrap_model(Path(sys.argv[2]) if len(sys.argv) > 2 else None))
    elif len(sys.argv) > 1 and sys.argv[1] == "--check-model":
        print(json.dumps({"model": MODEL, "revision": REVISION, "snapshot": str(model_snapshot()),
                          "offline": True, "checksumsVerified": True}))
    else:
        main()
