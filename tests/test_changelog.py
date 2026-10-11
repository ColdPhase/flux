"""Changelog fragments under changes/ (scripts/changelog.py)."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("flux_changelog", ROOT / "scripts/changelog.py")
changelog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changelog)


class ChangelogFragments(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "changes"
        self.dir.mkdir()
        (self.dir / "README.md").write_text("# Pending changelog entries\n")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        (self.dir / name).write_text(text, encoding="utf-8")

    def test_the_repository_fragments_are_valid(self):
        self.assertEqual(changelog.problems(), [])

    def test_a_valid_fragment_has_no_problems(self):
        self.write("468-search-projects.added.md", "- Search finds projects by name ([#468](https://example.test/468)).\n")
        self.assertEqual(changelog.problems(self.dir), [])

    def test_bad_names_sections_and_content_are_reported(self):
        self.write("search.added.md", "- x\n")
        self.write("12-x.improved.md", "- x\n")
        self.write("13-y.fixed.md", "no bullet\n")
        self.write("14-z.fixed.md", "\n")
        found = "\n".join(changelog.problems(self.dir))
        self.assertIn("search.added.md: name must be", found)
        self.assertIn("12-x.improved.md: section must be one of", found)
        self.assertIn("13-y.fixed.md: entries start with", found)
        self.assertIn("14-z.fixed.md: empty", found)

    def test_release_moves_entries_under_the_version_and_removes_the_files(self):
        log = Path(self.tmp.name) / "CHANGELOG.md"
        log.write_text("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Older entry.\n", encoding="utf-8")
        self.write("2-b.fixed.md", "- Fixed b.\n")
        self.write("1-a.added.md", "- Added a.\n")
        changelog.release("0.1.0", "2026-10-12", self.dir, log)
        text = log.read_text(encoding="utf-8")
        self.assertIn("## [Unreleased]\n\n## [0.1.0] - 2026-10-12\n\n### Added\n\n- Added a.\n\n### Fixed\n\n- Fixed b.", text)
        self.assertLess(text.index("## [0.1.0]"), text.index("- Older entry."))
        self.assertEqual(changelog.fragments(self.dir), [])
        self.assertTrue((self.dir / "README.md").exists())

    def test_release_without_fragments_refuses(self):
        log = Path(self.tmp.name) / "CHANGELOG.md"
        log.write_text("# Changelog\n\n## [Unreleased]\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            changelog.release("0.1.0", "2026-10-12", self.dir, log)


if __name__ == "__main__":
    unittest.main()
