"""Require verified publication of the preceding chapter before rendering."""
from __future__ import annotations

import json
from pathlib import Path


def verify_sequence_gate(root: Path) -> None:
    gate_path = root / 'sequence-gate.json'
    if not gate_path.exists():
        return
    gate: dict[str, str] = json.loads(gate_path.read_text())
    if gate.get('mode') == 'generation-ahead':
        if not gate.get('ownerInstruction', '').strip():
            raise ValueError('Generation ahead requires a recorded owner instruction')
        return
    marker = Path(gate['previousTrialDirectory']) / 'publication-verified.json'
    if not marker.exists():
        raise ValueError('Previous chapter has not passed review and Listener publication verification')
    verified: dict[str, object] = json.loads(marker.read_text())
    chapter = verified.get('chapter')
    if not isinstance(chapter, dict) or chapter.get('id') != gate['previousChapterId']:
        raise ValueError('Sequence gate does not match the preceding chapter')
    if (verified.get('edition') != 'breeze' or not verified.get('verifiedAt')
            or verified.get('textStatus') != 200 or verified.get('rangeStatus') != 206
            or not chapter.get('checksum') or verified.get('checksum') != chapter.get('checksum')):
        raise ValueError('Previous chapter publication verification is incomplete')
