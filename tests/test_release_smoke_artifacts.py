"""The packaged smoke's upgrade leg refuses a bad previous release before any image is pulled (#77),
and its content check reports exactly what differs."""

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
SCRIPT = ROOT / "scripts" / "release" / "smoke_artifacts.sh"
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from smoke_data import PROJECT_NAME, WORKSPACE_NAME, check  # noqa: E402

POSTGRES = "postgres@sha256:" + "f" * 64
STUB = """#!/bin/sh
echo "$*" >> "$STUB_LOG"
exit 99
"""


def write_assets(directory: Path, image_digest: str, postgres: str = POSTGRES, sums: bool = True) -> Path:
    directory.mkdir()
    (directory / "compose.yaml").write_text(
        f"services:\n  db:\n    image: {postgres}\n  api:\n    image: ghcr.io/coldphase/flux@{image_digest}\n",
        encoding="utf-8",
    )
    (directory / "env.example").write_text(
        "POSTGRES_PASSWORD=\nFLUX_AUTH_SECRET=\nFLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081\n", encoding="utf-8"
    )
    (directory / "release.json").write_text(
        json.dumps({"version": "v0.1.0-rc.1", "image": f"ghcr.io/coldphase/flux@{image_digest}"}), encoding="utf-8"
    )
    if sums:
        lines = [
            f"{hashlib.sha256((directory / name).read_bytes()).hexdigest()}  {name}\n"
            for name in ("compose.yaml", "env.example", "release.json")
        ]
        (directory / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")
    return directory


class UpgradeLegRefusalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "bin").mkdir()
        stub = self.dir / "bin" / "docker"
        stub.write_text(STUB)
        stub.chmod(0o755)
        self.log = self.dir / "docker.log"
        self.candidate = write_assets(self.dir / "candidate", "sha256:" + "b" * 64)

    def run_script(self, previous: Path | str | None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, STUB_LOG=str(self.log), PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}")
        env.pop("FLUX_SMOKE_PREVIOUS_ASSETS", None)
        if previous is not None:
            env["FLUX_SMOKE_PREVIOUS_ASSETS"] = str(previous)
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.candidate), str(self.dir / "state"), "projectsrc", "projectrst"],
            env=env, capture_output=True, text=True,
        )

    def assert_refused(self, result: subprocess.CompletedProcess[str], message: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.log.exists(), "docker must not be called before the previous release is accepted")

    def test_previous_must_be_a_directory(self) -> None:
        self.assert_refused(self.run_script(self.dir / "missing"), "is not a directory")

    def test_previous_needs_its_checksums(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64, sums=False)
        self.assert_refused(self.run_script(previous), "has no SHA256SUMS")

    def test_previous_must_match_its_checksums(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64)
        (previous / "compose.yaml").write_text("# edited\n", encoding="utf-8")
        self.assert_refused(self.run_script(previous), "do not match its SHA256SUMS")

    def test_previous_cannot_be_the_candidate(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "b" * 64)
        self.assert_refused(self.run_script(previous), "pin the same image")

    def test_previous_cannot_use_another_postgresql_pin(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64, postgres="postgres@sha256:" + "e" * 64)
        self.assert_refused(self.run_script(previous), "PostgreSQL pin differs")

    def test_without_a_previous_release_the_clean_install_leg_starts_unchanged(self) -> None:
        result = self.run_script(None)
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call
        self.assertEqual(self.log.read_text().splitlines()[0].split()[:2], ["compose", "--env-file"])
        self.assertIn("config --quiet", self.log.read_text().splitlines()[0])

    def test_a_valid_previous_release_passes_the_checks_and_reaches_docker(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64)
        result = self.run_script(previous)
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call, as above
        self.assertNotIn("previous release", result.stderr)
        self.assertTrue(self.log.exists())


class ContentCheckTest(unittest.TestCase):
    state = {
        "project_id": "p1", "messages": [[1, "first"], [2, "second"]], "file_hex": "00ff",
        "doc_versions": [[1, "draft", "Created"], [2, "published", "Second version"]],
        "work_title": "work", "note_id": "n1", "note_title": "note",
    }

    def observed(self, **changes: object) -> dict[str, object]:
        value: dict[str, object] = {
            "workspace_name": WORKSPACE_NAME, "project_names": {"p1": PROJECT_NAME},
            "messages": [[1, "first"], [2, "second"]], "file_hex": "00ff",
            "doc_versions": [[1, "draft", "Created"], [2, "published", "Second version"]],
            "work_title": "work", "note_titles": {"n1": "note"},
        }
        value.update(changes)
        return value

    def test_equal_content_has_no_problems(self) -> None:
        self.assertEqual(check(self.state, self.observed()), [])

    def test_a_message_written_later_is_not_a_problem(self) -> None:
        later = [[1, "first"], [2, "second"], [3, "written after the upgrade"]]
        self.assertEqual(check(self.state, self.observed(messages=later)), [])

    def test_each_lost_item_is_named(self) -> None:
        problems = check(self.state, self.observed(
            workspace_name="x", project_names={}, messages=[[1, "first"]], file_hex="00",
            doc_versions=[[1, "draft", "Created"]], work_title="y", note_titles={},
        ))
        self.assertEqual(len(problems), 7, problems)


if __name__ == "__main__":
    unittest.main()
