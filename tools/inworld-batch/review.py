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
import subprocess
from typing import Optional, TypedDict

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
    renderingContext: dict[str, object] | None
    comparisonExpected: str


Transcriber = Callable[[Path, str], str]
ContextLoader = Callable[[Path, ReviewItem, str], Optional[dict[str, object]]]
SPOKEN_PLUS_POLICY = 'spoken-plus-v1'
COMBINING_OVERLAY_POLICY = 'combining-overlay-v1'
SOURCE_NOTATION_POLICY = 'source-numeric-notation-v1'
NOTATION_COMPARISON_POLICY = 'numeric-symbols-v1'
# Only synthesis markup that we actually emit is non-spoken. In particular,
# '< 12s ... > 3s' is source content, never an HTML tag.
SYNTHESIS_TAG = re.compile(r'''<break\s+time=(["'])\+?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)\1\s*/>''', re.IGNORECASE)
UNARY_MINUS = re.compile(r'(^|[\s<>=≤≥(\[{:])[-−](?=\d)')


def has_numeric_symbols(text: str) -> bool:
    visible = SYNTHESIS_TAG.sub(' ', text)
    return bool(re.search(r'[<>=≤≥°%]|\d[A-Za-z]|[A-Za-z]\d', visible) or UNARY_MINUS.search(visible))


def symbol_text(text: str) -> str:
    text = SYNTHESIS_TAG.sub(' ', text)
    text = UNARY_MINUS.sub(r'\1 minus ', text)
    text = re.sub(r'°\s*C\b', ' degrees Celsius ', text)
    text = re.sub(r'°\s*F\b', ' degrees Fahrenheit ', text)
    text = re.sub(r'\bdegree\s+(celsius|fahrenheit)\b', r'degrees \1', text, flags=re.IGNORECASE)
    text = text.replace('<=', ' less than or equal to ').replace('>=', ' greater than or equal to ')
    text = text.replace('≤', ' less than or equal to ').replace('≥', ' greater than or equal to ')
    return text.replace('<', ' less than ').replace('>', ' greater than ').replace('=', ' equals ').replace('%', ' percent ').replace('°', ' degrees ')


def visible_base_text(text: str) -> str:
    # Exact parity with spoken-overlays.ts; no other accents/symbols change.
    return re.sub(r'[\u0334-\u0338]+', '', text)


def words(text: str) -> list[str]:
    text = visible_base_text(symbol_text(text)).lower().replace('’', "'")
    # A grade qualifier and an arithmetic operator are audible source content.
    # Keep each symbol, including repeated operators, rather than treating it
    # as punctuation and accidentally approving an omitted qualifier.
    text = text.replace('+', ' plus ')
    # Adjacent units remain their literal letters; do not glue the number's
    # final word to the unit or invent an abbreviation expansion.
    text = re.sub(r'\d[\d,]*(?:\.\d+)?', lambda m: ' ' + number(m[0]) + ' ', text)
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
    # Aggregate recall cannot excuse one missing comparator, decimal point or
    # temperature unit. These checks only escalate; independent full-content
    # review still decides fidelity from the bound ASR/phoneme evidence.
    semantic_mismatch = has_numeric_symbols(expected) and a != b
    return {'wordRecall': recall, 'changes': changes, 'major': major,
            'needsStronger': semantic_mismatch or recall < 0.90 or any(c['kind'] != 'replace' for c in changes)}


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


def requires_dual_asr(context: dict[str, object] | None) -> bool:
    if context is None:
        return False
    proof = context.get('renderingProof')
    return bool(context.get('offlinePCMExcision')) or (isinstance(proof, dict) and proof.get('policy') in (COMBINING_OVERLAY_POLICY, SOURCE_NOTATION_POLICY))


def cached_attempts(path: Path, digest: str, expected: str, models: list[str], comparison_expected: str, context: dict[str, object] | None) -> list[dict[str, object]]:
    if not path.exists():
        return []
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or state.get('sha256') != digest or state.get('expected') != expected or state.get('models') != models or state.get('renderingContext') != context:
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
        metrics = compare(comparison_expected, transcript)
        # A surgical offline edit needs both whole-passage recognizers, even
        # when the first recognizer reports an exact match.
        if index == 0 and requires_dual_asr(context):
            metrics['needsStronger'] = True
        attempts.append({'model': models[index], 'transcript': transcript, **metrics})
    return attempts


