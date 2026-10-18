"""Keep source offsets while representing structural punctuation as a pause."""
from __future__ import annotations
from typing import Literal, TypedDict
import unicodedata


class SpeechPart(TypedDict):
    start: int
    end: int
    kind: Literal["speech", "url", "stat", "pause"]
    text: str


def has_spoken_content(text: str) -> bool:
    return any(c.isalnum() or unicodedata.category(c) in {"So", "Sc"} for c in text)


def speech_parts(text: str) -> list[SpeechPart]:
    parts: list[SpeechPart] = []
    cursor = 0
    start = 0
    for line in text.splitlines(keepends=True):
        end = cursor + len(line)
        if line.strip() and not has_spoken_content(line):
            if start < cursor:
                parts.append({"start": start, "end": cursor, "kind": "speech", "text": text[start:cursor]})
            parts.append({"start": cursor, "end": end, "kind": "pause", "text": line})
            start = end
        cursor = end
    if start < len(text):
        tail = text[start:]
        parts.append({"start": start, "end": len(text),
            "kind": "speech" if has_spoken_content(tail) else "pause", "text": tail})
    parts = isolate_layout(isolate_urls(isolate_profile_rows(parts)))
    if "".join(p["text"] for p in parts) != text:
        raise ValueError("Speech parts changed source text")
    return parts



def isolate_layout(parts: list[SpeechPart]) -> list[SpeechPart]:
    """Keep paragraphs and display-list rows separate without losing source ranges."""
    import re
    result: list[SpeechPart] = []
    for part in parts:
        if part['kind'] != 'speech':
            result.append(part)
            continue
        for match in re.finditer(r'.+?(?:\n[ \t]*\n|\Z)', part['text'], re.DOTALL):
            block = match[0]
            lines = block.splitlines(keepends=True) if re.search(r'(?m)^[ \t]*[⬥•▪●]\S', block) else [block]
            cursor = part['start'] + match.start()
            for line in lines:
                if not line.strip() and result:
                    result[-1]['text'] += line
                    result[-1]['end'] += len(line)
                else:
                    result.append({'start': cursor, 'end': cursor + len(line), 'kind': 'speech', 'text': line})
                cursor += len(line)
    return result


def isolate_profile_rows(parts: list[SpeechPart]) -> list[SpeechPart]:
    """Generate every displayed profile row explicitly, retaining source ranges."""
    import re
    result: list[SpeechPart] = []
    for part in parts:
        marker = re.search(r'(?m)^[^\n]{1,80}\bProfile:[ \t]*\n(?=\s*\[?Status & Attributes\]?:)', part['text'])
        if part['kind'] != 'speech' or marker is None:
            result.append(part)
            continue
        cursor = marker.start()
        if cursor:
            result.append({'start': part['start'], 'end': part['start'] + cursor,
                           'kind': 'speech', 'text': part['text'][:cursor]})
        for line in part['text'][cursor:].splitlines(keepends=True):
            row = line.strip()
            end = cursor + len(line)
            if not row:
                result[-1]['text'] += line
                result[-1]['end'] = part['start'] + end
            elif (cursor == marker.start() or row.startswith(('[Status & Attributes]', 'Status & Attributes'))
                  or re.search(r'\bLevel\s+\d', row)
                  or re.match(r'^[^:\n]{1,80}:.*(?:\d|TBD|None|Locked)', row)):
                result.append({'start': part['start'] + cursor, 'end': part['start'] + end,
                               'kind': 'stat', 'text': line})
            else:
                result.append({'start': part['start'] + cursor, 'end': part['end'],
                               'kind': 'speech', 'text': part['text'][cursor:]})
                break
            cursor = end
    return result


