"""Exercise the actual launcher's private configuration checks without Docker resources."""

from __future__ import annotations

import os
import shutil
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

    def test_up_and_down_refuse_unknown_options_before_docker(self) -> None:
        for args, message in ((("up", "--dev"), "up: unknown option --dev"), (("down", "--x"), "down: unknown option --x")):
            with self.subTest(args=args):
                result = self.run_flux(*args)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(message, result.stderr)
                self.assertFalse(self.log.exists(), "a refused option must not reach Docker")

    def test_dangling_destination_is_not_replaced_by_generated_config(self) -> None:
        self.live.symlink_to("missing-private.env")
        self.assert_refused("up")
        self.assertEqual(os.readlink(self.live), "missing-private.env")

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
