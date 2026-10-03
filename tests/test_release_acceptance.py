"""An exact candidate needs both independent acceptance records."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from verify_acceptance import verify  # noqa: E402


class AcceptanceTest(unittest.TestCase):
    def test_requires_both_founder_logins_and_exact_head(self) -> None:
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "comments.json"
            comments = [[
                {"user": {"login": "PelikanFix16"}, "body": f"ACCEPTED RELEASE CANDIDATE {sha}"},
                {"user": {"login": "Zamojski5"}, "body": f"Evidence\nACCEPTED RELEASE CANDIDATE {sha}"},
            ]]
            path.write_text(json.dumps(comments), encoding="utf-8")
            verify(path, sha)
            comments[0][1]["body"] = "ACCEPTED RELEASE CANDIDATE " + "b" * 40
            path.write_text(json.dumps(comments), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Zamojski5"):
                verify(path, sha)
            comments[0][1] = {"user": {"login": "outside"}, "body": f"ACCEPTED RELEASE CANDIDATE {sha}"}
            path.write_text(json.dumps(comments), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Zamojski5"):
                verify(path, sha)
