"""A release is drafted only when it upgrades from every earlier release from v0.2.0 on (#1241): the jobs, their order, what each runs,
and the notes. The upgrade itself is proved by scripts/check_upgrade_matrix.sh and the release run; this checks the gate around it."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FINAL = (ROOT / ".github/workflows/final-release.yml").read_text(encoding="utf-8")
CHECKS = (ROOT / ".github/workflows/repository-checks.yml").read_text(encoding="utf-8")


def job(text: str, name: str) -> str:
    match = re.search(rf"^  {name}:\n(.*?)(?=^  [a-z_]+:\n|\Z)", text, re.S | re.M)
    assert match, name
    return match.group(1)


class UpgradeGateTest(unittest.TestCase):
    def test_the_candidate_job_names_the_releases_to_upgrade_from(self) -> None:
        candidate = job(FINAL, "candidate")
        self.assertIn("release_versions.py from --candidate", candidate)
        self.assertIn("previous: ${{ steps.upgrade_from.outputs.previous }}", candidate)
        self.assertIn("upgrade_from: ${{ steps.upgrade_from.outputs.upgrade_from }}", candidate)
        self.assertIn("fetch-depth: 0", candidate, "the release tags are needed")

    def test_the_package_job_upgrades_from_the_previous_release_with_its_own_assets(self) -> None:
        package = job(FINAL, "package")
        step = package[package.index("Upgrade from the previous release"):]
        step = step[:step.index("- name: Check the runtime overlay")]
        for part in ('gh release download "$PREVIOUS_VERSION"', "sha256sum -c SHA256SUMS", "FLUX_SMOKE_LEGS=upgrade", "FLUX_SMOKE_RECOVERY=1",
                     "FLUX_SMOKE_PREVIOUS_ASSETS=previous-assets", "smoke_artifacts.sh release-assets"):
            self.assertIn(part, step)
        self.assertIn("if: needs.candidate.outputs.previous != ''", step)

    def test_the_upgrade_job_runs_the_matrix_on_the_candidates_own_assets_for_every_earlier_release(self) -> None:
        upgrade = job(FINAL, "upgrade")
        self.assertRegex(upgrade, r"needs: \[candidate, image, package\]")
        self.assertIn("fetch-depth: 0", upgrade, "the source-checkout legs run git archive of each release tag")
        self.assertIn("name: release-assets", upgrade)
        self.assertIn("FLUX_MATRIX_CANDIDATE_ASSETS: release-assets", upgrade)
        self.assertIn("bash scripts/check_upgrade_matrix.sh", upgrade)
        self.assertIn('= "$UPGRADE_FROM"', upgrade, "what was tested must equal what the candidate job named")
        self.assertIn("tested: ${{ steps.matrix.outputs.tested }}", upgrade)
        self.assertNotIn("packages: write", upgrade)
        self.assertNotIn("contents: write", upgrade)

    def test_nothing_is_signed_or_drafted_when_an_upgrade_fails(self) -> None:
        self.assertRegex(job(FINAL, "sign"), r"needs: \[candidate, image, package, scan, upgrade\]")
        self.assertRegex(job(FINAL, "draft"), r"needs: \[candidate, image, package, scan, upgrade, sign\]")

    def test_the_notes_say_which_versions_it_upgrades_from_as_tested(self) -> None:
        draft = job(FINAL, "draft")
        self.assertIn("UPGRADE_TESTED: ${{ needs.upgrade.outputs.tested }}", draft)
        self.assertIn("release_versions.py\" notes --candidate \"$RELEASE_VERSION\" $UPGRADE_TESTED", draft)
        self.assertIn("$upgrade_line", draft)
        self.assertLess(draft.index("upgrade_line=$("), draft.index("cat > \"$RUNNER_TEMP/release-notes.md\""))

    def test_the_workflow_still_publishes_nothing(self) -> None:
        self.assertNotIn("gh release publish", FINAL)
        self.assertNotIn("--draft=false", FINAL)

    def test_the_repository_check_fetches_the_release_tags_for_the_immutability_test(self) -> None:
        self.assertIn("fetch-tags: true", CHECKS)


if __name__ == "__main__":
    unittest.main()
