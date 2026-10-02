"""Publishing must bind draft metadata and any Git tag to the reviewed commit."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "release" / "check_release_target.sh"


class ReleaseTargetTest(unittest.TestCase):
    def test_draft_and_tag_must_resolve_to_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote, work, fakebin = root / "remote.git", root / "work", root / "bin"
            fakebin.mkdir()
            (fakebin / "gh").write_text('#!/bin/sh\nprintf "%s\\n" "$MOCK_RELEASE_JSON"\n')
            (fakebin / "gh").chmod(0o755)

            def git(*args: str) -> str:
                result = subprocess.run(
                    ["git", *args], cwd=work if work.exists() else root,
                    check=True, capture_output=True, text=True,
                )
                return result.stdout.strip()

            git("init", "--bare", str(remote))
            git("init", "-b", "main", str(work))
            git("remote", "add", "origin", str(remote))
            (work / "probe").write_text("first\n")
            git("add", "probe")
            git("-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "-m", "first")
            first = git("rev-parse", "HEAD")
            (work / "probe").write_text("second\n")
            git("add", "probe")
            git("-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "-m", "second")
            second = git("rev-parse", "HEAD")
            git("push", "origin", "main")

            env = dict(os.environ, GITHUB_REPOSITORY="ColdPhase/flux", GITHUB_WORKSPACE=str(work))
            env["PATH"] = str(fakebin) + os.pathsep + env["PATH"]

            def check(target: str, draft: bool, expected: str = second) -> int:
                env["MOCK_RELEASE_JSON"] = json.dumps({
                    "isDraft": draft, "tagName": "v1.0.0", "targetCommitish": target,
                })
                mode = "draft" if draft else "published"
                return subprocess.run(
                    ["bash", str(SCRIPT), "v1.0.0", expected, mode],
                    cwd=root, env=env, capture_output=True,
                ).returncode

            self.assertEqual(check(second, True), 0)  # draft without tag
            self.assertNotEqual(check(first, True), 0)  # wrong draft target
            git("tag", "v1.0.0", first)
            git("push", "origin", "refs/tags/v1.0.0")
            self.assertNotEqual(check(second, True), 0)  # stale lightweight tag
            git("tag", "-d", "v1.0.0")
            git("push", "origin", ":refs/tags/v1.0.0")
            git("-c", "user.name=Release Test", "-c", "user.email=release@example.test",
                "tag", "-a", "v1.0.0", "-m", "release", second)
            git("push", "origin", "refs/tags/v1.0.0")
            self.assertEqual(check(second, True), 0)  # peeled annotated tag
            self.assertEqual(check(second, False), 0)  # published same commit
