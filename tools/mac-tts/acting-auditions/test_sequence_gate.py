"""The chapter queue cannot advance past missing or mismatched publication proof."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from sequence_gate import verify_sequence_gate


class SequenceGateTests(unittest.TestCase):
    def test_generation_ahead_is_separate_from_publication_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'sequence-gate.json'
            path.write_text(json.dumps({'mode': 'generation-ahead'}))
            with self.assertRaisesRegex(ValueError, 'owner instruction'):
                verify_sequence_gate(root)
            path.write_text(json.dumps({'mode': 'generation-ahead',
                                       'ownerInstruction': 'Generate ahead; assemble minor issues and fix later.'}))
            verify_sequence_gate(root)
            self.assertFalse((root / 'publication-verified.json').exists())

    def test_publication_is_required_and_bound_to_previous_chapter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = root / 'previous'
            before.mkdir()
            (root / 'sequence-gate.json').write_text(json.dumps({
                'previousTrialDirectory': str(before), 'previousChapterId': 'chapter-78'}))
            with self.assertRaisesRegex(ValueError, 'not passed review'):
                verify_sequence_gate(root)
            verified = {'edition': 'breeze', 'verifiedAt': '2026-10-13',
                        'chapter': {'id': 'chapter-78', 'checksum': 'abc'},
                        'checksum': 'wrong', 'textStatus': 200, 'rangeStatus': 206}
            marker = before / 'publication-verified.json'
            marker.write_text(json.dumps(verified))
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                verify_sequence_gate(root)
            verified['checksum'] = 'abc'
            marker.write_text(json.dumps(verified))
            verify_sequence_gate(root)
            verified['chapter']['id'] = 'chapter-79'
            marker.write_text(json.dumps(verified))
            with self.assertRaisesRegex(ValueError, 'does not match'):
                verify_sequence_gate(root)


if __name__ == '__main__':
    unittest.main()
