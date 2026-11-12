"""Which releases a release upgrades from, and the sentence its notes say (#1241)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from release_versions import notes_line, parse, published_tags, supported, upgrades_from  # noqa: E402


class VersionsTest(unittest.TestCase):
    def test_v0_1_is_not_supported_and_v0_2_0_is(self) -> None:
        self.assertFalse(supported("v0.1.0"))
        self.assertFalse(supported("v0.1.9"))
        self.assertTrue(supported("v0.2.0"))
        self.assertTrue(supported("v1.0.0"))
        self.assertFalse(supported("main"))
        self.assertIsNone(parse("v0.2"))

    def test_a_release_candidate_sorts_before_its_release(self) -> None:
        self.assertLess(parse("v0.3.0-rc.1"), parse("v0.3.0"))  # type: ignore[operator]
        self.assertLess(parse("v0.2.10"), parse("v0.10.0"))  # type: ignore[operator]
        self.assertLess(parse("v0.2.9"), parse("v0.2.10"))  # type: ignore[operator]

    def test_a_candidate_upgrades_from_every_earlier_published_release(self) -> None:
        published = ["v0.1.0", "v0.2.1", "v0.2.0", "v0.3.0", "v0.2.10", "notes"]
        self.assertEqual(upgrades_from("v0.3.0", published), ["v0.2.0", "v0.2.1", "v0.2.10"])
        self.assertEqual(upgrades_from("v0.2.1", published), ["v0.2.0"])
        self.assertEqual(upgrades_from("v0.2.0", published), [])

    def test_drafts_are_not_published(self) -> None:
        releases = [{"tagName": "v0.2.0", "isDraft": False}, {"tagName": "v0.2.1", "isDraft": True}]
        self.assertEqual(published_tags(releases), ["v0.2.0"])

    def test_a_candidate_before_v0_2_0_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            upgrades_from("v0.1.1", ["v0.2.0"])

    def test_the_notes_name_every_version_that_was_tested(self) -> None:
        line = notes_line("v0.3.0", ["v0.2.1", "v0.2.0"])
        self.assertIn("Upgrades from: v0.2.0, v0.2.1.", line)
        self.assertIn("not supported", line)
        self.assertIn("first release", notes_line("v0.2.0", []))


if __name__ == "__main__":
    unittest.main()
