"""Regression tests for structural breaks without source loss or emoji silence."""
from __future__ import annotations
import unittest
from speech_parts import speech_parts, speakable_text, synthesis_text, delivery_instruction


class SpeechPartsTests(unittest.TestCase):
    def test_decimal_adjacent_to_units_keeps_point_and_every_fraction_digit(self) -> None:
        for source, expected in [
            ('Weight: 12.5kg (+0%)', 'twelve point five kg'),
            ('Weight: 1,234.050kg', 'one thousand two hundred thirty four point zero five zero kg'),
            ('Length: -7.25m', '-seven point two five m'),
            ('Mass: 0.05µg', 'zero point zero five µg'),
            ('Rate: 3.20abcd/sec', 'three point two zero abcd/sec'),
            ('Value: 12.5k', 'twelve point five k'),
            ('Temperature: 12.5K (+0%)', 'twelve point five K'),
            ('Value: 12.50.', '12.50.'),
        ]:
            with self.subTest(source=source):
                self.assertIn(expected, speakable_text(source))
                self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)

    def test_glitch_lettering_keeps_word_and_source_without_stripping_normal_accents(self) -> None:
        source = '“Why so much [H\u0335\u035d\u0358u\u0337\u0314\u0301n\u0337\u0300\u0360g\u0337\u030c\u0315e\u0338\u0344\u0301r\u0335\u030d\u031a]?”'
        self.assertEqual(speakable_text(source), '“Why so much Hunger?”')
        self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)
        self.assertEqual(speakable_text('cafe\u0301, a\u0306\u0301, naïve, 9.72'), 'cafe\u0301, a\u0306\u0301, naïve, 9.72')
    def test_profile_rows_are_explicit_without_losing_values_or_neighboring_prose(self) -> None:
        source = "An author update.\n\nIris's Profile:\n\n[Status & Attributes]:\nIris - Level 4 - Unspent Points: 2\nMax HP: 120 - Max Focus: 90 - TBD\nClass: None - Title: None\n\nRecovery: 2.72 (+0%)\nFocus: 4.31 (+0%)\n\nThe story continues.\nKeep this paragraph together."
        parts = speech_parts(source)
        self.assertEqual(''.join(p['text'] for p in parts), source)
        for part in parts:
            self.assertEqual(source[part['start']:part['end']], part['text'])
        rows = [p for p in parts if p['kind'] == 'stat']
        self.assertEqual(len(rows), 7)
        self.assertEqual([p['text'].strip() for p in rows[-2:]], ['Recovery: 2.72 (+0%)', 'Focus: 4.31 (+0%)'])
        self.assertIn('two point seven two', speakable_text(rows[-2]['text']))
        self.assertIn('four point three one', speakable_text(rows[-1]['text']))
        self.assertIn('exactly once', delivery_instruction('Steady author voice.', rows[-1]))
        self.assertEqual(parts[-1]['text'], 'The story continues.\nKeep this paragraph together.')

    def test_ordinary_prose_mentioning_a_profile_is_not_split(self) -> None:
        source = 'Her Profile:\nShe read the file.\nThen she shut it.'
        self.assertEqual(len(speech_parts(source)), 1)

    def test_profile_modifier_is_spoken_as_a_complete_sentence_with_exact_values(self) -> None:
        part = {'start': 0, 'end': 22, 'kind': 'stat', 'text': 'Finesse: 4.73 (+0%)\n'}
        self.assertEqual(synthesis_text(part), 'Finesse: four point seven three with a modifier of  plus zero percent.')
        psychic = {**part, 'text': '[Psychic: TBD (+0%)] (Locked[?] 28.72/30)\n'}
        spoken = synthesis_text(psychic)
        self.assertIn('twenty eight point seven two out of thirty', spoken)
        self.assertIn('question mark', spoken)
        self.assertTrue(spoken.endswith('.'))

    def test_scene_breaks_preserve_all_offsets(self) -> None:
        text = 'Stations win wars.\n\n* * *\n\n[Excerpt from UHF]\n\n* * *\n\nPoV: Evelyne\n'
        parts = speech_parts(text)
        self.assertEqual(''.join(p['text'] for p in parts), text)
        self.assertEqual([p['text'] for p in parts if p['kind'] == 'pause'], ['* * *\n', '* * *\n'])
        for part in parts:
            self.assertEqual(text[part['start']:part['end']], part['text'])

    def test_inline_quotes_emoji_and_currency_stay_spoken(self) -> None:
        text = '“No—not again!”\n😀\n$\nAnd *that* was it.'
        self.assertEqual(speech_parts(text), [{'start': 0, 'end': len(text), 'kind': 'speech', 'text': text}])

    def test_visual_citation_and_pov_use_spoken_words(self) -> None:
        self.assertEqual(speakable_text('[Excerpt from UHF, PFC844]'), 'Excerpt from UHF, PFC844')
        self.assertEqual(speakable_text('PoV: Evelyne Midra Sen'), 'Point of view: Evelyne Midra Sen')

    def test_stat_values_are_expanded_without_rounding(self) -> None:
        self.assertEqual(speakable_text('Strength: 3.18 | 3.18 (+0%)'),
            'Strength: three point one eight ,  three point one eight ,  plus zero percent, ')
        self.assertIn('twenty eight point seven two out of thirty', speakable_text('Psychic: TBD (28.72/30) +0%'))
        self.assertIn('fourteen thousand three hundred seventy two', speakable_text('Credits: 14,372 (+32k) TBD'))
        self.assertEqual(speakable_text('PFC844, Chapter 76.'), 'PFC844, Chapter 76.')

    def test_closing_bracket_is_a_pause(self) -> None:
        self.assertEqual(speech_parts(']'), [{'start': 0, 'end': 1, 'kind': 'pause', 'text': ']'}])

    def test_elongated_interjection_keeps_its_sound_and_source(self) -> None:
        source = '"Ahh—yes. Of course."'
        self.assertEqual(speakable_text(source), '"Ah, yes. Of course."')
        self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)
        self.assertEqual(speakable_text('Ahhmed said no—not again.'), 'Ahhmed said no—not again.')

    def test_author_note_abbreviation_preserves_its_words(self) -> None:
        source = 'The chapter was early last week or w/e.'
        self.assertEqual(speakable_text(source), 'The chapter was early last week or whatever.')
        self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)
        self.assertNotIn('whatever', speakable_text('https://example.com/w/e'))

    def test_skill_growth_and_breakpoints_preserve_endpoints(self) -> None:
        text = 'Effect Duration: 0.5 -> 1.00 seconds - α Duration: 0.1 -> 0.2 seconds\nGrowth: Factor+50% Duration+0.05 αDuration+0.1s/10lvl'
        spoken = speakable_text(text)
        self.assertIn('zero point five  to  one point zero zero seconds', spoken)
        self.assertIn('alpha Duration', spoken)
        self.assertIn('zero point one seconds per ten levels', spoken)
        self.assertEqual(speakable_text('breakpoints (5/15 for Minors, 10 for Major)'),
                         'breakpoints , five slash fifteen for Minors, ten for Major, ')

    def test_url_reads_all_identifier_digits_without_math_expansion(self) -> None:
        source = 'Link: https://www.patreon.com/posts/153296002. For $5 / month.'
        spoken = speakable_text(source)
        self.assertIn('H T T P S colon slash slash W W W dot patreon dot com slash posts slash one five three two nine six zero zero two.', spoken)
        self.assertTrue(spoken.endswith('For $5 / month.'))
        self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)

    def test_url_delivery_does_not_change_neighboring_speech_or_offsets(self) -> None:
        text = 'Read this: https://www.patreon.com/posts/153296002.\nKeep going.'
        parts = speech_parts(text)
        self.assertEqual([p['kind'] for p in parts], ['speech', 'url', 'speech'])
        self.assertEqual(''.join(p['text'] for p in parts), text)
        for part in parts:
            self.assertEqual(text[part['start']:part['end']], part['text'])
        self.assertEqual(delivery_instruction('Calm author voice.', parts[0]), 'Calm author voice.')
        self.assertIn('English URL', delivery_instruction('Calm author voice.', parts[1]))

    def test_parenthesized_tier_is_spoken_without_suppressing_its_words(self) -> None:
        source = "The excerpt is here (Wolf Lord+ Only!): "
        spoken = speakable_text(source)
        self.assertIn('Wolf Lord plus  Only!', spoken)
        self.assertNotIn('(', spoken)
        self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)


    def test_extreme_stretching_keeps_words_and_source(self) -> None:
        source = '“aaaAAAAllllleeeeeEEEeeeeEEExxxxxAAAAAAAA????¿¿¿¿¿¿¿¿¿¿”\n\n'
        self.assertEqual(speakable_text(source).strip(), '“Alexa?”')
        self.assertEqual(speakable_text('AAAAAAAAAAAAAAAHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH').strip(), 'Aah')
        self.assertEqual(speakable_text('Aaron, bookkeeper, aardvark.'), 'Aaron, bookkeeper, aardvark.')
        self.assertEqual(''.join(p['text'] for p in speech_parts(source)), source)

    def test_display_rows_and_clock_ranges_keep_all_values(self) -> None:
        source = '⬥Two Main Characters\n⬥Dungeon Raiding\n\nCurrent upload: 3:30PM~4:00PM CT. (4:30PM~5:00PM EST)'
        parts = speech_parts(source)
        self.assertEqual(''.join(p['text'] for p in parts), source)
        for part in parts:
            self.assertEqual(source[part['start']:part['end']], part['text'])
        self.assertEqual(parts[0]['text'], '⬥Two Main Characters\n')
        spoken = speakable_text(source)
        self.assertNotIn('⬥', spoken)
        self.assertIn('three thirty P M to four P M CT', spoken)
        self.assertIn('four thirty P M to five P M EST', spoken)

    def test_italic_author_aside_is_spoken_text(self) -> None:
        self.assertEqual(speakable_text('*round of applauses*'), 'round of applauses')
        self.assertEqual(speakable_text('And *that* was it. 3*4*5'), 'And that was it. 3*4*5')

    def test_author_paragraphs_are_separate_speech_inputs(self) -> None:
        source = 'We have Magical Girl Harmonia Lux!\n\nRound of applause.\n\nGo read it.'
        parts = speech_parts(source)
        self.assertEqual(len(parts), 3)
        self.assertEqual(''.join(p['text'] for p in parts), source)
        for part in parts:
            self.assertEqual(source[part['start']:part['end']], part['text'])


if __name__ == '__main__':
    unittest.main()