def isolate_urls(parts: list[SpeechPart]) -> list[SpeechPart]:
    """Keep dense URL spelling separate from neighboring natural-language speech."""
    import re
    result: list[SpeechPart] = []
    for part in parts:
        if part['kind'] != 'speech':
            result.append(part)
            continue
        start = 0
        for match in re.finditer(r'(?:https?://|www\.)[^\s<>]+', part['text']):
            end = match.start() + len(match[0].rstrip('.,!?)'))
            if match.start() > start:
                result.append({'start': part['start'] + start, 'end': part['start'] + match.start(),
                               'kind': 'speech', 'text': part['text'][start:match.start()]})
            result.append({'start': part['start'] + match.start(), 'end': part['start'] + end,
                           'kind': 'url', 'text': part['text'][match.start():end]})
            start = end
        if start < len(part['text']):
            result.append({'start': part['start'] + start, 'end': part['end'],
                           'kind': 'speech', 'text': part['text'][start:]})
    return result


def delivery_instruction(base: str, part: SpeechPart) -> str:
    if part['kind'] == 'stat':
        return base + ' Read this profile row exactly once. Clearly articulate its label and every supplied value, without introductions, repetitions or extra words.'
    if part['kind'] != 'url':
        return base
    return base + ' Read this English URL slowly and precisely. Speak the supplied letters, digits and punctuation clearly, preserving the voice and adding no words or sounds.'


def synthesis_text(part: SpeechPart) -> str:
    """Give profile notation a complete spoken sentence, without changing values."""
    import re
    if part['kind'] != 'stat':
        return speakable_text(part['text'])
    text = part['text'].replace('[?]', ', question mark, ')
    modifier = re.match(r'^([^:\n]{1,80}):\s*(.*?)\s*\(([+-]\d+(?:\.\d+)?%)\)(.*)$', text, re.DOTALL)
    if modifier:
        label, value, change, tail = modifier.groups()
        text = f'{label}: {value.replace("|", "and")} with a modifier of {change}. {tail}'
    text = speakable_text(text).replace('(', '. ').replace(')', '.')
    text = re.sub(r'\s*,\s*$', '', text.strip()).rstrip(':,. ') + '.'
    return re.sub(r'(?:\.\s*){2,}', '. ', text).strip()


def speakable_text(text: str) -> str:
    """Unwrap visual brackets and pronounce the standard POV heading explicitly."""
    import re
    # Dense combining-mark stacks are visual glitch lettering, not phonemes.
    # Keep ordinary combining accents and every original source character in the plan.
    text = re.sub(r'([^\W\d_])([\u0300-\u036f]{3,})', r'\1', text)
    text = re.sub(r'(?m)^(\s*)PoV\s*:', r'\1Point of view:', text).replace('[', '').replace(']', '')
    # Extreme letter stretching confuses the speech tokenizer. Keep the word,
    # and leave its drawn-out delivery to the reviewed acting direction.
    if re.fullmatch(r'[\s“”"\']*[aA]{3,}[hH]{3,}[!?¿¡\s“”"\']*', text):
        text = re.sub(r'[aA]{3,}[hH]{3,}', 'Aah', text)
    text = re.sub(r'\b[^\W\d_]+\b',
                  lambda m: re.sub(r'(.)\1{3,}', r'\1', m[0], flags=re.IGNORECASE).capitalize()
                  if re.search(r'(.)\1{3,}', m[0], re.IGNORECASE) else m[0], text)
    text = re.sub(r'[?¿]{2,}', '?', text)
    text = re.sub(r'(?m)^[ \t]*[⬥•▪●][ \t]*', '', text)
    text = re.sub(r'(?<!\w)\*([A-Za-z][^*\n]*)\*(?!\w)', r'\1', text)
    text = re.sub(r'(?<=\w)~+(?=\d)', ' to ', text)
    text = re.sub(r'\b(1[0-2]|[1-9]):([0-5]\d)\s*(AM|PM)\b',
                  lambda m: integer_words(int(m[1])) + (' ' + integer_words(int(m[2])) if int(m[2]) else '')
                  + (' A M' if m[3] == 'AM' else ' P M'), text)
    text = re.sub(r'(?m)^(\s*)EDIT:', r'\1Edit:', text)
    text = re.sub(r'(?<!\S)w/e(?=$|[\s.,!?;:)\]])', 'whatever', text)
    # Breeze can suppress an elongated interjection joined by an em dash.
    # Standard spelling and a comma retain its voiced sound in synthesis input.
    text = re.sub(r'\b([Aa])h{2,}\b[—–-]\s*(?=\w)', r'\1h, ', text)
    # Parenthesized tier names are spoken content, not acting markup. Leave
    # numeric stat notation to its existing normalization below.
    text = re.sub(r'\(([A-Za-z][^()\n]*\+[^()\n]*)\)',
                  lambda m: ', ' + m[1].replace('+', ' plus ') + ', ', text)
    return spoken_notation(spoken_urls(text))


