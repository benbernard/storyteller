"""Synthetic, model-free notation allowance classification regressions."""
from __future__ import annotations

import unittest
import hashlib

from notation_evidence import validate_diagnosis


class NotationEvidenceTests(unittest.TestCase):
    def test_only_missing_comparator_is_eligible_and_controls_retain_it(self) -> None:
        source = 'limit <12h and all ordinary words remain'
        missing = 'limit twelve hours and all ordinary words remain'
        correct = 'limit less than twelve hours and all ordinary words remain'
        self.assertTrue(validate_diagnosis(source, 'missing-comparator', missing, missing, 'ordinaryphones'))
        self.assertFalse(validate_diagnosis(source, 'missing-comparator', missing, missing.replace('ordinary ', ''), 'ordinaryphones'))
        self.assertFalse(validate_diagnosis(source, 'missing-comparator', correct, correct, 'lɛsðən'))
        self.assertTrue(validate_diagnosis(source, 'verified-reuse', correct, correct, 'lɛs ðən'))
        self.assertFalse(validate_diagnosis(source, 'verified-reuse', correct, missing, 'lɛsðən'))

    def test_celsius_requires_both_units_and_conserves_both_decimal_points_and_other_words(self) -> None:
        source = 'first 13.25°C and second 17.5°C remain unchanged'
        raw = 'first thirteen point two five C.G.C. and second seventeen point five CGC remain unchanged'
        self.assertTrue(validate_diagnosis(source, 'misread-celsius', raw, raw, 'siː dʒiː siː sidʒisi'))
        for wrong in [raw.replace('point ', '', 1), raw.replace('unchanged', 'different'), raw + ' extra']:
            self.assertFalse(validate_diagnosis(source, 'misread-celsius', wrong, raw, 'sidʒisisidʒisi'))
        self.assertFalse(validate_diagnosis(source, 'misread-celsius', raw, raw, 'sidʒisi'))

    def test_old_tail_ambiguity_is_explicitly_pinned_without_waiving_any_new_or_other_word(self) -> None:
        source = 'first 13.25°C and second 17.5°C per day'
        raw = 'first thirteen point two five CGC and second seventeen point five CGC to per day'
        digest = hashlib.sha256(b'to').hexdigest()
        self.assertFalse(validate_diagnosis(source, 'misread-celsius', raw, raw, 'sidʒisisidʒisi'))
        self.assertTrue(validate_diagnosis(source, 'misread-celsius', raw, raw, 'sidʒisisidʒisi', old_tail_token_sha256=digest))
        for wrong in [raw.replace('point ', '', 1), raw.replace('day', 'night'), raw + ' extra', raw.replace('to per', 'of per'), raw.replace('first ', 'first to ', 1)]:
            self.assertFalse(validate_diagnosis(source, 'misread-celsius', wrong, raw, 'sidʒisisidʒisi', old_tail_token_sha256=digest))
        self.assertFalse(validate_diagnosis(source, 'misread-celsius', raw, raw, 'sidʒisisidʒisi', old_tail_token_sha256='0' * 64))

    def test_literal_identifier_has_corroborated_omitted_letters_and_exact_strong_outside_content(self) -> None:
        source = 'avg rate 9 abcd/sec remains'
        offset = source.index('abcd/sec')
        small, strong = 'average rate nine A.B. per second remains', 'average rate nine AB per second remains'
        self.assertTrue(validate_diagnosis(source, 'truncated-literal-unit', small, strong, 'eɪbi', offset))
        self.assertFalse(validate_diagnosis(source, 'truncated-literal-unit', small, strong + ' extra', 'eɪbi', offset))
        self.assertFalse(validate_diagnosis(source, 'truncated-literal-unit', small, strong, 'eɪbisi di', offset))
        self.assertFalse(validate_diagnosis(source, 'truncated-literal-unit', small, strong, 'eɪbi', offset + 1))
        self.assertFalse(validate_diagnosis(source, 'truncated-literal-unit', small, strong.replace('AB', 'AC'), 'eɪbi', offset))
        astral = '😀 ' + source
        utf16_offset = len(astral[:astral.index('abcd/sec')].encode('utf-16-le')) // 2
        self.assertTrue(validate_diagnosis(astral, 'truncated-literal-unit', '😀 ' + small, '😀 ' + strong, 'eɪbi', utf16_offset))
        self.assertFalse(validate_diagnosis(astral, 'truncated-literal-unit', small, strong, 'eɪbi', 1))


if __name__ == '__main__':
    unittest.main()
