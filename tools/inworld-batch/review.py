"""CPU-only transcript checks, with stronger ASR for suspected content defects."""
from __future__ import annotations

import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mac-tts' / 'acting-auditions'))
from speech_parts import integer_words  # noqa: E402


def words(text: str) -> list[str]:
    text = re.sub(r'<[^>]*>', ' ', text).lower().replace('’', "'")
    text = re.sub(r'\d[\d,]*(?:\.\d+)?', lambda m: number(m[0]), text)
    text = re.sub(r'\b(?:[a-z]\s+){1,}[a-z]\b', lambda m: m[0].replace(' ', ''), text)
    return re.findall(r'[a-z]+', text)


def number(text: str) -> str:
    parts = text.replace(',', '').split('.')
    value = integer_words(int(parts[0]))
    if len(parts) > 1:
        value += ' point ' + ' '.join(integer_words(int(d)) for d in parts[1])
    return value


def compare(expected: str, actual: str) -> dict[str, object]:
    a, b = words(expected), words(actual)
    edits = difflib.SequenceMatcher(None, a, b, autojunk=False)
    changes = [{'kind': op, 'expected': ' '.join(a[start:end]), 'heard': ' '.join(b[heard_start:heard_end]),
                'missingWords': end-start, 'extraWords': heard_end-heard_start}
               for op, start, end, heard_start, heard_end in edits.get_opcodes() if op != 'equal']
    matched = sum(block.size for block in edits.get_matching_blocks())
    recall = matched / max(1, len(a))
    major = not b or recall < 0.65 or any(
        (c['kind'] in ('delete', 'insert') and max(int(c['missingWords']), int(c['extraWords'])) >= 5)
        or (c['kind'] == 'replace' and max(int(c['missingWords']), int(c['extraWords'])) >= 7)
        for c in changes)
    return {'wordRecall': recall, 'changes': changes, 'major': major,
            'needsStronger': recall < 0.90 or any(c['kind'] != 'replace' for c in changes)}


def main() -> None:
    import mlx.core as mx
    import mlx_whisper
    mx.set_default_device(mx.cpu)
    root = Path(sys.argv[1])
    inputs: dict[str, object] = json.loads((root / 'input.json').read_text())
    items = inputs['items']
    if not isinstance(items, list):
        raise ValueError('Invalid items')
    out = root / 'review'
    out.mkdir(exist_ok=True)
    models = [
        str(Path.home() / '.cache/huggingface/hub/models--mlx-community--whisper-small-mlx/snapshots/45f3915923c7a79a5a5b5a7d909d39aeb0e5630e'),
        str(Path.home() / '.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots/a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb'),
    ]
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('Invalid item')
        name, expected = item['customId'], item['spokenText']
        if not isinstance(name, str) or not isinstance(expected, str):
            raise ValueError('Invalid speech')
        audio = root / 'audio' / (name + '.wav')
        digest = hashlib.sha256(audio.read_bytes()).hexdigest()
        destination = out / (name + '.json')
        if destination.exists():
            prior: dict[str, object] = json.loads(destination.read_text())
            if prior.get('sha256') == digest and prior.get('expected') == expected:
                continue
        attempts: list[dict[str, object]] = []
        for model in models:
            result = mlx_whisper.transcribe(str(audio), path_or_hf_repo=model, language='en',
                verbose=None, temperature=0.0, condition_on_previous_text=False, fp16=False)
            transcript: object = result['text']
            if not isinstance(transcript, str):
                raise ValueError('Missing transcript')
            comparison = compare(expected, transcript)
            attempts.append({'model': model, 'transcript': transcript, **comparison})
            if not comparison['needsStronger']:
                break
        final = attempts[-1]
        report = {'sha256': digest, 'expected': expected, 'attempts': attempts,
                  'severity': 'major' if final['major'] else 'minor' if final['changes'] else 'pass',
                  'limitation': 'Automated ASR is fallible; it does not verify subjective acting or voice identity.'}
        temporary = destination.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, indent=2))
        temporary.replace(destination)
        print(name, report['severity'], flush=True)


if __name__ == '__main__':
    main()
