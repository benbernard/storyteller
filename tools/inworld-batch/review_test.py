"""Model-free regression tests for independent, resumable ASR scheduling."""
from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from typing import Optional
from unittest.mock import patch

from review import ReviewItem, compare, review_device, review_items, save_json


class ReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'audio').mkdir()
        self.models = ['pinned-small', 'pinned-large']
        self.items: list[ReviewItem] = [
            {'customId': 'first', 'spokenText': 'one two three four five six'},
            {'customId': 'second', 'spokenText': 'one two three four five six'},
            {'customId': 'third', 'spokenText': 'one two three four five six'},
        ]
        for item in self.items:
            (self.root / 'audio' / (item['customId'] + '.wav')).write_bytes(item['customId'].encode())
        self.calls: list[tuple[str, str]] = []

    def transcribe(self, audio: Path, model: str) -> str:
        self.calls.append((audio.stem, model))
        if audio.stem != 'second' and model == self.models[0]:
            return 'one'
        return self.items[0]['spokenText']

    def run_review(self) -> None:
        with redirect_stdout(StringIO()):
            review_items(self.root, self.items, self.models, self.transcribe)

    def read_report(self, name: str) -> dict[str, object]:
        return json.loads((self.root / 'review' / (name + '.json')).read_text())

    def test_groups_models_without_changing_evidence_or_schema(self) -> None:
        self.run_review()
        self.assertEqual(self.calls, [('first', 'pinned-small'), ('second', 'pinned-small'),
                                     ('third', 'pinned-small'), ('first', 'pinned-large'), ('third', 'pinned-large')])
        for item in self.items:
            report = self.read_report(item['customId'])
            self.assertEqual(set(report), {'sha256', 'expected', 'attempts', 'severity', 'limitation'})
            self.assertEqual(report['expected'], item['spokenText'])
            self.assertEqual(report['severity'], 'pass')
            for attempt in report['attempts']:
                self.assertEqual({key: attempt[key] for key in compare(item['spokenText'], attempt['transcript'])},
                                 compare(item['spokenText'], attempt['transcript']))

    def test_interrupted_stronger_pass_resumes_without_repeating_small_or_completed_large(self) -> None:
        def failing(audio: Path, model: str) -> str:
            if audio.stem == 'third' and model == 'pinned-large':
                raise RuntimeError('interrupted')
            return self.transcribe(audio, model)

        with redirect_stdout(StringIO()), self.assertRaisesRegex(RuntimeError, 'interrupted'):
            review_items(self.root, self.items, self.models, failing)
        self.assertTrue((self.root / 'review' / 'first.json').exists())
        self.assertTrue((self.root / 'review' / 'second.json').exists())
        self.assertFalse((self.root / 'review' / 'third.json').exists())
        self.calls.clear()
        self.run_review()
        self.assertEqual(self.calls, [('third', 'pinned-large')])
        self.assertEqual(self.read_report('third')['severity'], 'pass')

    def test_checkpoint_after_inference_before_report_survives_interruption(self) -> None:
        def fail_report(out: Path, entry: object) -> None:
            raise RuntimeError('report write interrupted')

        with patch('review.finish_review', fail_report), redirect_stdout(StringIO()), self.assertRaises(RuntimeError):
            review_items(self.root, [self.items[1]], self.models, self.transcribe)
        self.calls.clear()
        self.run_review()
        self.assertNotIn(('second', 'pinned-small'), self.calls)
        self.assertEqual(self.read_report('second')['severity'], 'pass')

    def test_audio_and_expected_change_invalidate_checkpoints_and_reports(self) -> None:
        self.run_review()
        (self.root / 'audio' / 'second.wav').write_bytes(b'changed-audio')
        self.items[0]['spokenText'] = 'changed source text'
        self.calls.clear()
        self.run_review()
        self.assertIn(('first', 'pinned-small'), self.calls)
        self.assertIn(('second', 'pinned-small'), self.calls)
        self.assertFalse(any(name == 'third' for name, _model in self.calls))
        self.assertEqual(self.read_report('second')['sha256'], hashlib.sha256(b'changed-audio').hexdigest())
        self.assertEqual(self.read_report('first')['expected'], 'changed source text')

    def test_changed_pinned_model_invalidates_interim_checkpoint(self) -> None:
        (self.root / 'review-checkpoints').mkdir()
        expected = self.items[0]['spokenText']
        save_json(self.root / 'review-checkpoints' / 'first.json', {
            'sha256': hashlib.sha256(b'first').hexdigest(), 'expected': expected,
            'models': ['old-small', 'old-large'],
            'attempts': [{'model': 'old-small', 'transcript': expected}],
        })
        self.run_review()
        self.assertIn(('first', 'pinned-small'), self.calls)
        self.assertIn(('first', 'pinned-large'), self.calls)

    def test_completed_reports_are_reused_without_inference(self) -> None:
        self.run_review()
        before = (self.root / 'review' / 'first.json').read_bytes()
        self.calls.clear()
        self.run_review()
        self.assertEqual(self.calls, [])
        self.assertEqual((self.root / 'review' / 'first.json').read_bytes(), before)

    def test_corrupt_checkpoint_comparisons_are_recomputed(self) -> None:
        (self.root / 'review-checkpoints').mkdir()
        save_json(self.root / 'review-checkpoints' / 'first.json', {
            'sha256': hashlib.sha256(b'first').hexdigest(), 'expected': self.items[0]['spokenText'],
            'models': self.models,
            'attempts': [{'model': 'pinned-small', 'transcript': 'one', 'needsStronger': False, 'major': False}],
        })
        self.run_review()
        self.assertNotIn(('first', 'pinned-small'), self.calls)
        self.assertIn(('first', 'pinned-large'), self.calls)

    def test_audio_change_during_inference_cannot_create_stale_proof(self) -> None:
        def changing(audio: Path, model: str) -> str:
            audio.write_bytes(b'changed during inference')
            return self.transcribe(audio, model)

        with redirect_stdout(StringIO()), self.assertRaisesRegex(ValueError, 'Audio changed'):
            review_items(self.root, self.items, self.models, changing)
        self.assertFalse((self.root / 'review' / 'first.json').exists())
        self.assertFalse((self.root / 'review-checkpoints' / 'first.json').exists())

    def test_rendering_context_preserves_expected_and_invalidates_prior_reports(self) -> None:
        self.items[0]['spokenText'] = 'Before ██ after.'
        item = self.items[0]
        digest = hashlib.sha256(b'first').hexdigest()
        context: dict[str, object] = {'comparisonExpected': 'Before redacted after.', 'audioSha256': digest, 'proof': 'bound-v1'}

        def loader(root: Path, current: ReviewItem, audio_hash: str) -> Optional[dict[str, object]]:
            self.assertEqual(root, self.root)
            self.assertEqual(current, item)
            self.assertEqual(audio_hash, digest)
            return context

        def transcribe(audio: Path, model: str) -> str:
            self.calls.append((audio.stem, model))
            return str(context['comparisonExpected'])

        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        report = self.read_report('first')
        self.assertEqual(report['expected'], 'Before ██ after.')
        self.assertEqual(report['comparisonExpected'], 'Before redacted after.')
        self.assertEqual(report['severity'], 'pass')
        self.assertEqual(report['renderingContext'], context)
        self.calls.clear()
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [])
        context['proof'] = 'new-bound-proof'
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [('first', 'pinned-small')])
        self.assertEqual(self.read_report('first')['renderingContext']['proof'], 'new-bound-proof')

    def test_missing_rendering_proof_never_reuses_policy_comparison(self) -> None:
        item = self.items[0]
        (self.root / 'review').mkdir()
        save_json(self.root / 'review' / 'first.json', {
            'sha256': hashlib.sha256(b'first').hexdigest(), 'expected': item['spokenText'],
            'attempts': [], 'severity': 'pass', 'comparisonExpected': 'waived text', 'renderingContext': {'forged': True},
        })
        self.run_review()
        self.assertIn(('first', 'pinned-small'), self.calls)
        self.assertNotIn('comparisonExpected', self.read_report('first'))

    def test_invalid_receipt_rendering_proof_holds_before_inference(self) -> None:
        (self.root / 'receipts').mkdir()
        save_json(self.root / 'receipts' / 'first.json', {'renderingRecovery': {'forged': True}})
        with patch('review.subprocess.run') as verifier:
            verifier.return_value.returncode = 1
            with redirect_stdout(StringIO()), self.assertRaisesRegex(ValueError, 'proof failed'):
                self.run_review()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'review' / 'first.json').exists())

    def test_device_defaults_to_cpu_and_requires_gpu_lease_wrapper(self) -> None:
        self.assertEqual(review_device({}), 'cpu')
        self.assertEqual(review_device({'INWORLD_REVIEW_DEVICE': 'cpu'}), 'cpu')
        self.assertEqual(review_device({'INWORLD_REVIEW_DEVICE': 'gpu', 'INWORLD_REVIEW_GPU_LEASE': '1'}), 'gpu')
        with self.assertRaisesRegex(ValueError, 'lease-owning'):
            review_device({'INWORLD_REVIEW_DEVICE': 'gpu'})
        with self.assertRaisesRegex(ValueError, 'cpu or gpu'):
            review_device({'INWORLD_REVIEW_DEVICE': 'cuda'})


if __name__ == '__main__':
    unittest.main()
