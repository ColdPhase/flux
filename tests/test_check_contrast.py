"""`scripts/check_contrast.py --failures-only` (#201): only failing pairs and a summary, same exit code.

Runs the script on the real tokens and on a copy with one deliberately weakened token.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check_contrast.py"
TOKENS = ROOT / "app/apps/web/src/ui/tokens.css"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=30)


class FailuresOnlyTest(unittest.TestCase):
    def test_passing_tokens_print_only_the_summary(self) -> None:
        result = run("--failures-only")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = result.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, result.stdout)
        self.assertRegex(lines[0], r"^\d+ pairs checked, 0 failed$")

    def test_a_weak_token_prints_that_pair_and_exits_1(self) -> None:
        css = TOKENS.read_text()
        original = "--text-3: #5e6a7d;"
        self.assertIn(original, css, "fixture expects the light muted text token")
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "tokens.css"
            broken.write_text(css.replace(original, "--text-3: #c8ccd4;", 1))
            result = run("--failures-only", "--tokens", str(broken))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        lines = result.stdout.strip().splitlines()
        self.assertTrue(lines[:-1], "the failing pairs are printed")
        self.assertTrue(all(line.startswith("FAIL") for line in lines[:-1]), result.stdout)
        self.assertTrue(any("--text-3 on --bg" in line for line in lines[:-1]), result.stdout)
        self.assertRegex(lines[-1], r"^\d+ pairs checked, [1-9]\d* failed$")

    def run_broken(self, original: str, replacement: str, after: str) -> subprocess.CompletedProcess[str]:
        """The script on a copy whose first `original` after `after` is replaced."""
        css = TOKENS.read_text()
        start = css.index(after)
        at = css.index(original, start)
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "tokens.css"
            broken.write_text(css[:at] + replacement + css[at + len(original):])
            return run("--failures-only", "--tokens", str(broken))

    def test_the_phone_palette_is_checked_in_both_themes(self) -> None:
        """F-025 PA-1: the phone values (≤640 px) are their own palettes, light and dark."""
        result = run()
        self.assertEqual(result.returncode, 0, result.stdout)
        for theme in ("phone/light", "phone/dark"):
            self.assertIn(f"ok   {theme} ", result.stdout)
        self.assertIn("a person's initials on the quiet fill", result.stdout)

    def test_a_weak_phone_token_fails_only_on_phones(self) -> None:
        result = self.run_broken("--text-2: #6b6660;", "--text-2: #b5b0a9;", "@media (max-width: 640px) {")
        self.assertEqual(result.returncode, 1, result.stdout)
        failing = result.stdout.strip().splitlines()[:-1]
        self.assertTrue(failing and all("phone/light" in line for line in failing), result.stdout)

    def test_phone_chrome_that_follows_the_accent_fails(self) -> None:
        result = self.run_broken("--accent: #151515;", "--accent: var(--accent-light);", "@media (max-width: 640px) {")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL phone/light chrome follows the person's accent family", result.stdout)

    def test_the_two_phone_dark_blocks_must_match(self) -> None:
        result = self.run_broken("--bubble: #262524;", "--bubble: #2a2928;", "@media (max-width: 640px) and (prefers-color-scheme: dark)")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL phone dark tokens differ between the media query and [data-theme=dark]", result.stdout)

    def test_default_output_is_unchanged(self) -> None:
        result = run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("ok   light/mint"), result.stdout[:80])
        self.assertNotIn("pairs checked", result.stdout)


if __name__ == "__main__":
    unittest.main()
