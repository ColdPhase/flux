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


def constant(name: str):
    tree = ast.parse(HARNESS.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(target, "id", "") == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in motion_performance.py")


def harness() -> dict[str, dict[str, int]]:
    return constant("BUDGETS")


def classify_misses():
    """The harness's own `classify_misses`, executed without importing it (it needs a browser library) against its constants."""
    tree = ast.parse(HARNESS.read_text(encoding="utf-8"))
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "classify_misses")
    namespace = {"KNOWN_MISSES": constant("KNOWN_MISSES"), "JITTER_MS": constant("JITTER_MS")}
    exec(compile(ast.Module([node], []), str(HARNESS), "exec"), namespace)
    return namespace["classify_misses"]


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

    def test_a_known_miss_has_its_issue_and_a_ceiling_in_the_document_and_the_harness_enforces_it(self):
        section = DOC.read_text(encoding="utf-8").split("## Agreed performance budgets", 1)[1].split("\n## ", 1)[0]
        known = constant("KNOWN_MISSES")
        self.assertTrue(known, "no known misses: delete this test and the section's paragraph with them")
        classify = classify_misses()
        for miss, entry in known.items():
            self.assertIn(entry["issue"], section, f"{miss}: its issue is named in the budgets section")
            self.assertIn(f"{entry['maxP95']} ms", section, f"{miss}: its ceiling is named in the budgets section")
            ceiling = entry["maxP95"]
            within, unexpected, closed = classify([miss], {miss: ceiling})
            self.assertEqual((list(within), unexpected, closed), ([miss], [], []), "at its ceiling it stays a known miss")
            within, unexpected, closed = classify([miss], {miss: ceiling + 16.7})
            self.assertEqual((within, unexpected, closed), ({}, [miss], []), "one frame above its ceiling it fails the run")
            within, unexpected, closed = classify([], {})
            self.assertEqual((within, unexpected, closed), ({}, [], sorted(known)), "no longer missing it must be deleted")
        within, unexpected, closed = classify(["desktop:workTab:maxFrameGap"], {"desktop:workTab:maxFrameGap": 51.0})
        self.assertEqual(unexpected, ["desktop:workTab:maxFrameGap"], "a budget that is not a known miss fails the run")


if __name__ == "__main__":
    unittest.main()
