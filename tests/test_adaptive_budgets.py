"""The agreed adaptive-layout performance budgets are one table (#151 AC-4, #155 AC-4).

`docs/design/adaptive-workspaces.md`, "Agreed performance budgets", is the contract; the opt-in
`app/tests/ui/motion_performance.py` harness asserts it. A budget changed in one place and not the other
would let the harness pass or fail against a number nobody agreed. This reads both without starting a
browser and fails on any difference. Standard library only.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "design" / "adaptive-workspaces.md"
HARNESS = ROOT / "app" / "tests" / "ui" / "motion_performance.py"
PROFILES = ("desktop", "phone-cpu4")


def agreed() -> dict[str, dict[str, int]]:
    """`| \\`key\\` | what it measures | desktop ms | phone ms |` rows under the budget heading."""
    text = DOC.read_text(encoding="utf-8")
    section = text.split("## Agreed performance budgets", 1)[1].split("\n## ", 1)[0]
    table: dict[str, dict[str, int]] = {profile: {} for profile in PROFILES}
    for row in re.finditer(r"^\| `(\w+)` \|[^|]*\| (\d+) \| (\d+) \|", section, re.M):
        key, desktop, phone = row.groups()
        table["desktop"][key] = int(desktop)
        table["phone-cpu4"][key] = int(phone)
    return table


def harness() -> dict[str, dict[str, int]]:
    tree = ast.parse(HARNESS.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(target, "id", "") == "BUDGETS" for target in node.targets):
            return {profile: values for profile, values in ast.literal_eval(node.value).items()}
    raise AssertionError("BUDGETS not found in motion_performance.py")


class AdaptiveBudgets(unittest.TestCase):
    def test_the_harness_asserts_exactly_the_agreed_table(self):
        table, constants = agreed(), harness()
        for profile in PROFILES:
            self.assertTrue(table[profile], f"{profile}: no budget rows in the design document")
            self.assertEqual(constants[profile], table[profile], f"{profile}: harness BUDGETS differ from {DOC.name}")

    def test_every_budget_is_a_positive_number_of_milliseconds_and_the_phone_has_no_less_room(self):
        table = agreed()
        for key, desktop in table["desktop"].items():
            self.assertGreater(desktop, 0, key)
            self.assertGreaterEqual(table["phone-cpu4"][key], desktop, f"{key}: a throttled phone cannot be held to less than the desktop")


if __name__ == "__main__":
    unittest.main()