def rendering_context(root: Path, item: ReviewItem, digest: str) -> dict[str, object] | None:
    receipt_path = root / 'receipts' / (item['customId'] + '.json')
    if not receipt_path.exists():
        return None
    receipt = json.loads(receipt_path.read_text())
    if not isinstance(receipt, dict) or not receipt.get('renderingRecovery'):
        return None
    # One verifier shares the exact TypeScript rendering policy and validates all
    # retained plan/source/receipt/audio evidence. No caller-supplied comparison.
    result = subprocess.run(['node', str(Path(__file__).with_name('rendering-review.mjs')), str(root), item['customId']],
                            capture_output=True, text=True, check=False, timeout=30)
    if result.returncode != 0:
        raise ValueError('Visual-redaction rendering proof failed validation')
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get('audioSha256') != digest or not isinstance(value.get('comparisonExpected'), str):
        raise ValueError('Invalid visual-redaction comparison context')
    return value


def matching_report(report: object, digest: str, expected: str, context: dict[str, object] | None) -> bool:
    if not isinstance(report, dict) or report.get('sha256') != digest or report.get('expected') != expected:
        return False
    comparison_expected = str(context['comparisonExpected']) if context is not None else expected
    if '+' in comparison_expected and report.get('comparisonPolicy') != SPOKEN_PLUS_POLICY:
        return False
    if has_numeric_symbols(comparison_expected) and report.get('notationComparisonPolicy') != NOTATION_COMPARISON_POLICY:
        return False
    if visible_base_text(comparison_expected) != comparison_expected and report.get('overlayComparisonPolicy') != COMBINING_OVERLAY_POLICY:
        return False
    if context is None:
        return 'renderingContext' not in report and 'comparisonExpected' not in report
    if requires_dual_asr(context) and (not isinstance(report.get('attempts'), list)
                                            or len(report['attempts']) != 2):
        return False
    return report.get('renderingContext') == context and report.get('comparisonExpected') == context['comparisonExpected']


def review_items(root: Path, items: list[ReviewItem], models: list[str], transcribe: Transcriber, context_loader: ContextLoader = rendering_context) -> None:
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
        context = context_loader(root, item, digest)
        comparison_expected = str(context['comparisonExpected']) if context is not None else expected
        destination = out / (name + '.json')
        if destination.exists():
            prior = json.loads(destination.read_text())
            if matching_report(prior, digest, expected, context):
                continue
        pending.append({'item': item, 'audio': audio, 'sha256': digest,
                        'attempts': cached_attempts(checkpoints / (name + '.json'), digest, expected, models, comparison_expected, context),
                        'renderingContext': context, 'comparisonExpected': comparison_expected})

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
            metrics = compare(entry['comparisonExpected'], transcript)
            if index == 0 and requires_dual_asr(entry['renderingContext']):
                metrics['needsStronger'] = True
            attempts.append({'model': model, 'transcript': transcript, **metrics})
            save_json(checkpoints / (item['customId'] + '.json'),
                      {'sha256': entry['sha256'], 'expected': item['spokenText'], 'models': models, 'attempts': attempts, 'renderingContext': entry['renderingContext']})
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
                if not matching_report(prior, entry['sha256'], entry['item']['spokenText'], entry['renderingContext']):
                    finish_review(out, entry)


def finish_review(out: Path, entry: PendingReview) -> None:
    attempts = entry['attempts']
    final = attempts[-1]
    report = {'sha256': entry['sha256'], 'expected': entry['item']['spokenText'], 'attempts': attempts,
              'severity': 'major' if final['major'] else 'minor' if final['changes'] else 'pass',
              'limitation': 'Automated ASR is fallible; it does not verify subjective acting or voice identity.'}
    if '+' in entry['comparisonExpected']:
        report['comparisonPolicy'] = SPOKEN_PLUS_POLICY
    if has_numeric_symbols(entry['comparisonExpected']):
        report['notationComparisonPolicy'] = NOTATION_COMPARISON_POLICY
    if visible_base_text(entry['comparisonExpected']) != entry['comparisonExpected']:
        report['overlayComparisonPolicy'] = COMBINING_OVERLAY_POLICY
    if entry['renderingContext'] is not None:
        report['comparisonExpected'] = entry['comparisonExpected']
        report['renderingContext'] = entry['renderingContext']
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
