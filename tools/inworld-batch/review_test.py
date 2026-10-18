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

from review import ReviewItem, compare, review_device, review_items, save_json, visible_base_text, words


class ReviewTests(unittest.TestCase):
    def test_numeric_comparison_symbols_survive_tags_and_direction_changes(self) -> None:
        self.assertEqual(words('<break time="900ms" /> <12s and >3s'),
                         words('less than twelve s and greater than three s'))
        self.assertNotEqual(words('<12s'), words('>12s'))
        self.assertNotEqual(words('value <12s and >3s'), words('value three s'))
        # Unsupported source markup is never silently consumed as synthesis.
        self.assertIn('unknown', words('<unknown>keep this</unknown>'))
        self.assertIn('break', words('<break time="erase words"/> keep'))
        self.assertEqual(words('<17%'), words('less than seventeen percent'))
        for symbol, spoken in [('<=', 'less than or equal to'), ('≤', 'less than or equal to'),
                               ('>=', 'greater than or equal to'), ('≥', 'greater than or equal to'), ('=', 'equals')]:
            self.assertEqual(words(symbol + '12'), words(spoken + ' twelve'))
        self.assertNotEqual(words('≤12'), words('<12'))
        self.assertNotEqual(words('≥12'), words('12'))

    def test_temperature_symbols_preserve_unit_and_decimal_semantics(self) -> None:
        self.assertEqual(words('13.25°C'), words('thirteen point two five degrees Celsius'))
        self.assertEqual(words('13.25° C'), words('thirteen point two five degree Celsius'))
        self.assertEqual(words('32°F'), words('thirty two degrees Fahrenheit'))
        self.assertEqual(words('45°'), words('forty five degrees'))
        self.assertEqual(words('12°K'), words('twelve degrees k'))
        for sign in ['-', '−']:
            self.assertEqual(words(sign + '13.25°C'), words('minus thirteen point two five degrees Celsius'))
            self.assertNotEqual(words(sign + '13.25°C'), words('13.25°C'))
            self.assertEqual(words('(<'+sign+'13)'), words('less than minus thirteen'))
        self.assertNotIn('minus', words('level-1 and range 12-13'))
        prefix = ' '.join(['ordinary surrounding words'] * 30)
        for expected, actual in [
            ('<12s', 'twelve s'), ('<12s', 'greater than twelve s'),
            ('<12s', 'less when twelve s'),
            ('13.25°C', 'thirteen two five degrees Celsius'),
            ('13.25°C', 'thirteen point two five'),
            ('<12 and >3', 'greater than twelve and less than three'),
            ('<12s', 'less than thirteen s'), ('<17%', 'less than seventeen'),
            ('≤12', 'less than twelve'), ('>=3', 'three'),
            ('45°', 'forty five'), ('32°F', 'thirty two'),
            ('-13.25°C', 'thirteen point two five degrees Celsius'),
            ('−13.25', 'thirteen point two five'),
        ]:
            result = compare(prefix + ' ' + expected, prefix + ' ' + actual)
            self.assertGreater(result['wordRecall'], .9)
            self.assertTrue(result['needsStronger'])
            self.assertTrue(result['changes'])
        self.assertTrue(compare('<12s <13s <14s <15s',
                                'less than twelve s less than thirteen s fourteen s less than fifteen s')['needsStronger'])

    def test_symbol_report_cache_is_recompared_from_existing_raw_checkpoint(self) -> None:
        item: ReviewItem = {'customId': 'first', 'spokenText': 'limit <12s and 13.25°C'}
        digest = hashlib.sha256((self.root / 'audio' / 'first.wav').read_bytes()).hexdigest()
        attempts = [{'model': self.models[0], 'transcript': 'limit twelve s and thirteen two five degrees Celsius',
                     'wordRecall': 1, 'changes': [], 'major': False, 'needsStronger': False}]
        (self.root / 'review').mkdir()
        (self.root / 'review-checkpoints').mkdir()
        save_json(self.root / 'review' / 'first.json', {'sha256': digest, 'expected': item['spokenText'],
                                                      'attempts': attempts, 'severity': 'pass'})
        save_json(self.root / 'review-checkpoints' / 'first.json', {'sha256': digest, 'expected': item['spokenText'],
                  'models': self.models, 'attempts': attempts, 'renderingContext': None})

        def transcribe(audio: Path, model: str) -> str:
            self.calls.append((audio.stem, model))
            return 'limit less than twelve s and thirteen point two five degrees Celsius'

        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe)
        self.assertEqual(self.calls, [('first', self.models[1])])
        report = self.read_report('first')
        self.assertEqual(report['notationComparisonPolicy'], 'numeric-symbols-v1')
        self.assertEqual(report['expected'], item['spokenText'])
        self.assertTrue(report['attempts'][0]['needsStronger'])
        self.assertEqual(report['severity'], 'pass')
        self.calls.clear()
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe)
        self.assertEqual(self.calls, [])

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

    def test_plus_qualifier_is_audible_content(self) -> None:
        self.assertEqual(words('Grade E+.'), ['grade', 'e', 'plus'])
        self.assertEqual(compare('Grade E+.', 'Grade E plus.')['changes'], [])
        self.assertTrue(compare('Grade E+.', 'Grade E.')['changes'])
        self.assertEqual(words('C++ and 2+3'), ['c', 'plus', 'plus', 'and', 'two', 'plus', 'three'])
        self.assertEqual(words('<break time="+1s"/> Grade E+'), ['grade', 'e', 'plus'])

    def test_combining_overlays_compare_visible_letters_without_omitting_symbols_or_accents(self) -> None:
        source = 'S\u0334\u0337e\u0335a\u0336l\u0338ed E+ 4\u0338.'
        self.assertEqual(visible_base_text(source), 'Sealed E+ 4.')
        self.assertEqual(words(source), ['sealed', 'e', 'plus', 'four'])
        self.assertEqual(compare(source, 'Sealed E plus four')['changes'], [])
        self.assertTrue(compare(source, 'Sealed E four')['changes'])
        unchanged = 'é a\u0301 n\u0303 ? ██'
        self.assertEqual(visible_base_text(unchanged), unchanged)
        self.assertEqual(visible_base_text('\u0334“\u0335A\u0336 \u0337B\u0338.”'), '“A B.”')

    def test_legacy_overlay_report_recompares_raw_asr_and_keeps_original_expected(self) -> None:
        item: ReviewItem = {'customId': 'first', 'spokenText': 'S\u0334e\u0337aled E+.'}
        digest = hashlib.sha256(b'first').hexdigest()
        (self.root / 'review').mkdir()
        (self.root / 'review-checkpoints').mkdir()
        attempts = [{'model': self.models[0], 'transcript': 'Sealed E plus.', 'changes': [{'kind': 'replace'}],
                     'major': True, 'needsStronger': True, 'wordRecall': 0}]
        save_json(self.root / 'review' / 'first.json', {'sha256': digest, 'expected': item['spokenText'],
                  'attempts': attempts, 'severity': 'major', 'comparisonPolicy': 'spoken-plus-v1'})
        save_json(self.root / 'review-checkpoints' / 'first.json', {'sha256': digest,
                  'expected': item['spokenText'], 'models': self.models, 'attempts': attempts, 'renderingContext': None})
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, self.transcribe)
        report = self.read_report('first')
        self.assertEqual(self.calls, [])
        self.assertEqual(report['overlayComparisonPolicy'], 'combining-overlay-v1')
        self.assertEqual(report['expected'], item['spokenText'])
        self.assertEqual(report['severity'], 'pass')

    def test_legacy_plus_report_recompares_saved_raw_asr_without_repeating_inference(self) -> None:
        item: ReviewItem = {'customId': 'first', 'spokenText': 'Grade E+.'}
        digest = hashlib.sha256(b'first').hexdigest()
        (self.root / 'review').mkdir()
        (self.root / 'review-checkpoints').mkdir()
        attempts = [{'model': model, 'transcript': 'Grade E.', 'changes': [], 'major': False,
                     'needsStronger': False, 'wordRecall': 1} for model in self.models]
        save_json(self.root / 'review' / 'first.json', {'sha256': digest, 'expected': item['spokenText'],
                  'attempts': attempts, 'severity': 'pass'})
        save_json(self.root / 'review-checkpoints' / 'first.json', {'sha256': digest,
                  'expected': item['spokenText'], 'models': self.models, 'attempts': attempts, 'renderingContext': None})
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, self.transcribe)
        report = self.read_report('first')
        self.assertEqual(self.calls, [])
        self.assertEqual(report['comparisonPolicy'], 'spoken-plus-v1')
        self.assertNotEqual(report['severity'], 'pass')
        self.assertEqual(report['expected'], 'Grade E+.')
        self.assertTrue(report['attempts'][-1]['changes'])
        before = (self.root / 'review' / 'first.json').read_bytes()
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, self.transcribe)
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

    def test_offline_pcm_layer_requires_fresh_small_and_strong_asr_for_the_entire_original_expected(self) -> None:
        item = self.items[0]
        item['spokenText'] = 'one ██ two three four five six'
        context: dict[str, object] = {'comparisonExpected': 'one redacted two three four five six',
                                      'offlinePCMExcision': {'planHash': 'first-proof'}}

        def loader(root: Path, current: ReviewItem, digest: str) -> dict[str, object]:
            self.assertEqual(current, item)
            self.assertEqual(root, self.root)
            return {**context, 'audioSha256': digest}

        def transcribe(audio: Path, model: str) -> str:
            self.calls.append((audio.stem, model))
            if model == self.models[1] and (self.root / 'review/first.json').exists():
                self.assertNotEqual(self.read_report('first')['sha256'], hashlib.sha256(audio.read_bytes()).hexdigest())
            return str(context['comparisonExpected'])

        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [('first', 'pinned-small'), ('first', 'pinned-large')])
        original = self.read_report('first')
        self.calls.clear()
        (self.root / 'audio/first.wav').write_bytes(b'exact-offline-pcm-edit')
        context['offlinePCMExcision'] = {'planHash': 'new-exact-proof'}
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        report = self.read_report('first')
        self.assertEqual(self.calls, [('first', 'pinned-small'), ('first', 'pinned-large')])
        self.assertEqual(report['expected'], item['spokenText'])
        self.assertEqual(report['comparisonExpected'], context['comparisonExpected'])
        self.assertNotEqual(report['sha256'], original['sha256'])
        self.assertEqual(report['renderingContext']['offlinePCMExcision'], {'planHash': 'new-exact-proof'})

    def test_invalid_receipt_rendering_proof_holds_before_inference(self) -> None:
        (self.root / 'receipts').mkdir()
        save_json(self.root / 'receipts' / 'first.json', {'renderingRecovery': {'forged': True}})
        with patch('review.subprocess.run') as verifier:
            verifier.return_value.returncode = 1
            with redirect_stdout(StringIO()), self.assertRaisesRegex(ValueError, 'proof failed'):
                self.run_review()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'review' / 'first.json').exists())

    def test_notation_recovery_requires_dual_asr_after_all_symbols_are_verbalized(self) -> None:
        item: ReviewItem = {'customId': 'first', 'spokenText': 'A limit <12h.'}
        context: dict[str, object] = {'comparisonExpected': 'A limit less than twelve hours.',
                                     'renderingProof': {'policy': 'source-numeric-notation-v1', 'fingerprint': 'bound-source-proof'}}

        def loader(root: Path, current: ReviewItem, digest: str) -> dict[str, object]:
            return {**context, 'audioSha256': digest}

        def transcribe(audio: Path, model: str) -> str:
            self.calls.append((audio.stem, model))
            return 'A limit less than twelve hours.'

        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [('first', 'pinned-small'), ('first', 'pinned-large')])
        report = self.read_report('first')
        self.assertEqual(report['expected'], item['spokenText'])
        self.assertEqual(report['comparisonExpected'], context['comparisonExpected'])
        self.assertEqual(report['severity'], 'pass')
        report['attempts'] = report['attempts'][:1]
        save_json(self.root / 'review' / 'first.json', report)
        self.calls.clear()
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.read_report('first')['attempts']), 2)

    def test_overlay_recovery_requires_both_fresh_whole_parent_models_even_when_small_matches(self) -> None:
        item: ReviewItem = {'customId': 'first', 'spokenText': 'S\u0334e\u0337aled E+.'}
        context: dict[str, object] = {'comparisonExpected': 'Sealed E+.',
                                      'renderingProof': {'policy': 'combining-overlay-v1', 'fingerprint': 'bound-source-proof'}}

        def loader(root: Path, current: ReviewItem, digest: str) -> dict[str, object]:
            self.assertEqual(current, item)
            return {**context, 'audioSha256': digest}

        def transcribe(audio: Path, model: str) -> str:
            self.calls.append((audio.stem, model))
            return 'Sealed E plus.'

        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [('first', 'pinned-small'), ('first', 'pinned-large')])
        report = self.read_report('first')
        self.assertEqual(report['expected'], item['spokenText'])
        self.assertEqual(report['comparisonExpected'], 'Sealed E+.')
        self.assertEqual(report['comparisonPolicy'], 'spoken-plus-v1')
        self.assertEqual(report['severity'], 'pass')
        # A one-model report cannot masquerade as completed recovery QA. Reuse
        # its bound raw checkpoint without rerunning either completed model.
        report['attempts'] = report['attempts'][:1]
        save_json(self.root / 'review' / 'first.json', report)
        self.calls.clear()
        with redirect_stdout(StringIO()):
            review_items(self.root, [item], self.models, transcribe, loader)
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.read_report('first')['attempts']), 2)

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
