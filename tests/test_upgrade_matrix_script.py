"""check_upgrade_matrix.sh reports what it did not test (#1262 review): a leg that is switched off is listed as SKIPPED, the run says it is
not the full matrix, and it writes no list of tested releases, so a release can never claim an upgrade that did not run. Docker is a stub."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_upgrade_matrix.sh"
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from check_released_migrations import release_tags  # noqa: E402

DIGEST = "sha256:" + "a" * 64


def assets(directory: Path, version: str) -> Path:
    directory.mkdir(parents=True)
    (directory / "release.json").write_text(json.dumps({"version": version, "source_sha": "b" * 40, "image": f"ghcr.io/coldphase/flux@{DIGEST}"}), encoding="utf-8")
    (directory / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (directory / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256((directory / name).read_bytes()).hexdigest()}  {name}\n" for name in ("compose.yaml", "release.json")), encoding="utf-8")
    return directory


@unittest.skipUnless(release_tags(ROOT), "no release tags in this clone (git fetch --tags)")
class SkippedLegsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "bin").mkdir()
        docker = self.dir / "bin" / "docker"
        docker.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        docker.chmod(0o755)
        self.releases = self.dir / "releases"
        assets(self.releases / "v0.2.0", "v0.2.0")
        self.candidate = assets(self.dir / "candidate", "v0.2.1")
        self.tested = self.dir / "tested.txt"

    def run_script(self, **env: str) -> subprocess.CompletedProcess[str]:
        merged = dict(os.environ, PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}", FLUX_MATRIX_RELEASES_DIR=str(self.releases),
                      FLUX_MATRIX_CANDIDATE_ASSETS=str(self.candidate), FLUX_MATRIX_TESTED_FILE=str(self.tested), TMPDIR=str(self.dir), **env)
        return subprocess.run(["bash", str(SCRIPT)], env=merged, capture_output=True, text=True)

    def test_switched_off_legs_are_listed_as_skipped_and_the_run_is_not_the_full_matrix(self) -> None:
        result = self.run_script(FLUX_MATRIX_RELEASE_INSTALL="0", FLUX_MATRIX_SOURCE="0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("v0.2.0 -> v0.2.1  release installation  SKIPPED", result.stdout)
        self.assertIn("v0.2.0 -> v0.2.1  source checkout        SKIPPED", result.stdout)
        self.assertIn("NOT THE FULL MATRIX", result.stdout)
        self.assertIn("NOTHING WAS UPGRADED", result.stdout)
        self.assertNotIn("PASS:", result.stdout)
        self.assertFalse(self.tested.exists(), "a partial run must not name releases as tested")

    def test_one_switched_off_leg_is_still_named_and_still_writes_nothing(self) -> None:
        result = self.run_script(FLUX_MATRIX_RELEASE_INSTALL="0", FLUX_MATRIX_SOURCE="0", FLUX_MATRIX_ONLY="v0.2.0")
        self.assertIn("switched off: release-installation source-checkout", result.stdout)
        self.assertFalse(self.tested.exists())


if __name__ == "__main__":
    unittest.main()
