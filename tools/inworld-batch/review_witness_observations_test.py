from __future__ import annotations

import unittest

from review_witness_observations import observations


class WitnessObservationTests(unittest.TestCase):
    def test_only_source_prefix_segmentation_is_an_observation_not_acceptance(self) -> None:
        value = observations({"expected": "alpha Qx-average seven tail", "literal": "Qx-average",
                              "transcripts": ["alpha cue ex average 7 tail", "alpha cue ex average seven tail"]})
        self.assertFalse(value["automaticAcceptance"])
        self.assertFalse(value["literalPronunciationContractEstablished"])

    def test_additional_number_modifier_or_prose_change_is_not_erased(self) -> None:
        for transcript in ["alpha cue ex average eight tail", "alpha cue ex maximum seven tail",
                           "alpha cue ex average seven tail unrelated", "alpha cue ex average tail"]:
            with self.subTest(transcript=transcript), self.assertRaises(ValueError):
                observations({"expected": "alpha Qx-average seven tail", "literal": "Qx-average",
                              "transcripts": ["alpha cue ex average seven tail", transcript]})

    def test_nonliteral_or_missing_independent_transcripts_are_refused(self) -> None:
        for literal, transcripts in [("ordinary", ["a", "b"]), ("Qx-average", ["a"]),
                                     ("Qx-average", ["a", 2])]:
            with self.subTest(literal=literal), self.assertRaises(ValueError):
                observations({"expected": "alpha Qx-average seven tail", "literal": literal,
                              "transcripts": transcripts})


if __name__ == "__main__":
    unittest.main()
