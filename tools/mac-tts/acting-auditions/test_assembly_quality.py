"""Provisional assembly retains defects without waiving major publication gates."""
from __future__ import annotations

import unittest
from assemble_chapter import reviewed_issue


class AssemblyQualityTests(unittest.TestCase):
    def test_minor_issue_is_retained_and_stale_approval_is_rejected(self) -> None:
        decision = {"reviewSha256": "current", "severity": "minor", "reason": "An author-note word is repeated."}
        issue = reviewed_issue("0004", "current", decision, False)
        self.assertEqual(issue, {"index": "0004", "severity": "minor", "reason": decision["reason"]})
        with self.assertRaisesRegex(ValueError, "evidence-backed"):
            reviewed_issue("0004", "new audio", decision, True)

    def test_major_issue_requires_an_explicit_draft_and_remains_major(self) -> None:
        for severity in ["major", "uncertain"]:
            decision = {"reviewSha256": "current", "severity": severity, "reason": "A story paragraph may be missing."}
            with self.assertRaisesRegex(ValueError, "only as a draft"):
                reviewed_issue("0004", "current", decision, False)
            issue = reviewed_issue("0004", "current", decision, True)
            self.assertIsNotNone(issue)
            assert issue is not None
            self.assertEqual(issue["severity"], severity)


if __name__ == "__main__":
    unittest.main()
