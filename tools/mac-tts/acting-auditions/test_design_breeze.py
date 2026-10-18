"""Voice brief checks run without importing MLX or downloading a model."""
from __future__ import annotations
import unittest
from design_breeze import validate_brief


class BriefTests(unittest.TestCase):
    def test_valid_distinct_roles(self) -> None:
        voices = [{"role": role, "text": "The lantern flickered beside the quiet old road.",
                   "instruction": "A clear adult voice with calm, measured delivery.", "seed": i}
                  for i, role in enumerate(("narrator", "anonymous"))]
        self.assertEqual(len(validate_brief({"voices": voices})), 2)
        with self.assertRaises(ValueError):
            validate_brief({"voices": [voices[0]]})
        with self.assertRaises(ValueError):
            validate_brief({"voices": [voices[0], voices[0]]})
        voices[1]["role"] = "../outside"
        with self.assertRaises(ValueError):
            validate_brief({"voices": voices})

    def test_invalid_values(self) -> None:
        for value in (None, [], {"voices": [None]}, {"voices": [{"role": "narrator", "seed": True}]}):
            with self.assertRaises(ValueError):
                validate_brief(value)


if __name__ == "__main__":
    unittest.main()
