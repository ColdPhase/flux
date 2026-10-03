"""Publication cannot consume a self-review or a review of a different digest."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from verify_artifact_review import verify  # noqa: E402


class ArtifactReviewTest(unittest.TestCase):
    def test_requires_independent_exact_digest(self) -> None:
        version, sha, digest = "v1.0.0", "a" * 40, "sha256:" + "b" * 64
        checksums_sha = "c" * 64
        marker = f"ACCEPTED RELEASE ARTIFACT {version} {sha} {digest} {checksums_sha}"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "comments.json"
            comments = [[{"user": {"login": "PelikanFix16"}, "body": marker}]]
            path.write_text(json.dumps(comments))
            with self.assertRaisesRegex(ValueError, "Zamojski5"):
                verify(path, version, sha, digest, checksums_sha)
            comments[0][0]["user"]["login"] = "Zamojski5"
            path.write_text(json.dumps(comments))
            verify(path, version, sha, digest, checksums_sha)
            with self.assertRaisesRegex(ValueError, "Zamojski5"):
                verify(path, version, sha, "sha256:" + "c" * 64, checksums_sha)
