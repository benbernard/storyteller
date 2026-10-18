"""Independent transcript checks with resumable model-grouped ASR passes."""
from __future__ import annotations

from collections.abc import Callable, Mapping
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mac-tts' / 'acting-auditions'))
from speech_parts import integer_words  # noqa: E402


class ReviewItem(TypedDict):
    customId: str
    spokenText: str


class PendingReview(TypedDict):
    item: ReviewItem
    audio: Path
    sha256: str
    attempts: list[dict[str, object]]


Transcriber = Callable[[Path, str], str]


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


def review_device(environ: Mapping[str, str]) -> str:
    device = environ.get('INWORLD_REVIEW_DEVICE', 'cpu')
    if device not in ('cpu', 'gpu'):
        raise ValueError('INWORLD_REVIEW_DEVICE must be cpu or gpu')
    # The caller must acquire and renew the shared GPU lease for our lifetime.
    # This marker is an explicit wrapper contract, not a lease acquisition.
    if device == 'gpu' and environ.get('INWORLD_REVIEW_GPU_LEASE') != '1':
        raise ValueError('GPU review requires the lease-owning wrapper')
    return device


def save_json(path: Path, value: object) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def cached_attempts(path: Path, digest: str, expected: str, models: list[str]) -> list[dict[str, object]]:
    if not path.exists():
        return []
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or state.get('sha256') != digest or state.get('expected') != expected or state.get('models') != models:
        return []
    saved = state.get('attempts')
    if not isinstance(saved, list) or not 1 <= len(saved) <= len(models):
        return []
    attempts: list[dict[str, object]] = []
    for index, attempt in enumerate(saved):
        if not isinstance(attempt, dict) or attempt.get('model') != models[index] or not isinstance(attempt.get('transcript'), str):
            return []
        if attempts and not attempts[-1]['needsStronger']:
            return []
        transcript = attempt['transcript']
        attempts.append({'model': models[index], 'transcript': transcript, **compare(expected, transcript)})
    return attempts


def review_items(root: Path, items: list[ReviewItem], models: list[str], transcribe: Transcriber) -> None:
    if len(models) != 2:
        raise ValueError('Expected pinned small and stronger ASR models')
    out = root / 'review'
    checkpoints = root / 'review-checkpoints'
    out.mkdir(exist_ok=True)
    checkpoints.mkdir(exist_ok=True)
    pending: list[PendingReview] = []
    for item in items:
        name, expected = item['customId'], item['spokenText']
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
            raise ValueError('Invalid passage ID')
        audio = root / 'audio' / (name + '.wav')
        digest = hashlib.sha256(audio.read_bytes()).hexdigest()
        destination = out / (name + '.json')
        if destination.exists():
            prior = json.loads(destination.read_text())
            if isinstance(prior, dict) and prior.get('sha256') == digest and prior.get('expected') == expected:
                continue
        pending.append({'item': item, 'audio': audio, 'sha256': digest,
                        'attempts': cached_attempts(checkpoints / (name + '.json'), digest, expected, models)})

    # mlx_whisper caches only the most recently used model. Grouping all small
    # checks before stronger checks avoids reloading weights for every escalation.
    for index, model in enumerate(models):
        for entry in pending:
            item, attempts = entry['item'], entry['attempts']
            if len(attempts) > index or (attempts and not attempts[-1]['needsStronger']):
                continue
            if len(attempts) != index:
                raise ValueError('Incomplete ASR checkpoint sequence')
            transcript = transcribe(entry['audio'], model)
            if not isinstance(transcript, str):
                raise ValueError('Missing transcript')
            if hashlib.sha256(entry['audio'].read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError('Audio changed during independent review')
            attempts.append({'model': model, 'transcript': transcript, **compare(item['spokenText'], transcript)})
            save_json(checkpoints / (item['customId'] + '.json'),
                      {'sha256': entry['sha256'], 'expected': item['spokenText'], 'models': models, 'attempts': attempts})
            if not attempts[-1]['needsStronger'] or index == len(models) - 1:
                finish_review(out, entry)

    # An interruption after checkpointing but before publishing the final report
    # must resume without another inference call.
    for entry in pending:
        attempts = entry['attempts']
        if attempts and (not attempts[-1]['needsStronger'] or len(attempts) == len(models)):
            destination = out / (entry['item']['customId'] + '.json')
            if not destination.exists():
                finish_review(out, entry)
            else:
                prior = json.loads(destination.read_text())
                if prior.get('sha256') != entry['sha256'] or prior.get('expected') != entry['item']['spokenText']:
                    finish_review(out, entry)


def finish_review(out: Path, entry: PendingReview) -> None:
    attempts = entry['attempts']
    final = attempts[-1]
    report = {'sha256': entry['sha256'], 'expected': entry['item']['spokenText'], 'attempts': attempts,
              'severity': 'major' if final['major'] else 'minor' if final['changes'] else 'pass',
              'limitation': 'Automated ASR is fallible; it does not verify subjective acting or voice identity.'}
    save_json(out / (entry['item']['customId'] + '.json'), report)
    print(entry['item']['customId'], report['severity'], flush=True)


def main() -> None:
    device = review_device(os.environ)
    import mlx.core as mx
    import mlx_whisper
    mx.set_default_device(mx.gpu if device == 'gpu' else mx.cpu)
    if device == 'gpu':
        mx.set_memory_limit(6 * 1024**3)
        mx.set_cache_limit(128 * 1024**2)
    root = Path(sys.argv[1])
    inputs = json.loads((root / 'input.json').read_text())
    values = inputs.get('items') if isinstance(inputs, dict) else None
    if not isinstance(values, list):
        raise ValueError('Invalid items')
    items: list[ReviewItem] = []
    for item in values:
        if not isinstance(item, dict) or not isinstance(item.get('customId'), str) or not isinstance(item.get('spokenText'), str):
            raise ValueError('Invalid speech')
        items.append({'customId': item['customId'], 'spokenText': item['spokenText']})
    models = [
        str(Path.home() / '.cache/huggingface/hub/models--mlx-community--whisper-small-mlx/snapshots/45f3915923c7a79a5a5b5a7d909d39aeb0e5630e'),
        str(Path.home() / '.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots/a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb'),
    ]

    def transcribe(audio: Path, model: str) -> str:
        result = mlx_whisper.transcribe(str(audio), path_or_hf_repo=model, language='en',
            verbose=None, temperature=0.0, condition_on_previous_text=False, fp16=False)
        transcript = result['text']
        if not isinstance(transcript, str):
            raise ValueError('Missing transcript')
        return transcript

    review_items(root, items, models, transcribe)


if __name__ == '__main__':
    main()
