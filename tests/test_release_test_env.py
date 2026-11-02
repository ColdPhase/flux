"""Smoke credentials must be fresh and never overwrite operator configuration."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from write_test_env import write  # noqa: E402


class TestEnvironmentTest(unittest.TestCase):
    def test_generates_secrets_without_overwriting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / ".env.example"
            destination = Path(directory) / ".env"
            source.write_text(
                "POSTGRES_PASSWORD=replace\nFLUX_AUTH_SECRET=replace\n"
                "FLUX_KEYRING_TOKEN=\nFLUX_KEY_PIN_SECRET=\n"
                "FLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081\nFLUX_FIXTURE_TOKEN=\n"
            )
            write(source, destination, 18081)
            value = destination.read_text()
            self.assertNotIn("replace", value)
            # A real deployment leaves the test-only fixture endpoint disabled.
            self.assertIn("\nFLUX_FIXTURE_TOKEN=\n", value)
            self.assertIn("FLUX_PUBLIC_ORIGIN=http://127.0.0.1:18081", value)
            self.assertIn("FLUX_PORT=18081", value)
            # INSTALL.md names the keyring secrets; without them no encrypted workspace can be created.
            self.assertRegex(value, r"\nFLUX_KEYRING_TOKEN=[0-9a-f]{64}\n")
            self.assertRegex(value, r"\nFLUX_KEY_PIN_SECRET=[0-9a-f]{64}\n")
            with self.assertRaisesRegex(ValueError, "overwrite"):
                write(source, destination, 18082)