def spoken_urls(text: str) -> str:
    """Read an explicit URL's punctuation and identifier digits without losing them."""
    import re
    punctuation = {':': 'colon', '/': 'slash', '.': 'dot', '-': 'hyphen', '_': 'underscore',
                   '?': 'question mark', '=': 'equals', '&': 'ampersand', '%': 'percent', '#': 'hash'}

    def expand(match: re.Match[str]) -> str:
        url = match[0].rstrip('.,!?)')
        suffix = match[0][len(url):]
        url = re.sub(r'^https?', lambda m: ' '.join(m[0].upper()), url)
        url = re.sub(r'\bwww\b', 'W W W', url)
        url = re.sub(r'\d', lambda m: ' ' + integer_words(int(m[0])) + ' ', url)
        for mark, name in punctuation.items():
            url = url.replace(mark, ' ' + name + ' ')
        return re.sub(r'\s+', ' ', url).strip() + suffix

    return re.sub(r'(?:https?://|www\.)[^\s<>]+', expand, text)


def integer_words(value: int) -> str:
    if value < 0:
        raise ValueError("Number must be nonnegative")
    small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
        'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
    tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
    if value < 20:
        return small[value]
    if value < 100:
        return tens[value // 10] + (' ' + small[value % 10] if value % 10 else '')
    for scale, name in [(1_000_000_000, 'billion'), (1_000_000, 'million'), (1000, 'thousand'), (100, 'hundred')]:
        if value >= scale:
            return integer_words(value // scale) + ' ' + name + (' ' + integer_words(value % scale) if value % scale else '')
    raise ValueError('Invalid number')


def spoken_notation(text: str) -> str:
    """Expand mathematical display notation while retaining its exact values."""
    import re
    decimal = r'(?<![\w.])(\d+(?:,\d{3})*)\.(\d+)(?!\d|\.\d)'
    if not re.search(r'\bTBD\b|\d\s*\|\s*\d|\d\s*%|\d\s*->|\d+(?:\.\d+)?(?:s|lvl)\b|\d\s*/\s*\d', text) and not re.search(decimal + r'(?=[^\W\d_])', text):
        return text
    text = re.sub(r'\bTBD\b', 'to be determined', text)
    text = re.sub(r'(\d+(?:\.\d+)?)s/(\d+)lvl\b', r'\1 seconds per \2 levels', text)
    text = re.sub(r'(\d+)/(\d+)(?= for Minors\b)', r'\1 slash \2', text)
    text = re.sub(r'(\d+(?:\.\d+)?)\s*/\s*(\d+)', r'\1 out of \2', text)
    text = re.sub(r'(\d)(s|lvl)\b', lambda m: m[1] + (' seconds' if m[2] == 's' else ' levels'), text)
    text = text.replace('α', 'alpha ').replace('->', ' to ')
    text = re.sub(decimal, lambda m: integer_words(int(m[1].replace(',', ''))) + ' point ' + ' '.join(integer_words(int(d)) for d in m[2])
                  + (' ' if text[m.end():m.end() + 1].isalpha() else ''), text)
    text = re.sub(r'\b(\d+)[kK]\b', lambda m: integer_words(int(m[1]) * 1000), text)
    text = re.sub(r'\b\d+(?:,\d{3})*\b', lambda m: integer_words(int(m[0].replace(',', ''))), text)
    return text.replace('|', ', ').replace('+', ' plus ').replace('%', ' percent').replace('(', ', ').replace(')', ', ')
