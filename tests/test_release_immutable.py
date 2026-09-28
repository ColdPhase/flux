"""A changed or invalid repository setting must stop release publication."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "release" / "check_immutable_releases.py"


class ImmutableReleaseTest(unittest.TestCase):
    def test_only_explicit_enabled_boolean_allows_publication(self) -> None:
        cases = (
            ('{"enabled":true,"enforced_by_owner":false}', 0),
            ('{"enabled":false}', 1),
            ('{"enabled":"true"}', 1),
            ('{"immutable":true}', 1),
            ('[]', 1),
            ('not json', 1),
        )
        for payload, expected in cases:
            with self.subTest(payload=payload):
                result = subprocess.run(
                    [sys.executable, str(CHECKER)], input=payload,
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
