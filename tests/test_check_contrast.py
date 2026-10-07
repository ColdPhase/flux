"""`scripts/check_contrast.py` on the final design's tokens (#338): `--failures-only` (#201) prints only
failing pairs and a summary with the same exit code, and an accent colour fails.

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
        original = "--t3: #6b6b6b;"
        self.assertIn(original, css, "fixture expects the light muted text token")
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "tokens.css"
            broken.write_text(css.replace(original, "--t3: #c8ccd4;", 1))
            result = run("--failures-only", "--tokens", str(broken))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        lines = result.stdout.strip().splitlines()
        self.assertTrue(lines[:-1], "the failing pairs are printed")
        self.assertTrue(all(line.startswith("FAIL") for line in lines[:-1]), result.stdout)
        self.assertTrue(any("--t3 on --bg" in line for line in lines[:-1]), result.stdout)
        self.assertRegex(lines[-1], r"^\d+ pairs checked, [1-9]\d* failed$")

    def test_an_accent_token_fails(self) -> None:
        css = TOKENS.read_text()
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "tokens.css"
            broken.write_text(css.replace("--t1: #18181b;", "--t1: #18181b;\n  --accent: #28664f;", 1))
            result = run("--failures-only", "--tokens", str(broken))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("accent", result.stdout)

    def test_default_output_is_unchanged(self) -> None:
        result = run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("ok   light"), result.stdout[:80])
        self.assertNotIn("pairs checked", result.stdout)


if __name__ == "__main__":
    unittest.main()
