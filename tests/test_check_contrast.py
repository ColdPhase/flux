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

    def test_default_output_is_unchanged(self) -> None:
        result = run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("ok   light/mint"), result.stdout[:80])
        self.assertNotIn("pairs checked", result.stdout)


if __name__ == "__main__":
    unittest.main()
