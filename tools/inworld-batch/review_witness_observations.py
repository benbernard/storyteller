"""Compare retained transcripts only; never run inference or decide fidelity."""
from __future__ import annotations

import difflib
import json
import re
import sys

from review import words


def observations(value: dict[str, object]) -> dict[str, object]:
    expected, literal = value.get("expected"), value.get("literal")
    transcripts = value.get("transcripts")
    if not isinstance(expected, str) or not isinstance(literal, str) or not re.fullmatch(r"[A-Za-z]{2}-[A-Za-z]{7}", literal):
        raise ValueError("Unsupported source prefix")
    if not isinstance(transcripts, list) or len(transcripts) != 2 or not all(isinstance(text, str) for text in transcripts):
        raise ValueError("Two retained transcripts required")
    a = words(expected)
    rows: list[dict[str, object]] = []
    for transcript in transcripts:
        b = words(transcript)
        changes = [(op, a[start:end], b[heard_start:heard_end]) for op, start, end, heard_start, heard_end
                   in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op != "equal"]
        if len(changes) != 1:
            raise ValueError("Focused evidence contains additional word differences")
        op, before, after = changes[0]
        if op != "replace" or before != [literal[:2].lower()] or len(after) != 2 or not all(re.fullmatch(r"[a-z]{1,3}", token) for token in after):
            raise ValueError("Focused evidence is not an isolated source-prefix observation")
        rows.append({"operation": op, "expected": before, "heard": after, "otherNormalizedTokensIdentical": True})
    return {"policy": "isolated-prefix-observation-v1", "rows": rows,
            "literalPronunciationContractEstablished": False, "automaticAcceptance": False}


def main() -> None:
    value: object = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("Invalid observation input")
    print(json.dumps(observations(value)))


if __name__ == "__main__":
    main()
