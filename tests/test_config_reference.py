"""The operator configuration reference (#780) must match the code it is generated from."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("config_reference", ROOT / "scripts" / "config_reference.py")
reference = importlib.util.module_from_spec(SPEC)
sys.modules["config_reference"] = reference
SPEC.loader.exec_module(reference)


class ConfigReferenceTest(unittest.TestCase):
    def test_reference_matches_the_code(self) -> None:
        self.assertEqual(reference.problems(), [])

    def test_every_operator_variable_is_documented_once(self) -> None:
        page = reference.PAGE.read_text(encoding="utf-8")
        for name in reference.VARIABLES:
            with self.subTest(name=name):
                self.assertEqual(page.count(f"\n### `{name}`\n"), 1)

    def test_unknown_name_in_the_code_is_reported(self) -> None:
        found = reference.scan_names()
        found["FLUX_NOT_DOCUMENTED_YET"] = {"app/apps/server/src/config.ts"}
        original = reference.scan_names
        reference.scan_names = lambda: found
        try:
            self.assertTrue(any("FLUX_NOT_DOCUMENTED_YET" in error for error in reference.problems()))
        finally:
            reference.scan_names = original

    def test_a_setting_without_a_way_in_is_reported(self) -> None:
        reference.VARIABLES["FLUX_SIGNUP_COPY"] = reference.Var("identity", "x", "y")
        original = reference.scan_names
        found = reference.scan_names()
        found["FLUX_SIGNUP_COPY"] = {"app/apps/server/src/identity/config.ts"}
        reference.scan_names = lambda: found
        try:
            self.assertTrue(any("FLUX_SIGNUP_COPY is read by the code, but no Compose file" in error for error in reference.problems()))
        finally:
            reference.scan_names = original
            del reference.VARIABLES["FLUX_SIGNUP_COPY"]

    def test_launcher_help_is_copied(self) -> None:
        self.assertIn("./flux backup [--output DIR] [--keep N]", reference.PAGE.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
