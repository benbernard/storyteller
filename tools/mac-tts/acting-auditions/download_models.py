#!/usr/bin/env python3
"""Download public model revisions used by the Breeze renderer and reviewers."""
from __future__ import annotations

from huggingface_hub import snapshot_download

MODELS: tuple[tuple[str, str], ...] = (
    ("mlx-community/Breeze-TTS-2-mlx", "3c8829fb7fd335818f085cd2ef49b4100c0e46c8"),
    ("mlx-community/whisper-small-mlx", "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"),
    ("mlx-community/whisper-large-v3-turbo", "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"),
    ("facebook/wav2vec2-lv-60-espeak-cv-ft", "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4"),
)


def main() -> None:
    for repo, revision in MODELS:
        print(f"Downloading {repo}@{revision}", flush=True)
        snapshot_download(repo, revision=revision)


if __name__ == "__main__":
    main()
