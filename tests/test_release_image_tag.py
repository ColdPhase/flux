"""The GHCR version tag is created once and never moved, even when the registry read fails."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "release" / "promote_image_tag.sh"
REVIEWED = "sha256:" + "b" * 64
OTHER = "sha256:" + "a" * 64

# A registry holding at most the one version tag; MOCK_INSPECT_ERROR fails the first read once.
FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$MOCK_LOG"
case "$3" in
  inspect)
    if [ -n "${MOCK_INSPECT_ERROR:-}" ] && [ ! -e "$MOCK_LOG.failed" ]; then
      : > "$MOCK_LOG.failed"; echo "ERROR: $MOCK_INSPECT_ERROR" >&2; exit 1
    fi
    if [ ! -s "$MOCK_REGISTRY" ]; then echo "ERROR: $4: not found" >&2; exit 1; fi
    if [ "${5:-}" = "--format" ]; then printf '{"digest":"%s"}\\n' "$(cat "$MOCK_REGISTRY")"; fi ;;
  create) printf '%s' "${7#*@}" > "$MOCK_REGISTRY" ;;
esac
"""


class ImageTagTest(unittest.TestCase):
    def promote(self, existing: str | None, inspect_error: str = "") -> tuple[int, str | None, bool]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docker").write_text(FAKE_DOCKER)
            (root / "docker").chmod(0o755)
            registry, log = root / "registry", root / "log"
            if existing:
                registry.write_text(existing)
            env = dict(
                os.environ, MOCK_LOG=str(log), MOCK_REGISTRY=str(registry),
                MOCK_INSPECT_ERROR=inspect_error, PATH=str(root) + os.pathsep + os.environ["PATH"],
            )
            result = subprocess.run(
                ["bash", str(SCRIPT), "v1.0.0", REVIEWED], env=env, capture_output=True, text=True,
            )
            tag = registry.read_text() if registry.exists() else None
            return result.returncode, tag, "imagetools create" in log.read_text()

    def test_absent_tag_is_created_at_the_reviewed_digest(self) -> None:
        self.assertEqual(self.promote(None), (0, REVIEWED, True))

    def test_retry_accepts_the_same_digest_without_retagging(self) -> None:
        self.assertEqual(self.promote(REVIEWED), (0, REVIEWED, False))

    def test_existing_tag_for_another_digest_is_never_moved(self) -> None:
        code, tag, created = self.promote(OTHER)
        self.assertNotEqual(code, 0)
        self.assertEqual((tag, created), (OTHER, False))

    def test_failed_registry_read_is_not_taken_as_an_absent_tag(self) -> None:
        for existing in (OTHER, None):
            with self.subTest(existing=existing):
                code, tag, created = self.promote(existing, "unexpected status: 503 Service Unavailable")
                self.assertNotEqual(code, 0)
                self.assertEqual((tag, created), (existing, False))


if __name__ == "__main__":
    unittest.main()
