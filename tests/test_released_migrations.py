"""A released migration never changes (#1241): every migration file of every release from v0.2.0 on is byte-identical to the file
of its release tag. The negative controls edit, delete and renumber on a throwaway repository and must each be refused."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from check_released_migrations import MIGRATIONS, NoReleaseTags, check, release_tags  # noqa: E402


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", *args],
        check=True, capture_output=True,
    )


class RepositoryTest(unittest.TestCase):
    def test_every_released_migration_is_byte_identical_to_its_tag(self) -> None:
        if not release_tags(ROOT):
            if os.environ.get("GITHUB_ACTIONS"):
                self.fail("the release tags are not fetched: the checkout needs `fetch-tags: true`, or this check passes without checking")
            self.skipTest("no release tags in this clone (git fetch --tags)")
        self.assertEqual(check(ROOT), [])


class ThrowawayRepositoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.dir = self.repo / MIGRATIONS
        self.dir.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.dir / "0003_first.sql").write_text("CREATE TABLE a (id int);\n", encoding="utf-8")
        (self.dir / "0005_second.sql").write_text("CREATE TABLE b (id int);\n", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "release")
        git(self.repo, "tag", "v0.2.0")

    def test_the_tagged_files_pass(self) -> None:
        self.assertEqual(check(self.repo), [])

    def test_a_new_migration_after_the_last_released_one_passes(self) -> None:
        (self.dir / "0006_third.sql").write_text("CREATE TABLE c (id int);\n", encoding="utf-8")
        self.assertEqual(check(self.repo), [])

    def test_an_edited_released_migration_is_refused(self) -> None:
        with (self.dir / "0003_first.sql").open("a", encoding="utf-8") as file:
            file.write("-- a comment is a change too\n")
        problems = check(self.repo)
        self.assertEqual(len(problems), 1)
        self.assertIn("0003_first.sql differs from the file of v0.2.0", problems[0])

    def test_a_deleted_or_renamed_released_migration_is_refused(self) -> None:
        (self.dir / "0005_second.sql").rename(self.dir / "0005_renamed.sql")
        problems = check(self.repo)
        self.assertTrue(any("0005_second.sql is in v0.2.0 and is gone" in problem for problem in problems), problems)

    def test_a_new_migration_numbered_below_the_last_released_one_is_refused(self) -> None:
        (self.dir / "0004_gap.sql").write_text("CREATE TABLE gap (id int);\n", encoding="utf-8")
        self.assertTrue(any("0004_gap.sql is new and numbered at or below" in problem for problem in check(self.repo)))

    def test_a_file_edited_between_two_releases_is_refused(self) -> None:
        (self.dir / "0003_first.sql").write_text("CREATE TABLE a (id bigint);\n", encoding="utf-8")
        git(self.repo, "commit", "-qam", "edit")
        git(self.repo, "tag", "v0.2.1")
        self.assertTrue(any("differs between v0.2.0 and v0.2.1" in problem for problem in check(self.repo)))

    def test_another_directory_is_checked_against_the_tags(self) -> None:
        other = self.repo / "copy"
        other.mkdir()
        for path in self.dir.iterdir():
            (other / path.name).write_bytes(path.read_bytes())
        (other / "0003_first.sql").write_text("DROP TABLE a;\n", encoding="utf-8")
        self.assertEqual(len(check(self.repo, other)), 1)

    def test_a_clone_without_tags_cannot_pass(self) -> None:
        git(self.repo, "tag", "-d", "v0.2.0")
        with self.assertRaises(NoReleaseTags):
            check(self.repo)

    def test_v0_1_is_not_a_release_that_counts(self) -> None:
        (self.dir / "0001_baseline.sql").write_text("CREATE TABLE old (id int);\n", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "v0.1")
        git(self.repo, "tag", "v0.1.0")
        (self.dir / "0001_baseline.sql").write_text("CREATE TABLE changed (id int);\n", encoding="utf-8")
        self.assertEqual(release_tags(self.repo), ["v0.2.0"])


if __name__ == "__main__":
    unittest.main()
