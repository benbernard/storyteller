"""Reuse the reviewed audiobook notation rules without calling a provider."""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mac-tts' / 'acting-auditions'))
from speech_parts import speakable_text  # noqa: E402


def normalize(text: str) -> str:
    text = re.sub(r'(?m)^\s*[*_\-=]{3,}\s*$', '<break time="900ms" />', text)
    text = speakable_text(text).replace('**', '')
    return text.strip()


def main() -> None:
    values: list[str] = json.load(sys.stdin)
    if not all(isinstance(value, str) for value in values):
        raise ValueError('Expected text array')
    print(json.dumps([normalize(value) for value in values]))


if __name__ == '__main__':
    main()
