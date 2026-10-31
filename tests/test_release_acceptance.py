"""An exact candidate needs the owner's acceptance and an independent reviewer's review."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from verify_acceptance import verify  # noqa: E402

SHA = "a" * 40
AUTHOR_SESSION = "https://claude.ai/code/session_author0000000001"
REVIEW_SESSION = "https://claude.ai/code/session_review0000000002"
HISTORY = f"feat: something\n\nClaude-Session: {AUTHOR_SESSION}\n"


def review(session: str = REVIEW_SESSION, sha: str = SHA, reviewer: str = "claude-reviewer") -> str:
    return f"INDEPENDENT RELEASE REVIEW {sha} reviewer={reviewer} session={session}"


class AcceptanceTest(unittest.TestCase):
    def check(self, comments: list[dict], history: str = HISTORY) -> str:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "comments.json"
            path.write_text(json.dumps([comments]), encoding="utf-8")
            return verify(path, SHA, history)

    def test_owner_and_independent_reviewer(self) -> None:
        owner = {"user": {"login": "PelikanFix16"}, "body": f"Report\nACCEPTED RELEASE CANDIDATE {SHA}"}
        self.assertEqual(self.check([owner, {"user": {"login": "PelikanFix16"}, "body": review()}]), "claude-reviewer")
        # A review may also be posted from the other founder login.
        self.assertEqual(self.check([owner, {"user": {"login": "Zamojski5"}, "body": "x\n" + review()}]),
                         "claude-reviewer")

    def test_refusals(self) -> None:
        owner = {"user": {"login": "PelikanFix16"}, "body": f"ACCEPTED RELEASE CANDIDATE {SHA}"}
        good = {"user": {"login": "PelikanFix16"}, "body": review()}
        cases = {
            "release owner": [good],
            "owner PelikanFix16": [{"user": {"login": "Zamojski5"}, "body": owner["body"]}, good],
            "independent reviewer": [owner],
            "is an author": [owner, {"user": {"login": "PelikanFix16"}, "body": review(AUTHOR_SESSION)}],
            "malformed": [owner, {"user": {"login": "PelikanFix16"}, "body": review("short")}],
            "cannot be the independent": [owner, {"user": {"login": "PelikanFix16"},
                                                   "body": review(reviewer="PelikanFix16")}],
        }
        for reason, comments in cases.items():
            with self.subTest(reason), self.assertRaisesRegex(ValueError, reason):
                self.check(comments)
        # Another SHA or an outside login does not count.
        for comment in ({"user": {"login": "PelikanFix16"}, "body": review(sha="b" * 40)},
                        {"user": {"login": "outside"}, "body": review()}):
            with self.subTest(comment), self.assertRaisesRegex(ValueError, "independent reviewer"):
                self.check([owner, comment])
