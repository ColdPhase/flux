"""Publication needs an independent reviewer's record of the exact artifact."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from verify_artifact_review import verify  # noqa: E402

VERSION, SHA, DIGEST, CHECKSUMS = "v1.0.0", "a" * 40, "sha256:" + "b" * 64, "c" * 64
AUTHOR_SESSION = "https://claude.ai/code/session_author0000000001"
HISTORY = f"ci: release\n\nClaude-Session: {AUTHOR_SESSION}\n"


class ArtifactReviewTest(unittest.TestCase):
    def check(self, body: str, login: str = "PelikanFix16", digest: str = DIGEST) -> str:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "comments.json"
            path.write_text(json.dumps([[{"user": {"login": login}, "body": body}]]))
            return verify(path, VERSION, SHA, digest, CHECKSUMS, HISTORY)

    def test_requires_independent_exact_digest(self) -> None:
        line = f"ACCEPTED RELEASE ARTIFACT {VERSION} {SHA} {DIGEST} {CHECKSUMS}"
        review = f"{line} reviewer=codex-reviewer session=codex-session-0000000042"
        self.assertEqual(self.check(review), "codex-reviewer")
        self.assertEqual(self.check(review, login="Zamojski5"), "codex-reviewer")
        refusals = {
            "malformed": (f"{line} reviewer=claude-x", "PelikanFix16", DIGEST),
            # The old line without a reviewer and session is not a review any more.
            "missing an independent": (line, "PelikanFix16", DIGEST),
            "is an author": (f"{line} reviewer=claude-x session={AUTHOR_SESSION}", "PelikanFix16", DIGEST),
            "exact artifact review": (review, "outside", DIGEST),
        }
        for reason, (body, login, digest) in refusals.items():
            with self.subTest(reason), self.assertRaisesRegex(ValueError, reason):
                self.check(body, login, digest)
        with self.assertRaisesRegex(ValueError, "exact artifact review"):
            self.check(review, digest="sha256:" + "d" * 64)
