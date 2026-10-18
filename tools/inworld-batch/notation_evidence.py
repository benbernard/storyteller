"""Model-free classification of already collected, independently bound evidence."""
from __future__ import annotations

import difflib
import itertools
import hashlib
import json
import re
import sys

from review import words

LETTERS = {'a': 'eɪ', 'b': 'bi', 'c': 'si', 'd': 'di', 'e': 'i', 'f': 'ɛf', 'g': 'dʒi', 'h': 'eɪtʃ',
           'i': 'aɪ', 'j': 'dʒeɪ', 'k': 'keɪ', 'l': 'ɛl', 'm': 'ɛm', 'n': 'ɛn', 'o': 'oʊ', 'p': 'pi',
           'q': 'kju', 'r': 'ɑɹ', 's': 'ɛs', 't': 'ti', 'u': 'ju', 'v': 'vi', 'w': 'dʌbəlju', 'x': 'ɛks', 'y': 'waɪ', 'z': 'zi'}


def tokens(text: str, source: str) -> list[str]:
    result: list[str] = []
    for token in words(text):
        # These are comparison aliases, never modifications of spoken input.
        if token == 'h' and re.search(r'\d+h\b', source):
            result.append('hours')
        elif token == 'avg' and re.search(r'\bavg\b', source, re.IGNORECASE):
            result.append('average')
        elif token == 'std' and re.search(r'\bstd\b', source, re.IGNORECASE):
            result.extend(['standard', 'deviation'])
        else:
            result.append(token)
    return result


def unit_observations(source: str, actual: str, offset: int) -> dict[str, bool]:
    literal = source[offset:offset + 8]
    if not re.fullmatch(r'[a-z]{4}/[a-z]{3}', literal):
        return {}
    numerator, denominator = literal.split('/')
    a, b = tokens(source, source), tokens(actual, source)
    before = len(tokens(source[:offset], source))
    if a[before:before + 2] != [numerator, denominator]:
        return {}
    outside = a[:before] + ['unitliteral'] + a[before + 2:]
    suffixes = {denominator}
    suffixes.update({'sec': ['second', 'seconds'], 'min': ['minute', 'minutes'],
                     'hrs': ['hour', 'hours'], 'lvl': ['level', 'levels'], 'day': ['days']}.get(denominator, []))
    observations: dict[str, bool] = {}
    for i in range(len(b) - 2):
        forms = [(b[i], 1)]
        if len(b[i]) == len(b[i + 1]) == 1:
            forms.append((b[i] + b[i + 1], 2))
        for short, width in forms:
            if len(short) != 2 or short not in {''.join(pair) for pair in itertools.combinations(numerator, 2)}:
                continue
            if i + width + 1 >= len(b) or b[i + width] != 'per' or b[i + width + 1] not in suffixes:
                continue
            observations[short] = b[:i] + ['unitliteral'] + b[i + width + 2:] == outside
    return observations


def validate_diagnosis(source: str, kind: str, small: str, strong: str, phonemes: str, unit_offset: int | None = None, old_tail_token_sha256: str | None = None) -> bool:
    if unit_offset is not None:
        try:
            encoded = source.encode('utf-16-le')
            if unit_offset < 0 or unit_offset * 2 > len(encoded):
                return False
            unit_offset = len(encoded[:unit_offset * 2].decode('utf-16-le'))
        except UnicodeDecodeError:
            return False
    compact = re.sub(r'[\sˈˌː:]', '', phonemes).replace('ɹ', 'r')
    comparator_count = source.count('<')
    phone_comparators = len(re.findall(r'l[ɛeæ]sð[əæaɛɐ]n', compact))
    a = tokens(source, source)
    if kind == 'missing-comparator':
        if comparator_count != 1 or phone_comparators != 0:
            return False
        for transcript in [small, strong]:
            b = tokens(transcript, source)
            changed = [(op, a[start:end], b[heard_start:heard_end]) for op, start, end, heard_start, heard_end
                       in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op != 'equal']
            if changed != [('delete', ['less', 'than'], [])]:
                return False
        return True
    if kind == 'verified-reuse':
        return comparator_count > 0 and phone_comparators == comparator_count and tokens(strong, source) == a and all(
            len(re.findall(r'\bless\s+than\b', transcript, re.IGNORECASE)) == comparator_count for transcript in [small, strong])
    if kind == 'misread-celsius':
        count = len(re.findall(r'°C\b', source))
        if count == 0 or compact.count('sidʒisi') != count:
            return False
        last_unit = max(i for i, token in enumerate(a) if token == 'celsius')
        for transcript in [small, strong]:
            if len(re.findall(r'\bc[\s.]*g[\s.]*c\b', transcript, re.IGNORECASE)) != count:
                return False
            b = tokens(re.sub(r'\bc[\s.]*g[\s.]*c\b', 'degrees Celsius', transcript, flags=re.IGNORECASE), source)
            changes = [(op, start, end, b[heard_start:heard_end]) for op, start, end, heard_start, heard_end
                       in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op != 'equal']
            if old_tail_token_sha256 is None:
                if changes:
                    return False
            else:
                # This records an unresolved OLD recording defect; it is never a
                # comparison alias or permission to accept it in replacement QA.
                if len(changes) != 1:
                    return False
                op, start, end, heard = changes[0]
                if op != 'insert' or start != end or start <= last_unit or len(heard) != 1:
                    return False
                token = heard[0]
                if token not in {'to', 'of', 'in', 'at', 'by', 'on', 'as', 'or', 'an', 'if', 'so', 'be', 'is', 'it', 'do', 'up', 'no', 'we', 'he', 'me', 'us'}:
                    return False
                if hashlib.sha256(token.encode('utf-8')).hexdigest() != old_tail_token_sha256:
                    return False
        return True
    if kind == 'truncated-literal-unit' and unit_offset is not None:
        first, second = unit_observations(source, small, unit_offset), unit_observations(source, strong, unit_offset)
        candidates = set(first).intersection(second)
        if len(candidates) != 1:
            return False
        short = next(iter(candidates))
        sounds = ''.join(LETTERS[letter] for letter in short).replace('ɹ', 'r')
        full = ''.join(LETTERS[letter] for letter in source[unit_offset:unit_offset + 4]).replace('ɹ', 'r')
        # An uncorroborated small-ASR lexical error cannot prove an omission.
        # The stronger recognizer must preserve every word outside this unit.
        return second[short] and sounds in compact and full not in compact
    return False


def main() -> None:
    value: object = json.load(sys.stdin)
    if not isinstance(value, dict) or not all(isinstance(value.get(key), str) for key in ['source', 'kind', 'small', 'strong', 'phonemes']):
        raise ValueError('Invalid notation evidence input')
    offset = value.get('unitOffset')
    if offset is not None and not isinstance(offset, int):
        raise ValueError('Invalid literal unit offset')
    tail_hash = value.get('oldTailTokenSha256')
    if tail_hash is not None and (not isinstance(tail_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', tail_hash)):
        raise ValueError('Invalid old ambiguity binding')
    valid = validate_diagnosis(value['source'], value['kind'], value['small'], value['strong'], value['phonemes'], offset, tail_hash)
    print(json.dumps({'valid': valid}))


if __name__ == '__main__':
    main()
