"""Exercise the actual launcher's private configuration transition without Docker resources."""

from __future__ import annotations

import os
import shutil
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = b"FLUX_PROJECT=flux-private-config\nFLUX_AUTH_SECRET=test-existing-secret\n"


class FluxConfigurationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="flux-env-regression-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.checkout = self.base / "checkout"
        (self.checkout / "docker").mkdir(parents=True)
        (self.checkout / "config").mkdir()
        shutil.copy2(ROOT / "flux", self.checkout / "flux")
        self.legacy = self.checkout / ".env"
        self.live = self.checkout / "docker/.env"
        self.private = self.checkout / "config/private.env"
        self.write_private(self.private)
        spy = self.base / "bin"
        spy.mkdir()
        docker = spy / "docker"
        docker.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FLUX_ENV_TEST_LOG"\nexit 0\n',
            encoding="utf-8",
        )
        docker.chmod(0o700)
        self.log = self.base / "docker-calls"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        self.env.update(PATH=f"{spy}:{os.environ['PATH']}", FLUX_ENV_TEST_LOG=str(self.log))

    def write_private(self, path: Path) -> None:
        path.write_bytes(CONFIG)
        path.chmod(0o600)

    def run_flux(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.checkout / "flux"), *args], cwd=self.base, env=self.env,
            capture_output=True, text=True, timeout=10,
        )

    def assert_private_unchanged(self, path: Path) -> None:
        self.assertEqual(path.read_bytes(), CONFIG)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def assert_refused(self, *args: str) -> None:
        result = self.run_flux(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("configuration", result.stderr)
        self.assertFalse(self.log.exists(), "refusal must precede any Docker invocation")
        self.assertFalse((self.live.parent / ".env.flux-new").exists())
        self.assert_private_unchanged(self.private)

    def test_relative_legacy_link_is_refused_before_up_down_or_reset(self) -> None:
        self.legacy.symlink_to("config/private.env")
        for command in (("up",), ("down",), ("reset", "-y")):
            with self.subTest(command=command):
                self.assert_refused(*command)
                self.assertEqual(os.readlink(self.legacy), "config/private.env")
                self.assert_private_unchanged(self.legacy)
                self.assertFalse(os.path.lexists(self.live))

    def test_absolute_legacy_link_is_refused_without_relocating_it(self) -> None:
        self.legacy.symlink_to(self.private)
        self.assert_refused("up")
        self.assertEqual(os.readlink(self.legacy), str(self.private))
        self.assertFalse(os.path.lexists(self.live))

    def test_dangling_legacy_link_is_refused_without_new_secrets(self) -> None:
        self.legacy.symlink_to("missing-private.env")
        self.assert_refused("up")
        self.assertEqual(os.readlink(self.legacy), "missing-private.env")
        self.assertFalse(os.path.lexists(self.live))

    def test_dangling_destination_is_not_replaced_by_generated_config(self) -> None:
        self.live.symlink_to("missing-private.env")
        self.assert_refused("up")
        self.assertEqual(os.readlink(self.live), "missing-private.env")
        self.assertFalse(os.path.lexists(self.legacy))

    def test_regular_legacy_and_dangling_destination_conflict_remains_intact(self) -> None:
        self.write_private(self.legacy)
        self.live.symlink_to("missing-private.env")
        self.assert_refused("down")
        self.assert_private_unchanged(self.legacy)
        self.assertEqual(os.readlink(self.live), "missing-private.env")

    def test_two_regular_configuration_files_are_not_overwritten(self) -> None:
        self.write_private(self.legacy)
        self.live.write_bytes(b"FLUX_PROJECT=flux-other-config\n")
        self.live.chmod(0o600)
        self.assert_refused("up")
        self.assert_private_unchanged(self.legacy)
        self.assertEqual(self.live.read_bytes(), b"FLUX_PROJECT=flux-other-config\n")
        self.assertEqual(stat.S_IMODE(self.live.stat().st_mode), 0o600)

    def test_regular_legacy_moves_once_with_bytes_permissions_and_project(self) -> None:
        self.write_private(self.legacy)
        for _ in range(2):
            result = self.run_flux("down")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse(os.path.lexists(self.legacy))
            self.assert_private_unchanged(self.live)
        calls = self.log.read_text()
        self.assertIn("-p flux-private-config ", calls)
        self.assertIn("-p flux-private-config-dev ", calls)
        self.assertIn(f"--env-file {self.live}", calls)

    def test_valid_live_relative_link_keeps_target_and_project(self) -> None:
        self.live.symlink_to("../config/private.env")
        result = self.run_flux("down")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(os.readlink(self.live), "../config/private.env")
        self.assert_private_unchanged(self.live)
        self.assertIn("-p flux-private-config ", self.log.read_text())

    def test_destination_directory_is_refused_before_docker(self) -> None:
        self.live.mkdir()
        self.assert_refused("up")
        self.assertTrue(self.live.is_dir())

    def run_printed_rollback_guard(self) -> subprocess.CompletedProcess[str]:
        # Execute the literal commands the launcher prints, as an operator would after
        # checking out an old version. The new launcher helpers are unavailable then.
        body = (ROOT / "flux").read_text().split("upgrade_failed() {", 1)[1].split("\n}", 1)[0]
        lines = [shlex.split(line.strip())[1] for line in body.splitlines()
                 if line.strip().startswith('warn "  ')]
        start = next(i for i, line in enumerate(lines) if line.strip().startswith("if [ ! -f app/package.json ]"))
        end = next(i for i in range(start, len(lines)) if lines[i].strip() == "fi")
        return subprocess.run(
            ["sh", "-c", "\n".join(lines[start:end + 1])], cwd=self.checkout,
            env=self.env, capture_output=True, text=True, timeout=10,
        )

    def test_printed_rollback_moves_regular_file_with_private_permissions(self) -> None:
        self.write_private(self.live)
        result = self.run_printed_rollback_guard()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_private_unchanged(self.legacy)
        self.assertFalse(os.path.lexists(self.live))

    def test_printed_rollback_refuses_relative_live_symlink(self) -> None:
        self.live.symlink_to("../config/private.env")
        result = self.run_printed_rollback_guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.live), "../config/private.env")
        self.assert_private_unchanged(self.private)
        self.assertFalse(os.path.lexists(self.legacy))

    def test_printed_rollback_refuses_dangling_live_symlink(self) -> None:
        self.live.symlink_to("missing-private.env")
        result = self.run_printed_rollback_guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.live), "missing-private.env")
        self.assertFalse(os.path.lexists(self.legacy))

    def test_printed_rollback_does_not_overwrite_dangling_root_link(self) -> None:
        self.write_private(self.live)
        self.legacy.symlink_to("missing-private.env")
        result = self.run_printed_rollback_guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.legacy), "missing-private.env")
        self.assert_private_unchanged(self.live)

    def test_printed_rollback_keeps_current_layout_configuration(self) -> None:
        (self.checkout / "app").mkdir()
        (self.checkout / "app/package.json").write_text("{}")
        self.write_private(self.live)
        result = self.run_printed_rollback_guard()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_private_unchanged(self.live)
        self.assertFalse(os.path.lexists(self.legacy))


if __name__ == "__main__":
    unittest.main()
