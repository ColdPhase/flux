"""The security scans' policy and allowlist (#834, #835): scripts/security_scan.py.

The policy is tested on small reports shaped like `pnpm audit --json` and `trivy image --format json`; nothing here runs
Docker, the network or a scanner. The workflows are checked for the rules of docs/agents/ci-and-releases.md.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("security_scan", ROOT / "scripts" / "security_scan.py")
scan = importlib.util.module_from_spec(SPEC)
sys.modules["security_scan"] = scan
SPEC.loader.exec_module(scan)

TODAY = dt.date.today()


def entry(**changes: str) -> dict:
    base = {"scanner": "audit", "id": "GHSA-965c-763c-88jm", "package": "better-auth", "reason": "Reviewed: the plugin the advisory names is not enabled here.",
            "tracking": "https://github.com/ColdPhase/flux/issues/877", "reviewed": TODAY.isoformat(), "expires": (TODAY + dt.timedelta(days=30)).isoformat()}
    base.update(changes)
    return base


def allowlist_file(directory: str, entries: list[dict]) -> Path:
    path = Path(directory) / "allowlist.json"
    path.write_text(json.dumps({"exceptions": entries}), encoding="utf-8")
    return path


def advisory(number: int, ghsa: str, package: str, severity: str, fixed: str = ">=2.0.0") -> dict:
    return {str(number): {"id": number, "github_advisory_id": ghsa, "module_name": package, "severity": severity, "title": f"{package} problem",
                          "patched_versions": fixed, "url": f"https://github.com/advisories/{ghsa}", "findings": [{"version": "1.0.0", "paths": ["a>b"]}]}}


def audit_report(*advisories: dict) -> dict:
    merged: dict = {}
    for item in advisories:
        merged.update(item)
    return {"advisories": merged, "metadata": {}}


def trivy_report(*vulnerabilities: dict) -> dict:
    return {"Results": [{"Target": "app/node_modules", "Class": "lang-pkgs", "Vulnerabilities": list(vulnerabilities)}]}


def vulnerability(identifier: str, package: str, severity: str, fixed: str = "2.0.0") -> dict:
    return {"VulnerabilityID": identifier, "PkgName": package, "InstalledVersion": "1.0.0", "FixedVersion": fixed, "Severity": severity, "Title": "t"}


class AllowlistTest(unittest.TestCase):
    def check(self, entries: list[dict], today: dt.date = TODAY) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            return scan.load_allowlist(allowlist_file(directory, entries), today)[1]

    def test_a_reviewed_entry_with_a_reason_and_an_expiry_passes(self) -> None:
        self.assertEqual(self.check([entry()]), [])

    def test_an_expired_entry_fails_until_it_is_reviewed_again(self) -> None:
        problems = self.check([entry()], TODAY + dt.timedelta(days=31))
        self.assertEqual(len(problems), 1)
        self.assertIn(f"expired on {TODAY + dt.timedelta(days=30)}", problems[0])

    def test_an_expiry_more_than_90_days_after_the_review_is_refused(self) -> None:
        self.assertTrue(any("at most 90 days" in p for p in self.check([entry(expires=(TODAY + dt.timedelta(days=91)).isoformat())])))

    def test_a_missing_reason_tracking_or_expiry_and_a_bad_id_are_refused(self) -> None:
        self.assertTrue(any("missing" in p for p in self.check([{"scanner": "audit", "id": "GHSA-965c-763c-88jm"}])))
        self.assertTrue(any("reason" in p for p in self.check([entry(reason="later")])))
        self.assertTrue(any("tracking" in p for p in self.check([entry(tracking="")])))
        self.assertTrue(any("GHSA or CVE" in p for p in self.check([entry(id="fastify")])))
        self.assertTrue(any("scanner" in p for p in self.check([entry(scanner="everything")])))

    def test_an_entry_listed_twice_is_refused(self) -> None:
        self.assertTrue(any("twice" in p for p in self.check([entry(), entry()])))

    def test_the_committed_allowlist_is_well_formed(self) -> None:
        # Its own newest review date stands for "today", so the test does not start failing when an exception expires: the scan does that.
        entries, _ = scan.load_allowlist(scan.ALLOWLIST, dt.date.max)
        newest = max((dt.date.fromisoformat(e["reviewed"]) for e in entries), default=TODAY)
        _, problems = scan.load_allowlist(scan.ALLOWLIST, newest)
        self.assertEqual(problems, [])


class AuditPolicyTest(unittest.TestCase):
    def run_audit(self, report: dict, entries: list[dict]) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as directory:
            original = scan.ALLOWLIST
            scan.ALLOWLIST = allowlist_file(directory, entries)
            (Path(directory) / "audit.json").write_text(json.dumps(report), encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            try:
                with redirect_stdout(out), redirect_stderr(err):
                    code = scan.main(["audit", "--json", str(Path(directory) / "audit.json")])
            finally:
                scan.ALLOWLIST = original
            return code, out.getvalue() + err.getvalue()

    def test_a_new_high_advisory_fails(self) -> None:
        code, text = self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "fastify", "high")), [])
        self.assertEqual(code, 1)
        self.assertIn("GHSA-cccc-ffff-gggg", text)

    def test_critical_fails_even_without_a_fix(self) -> None:
        code, _ = self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "x", "critical", fixed="None")), [])
        self.assertEqual(code, 1)

    def test_moderate_and_low_do_not_fail(self) -> None:
        code, _ = self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "x", "moderate"), advisory(2, "GHSA-cccc-ffff-gggh", "y", "low")), [])
        self.assertEqual(code, 0)

    def test_an_allowlisted_advisory_passes_for_its_package_only(self) -> None:
        listed = entry(id="GHSA-cccc-ffff-gggg", package="fastify")
        self.assertEqual(self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "fastify", "high")), [listed])[0], 0)
        self.assertEqual(self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "another", "high")), [listed])[0], 1)

    def test_an_image_exception_does_not_excuse_an_audit_finding(self) -> None:
        listed = entry(id="GHSA-cccc-ffff-gggg", package="fastify", scanner="image")
        self.assertEqual(self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "fastify", "high")), [listed])[0], 1)

    def test_an_expired_exception_fails_the_audit_even_when_nothing_is_found(self) -> None:
        code, text = self.run_audit(audit_report(), [entry(reviewed="2025-01-01", expires="2025-02-01")])
        self.assertEqual(code, 1)
        self.assertIn("expired", text)


class ImagePolicyTest(unittest.TestCase):
    def judge(self, report: dict, entries: list[dict]) -> tuple[int, int, int]:
        failing, excused, unfixed = scan.judge(scan.image_findings(report), "image", entries, need_fix=True)
        return len(failing), len(excused), len(unfixed)

    def test_a_fixable_high_or_critical_finding_fails(self) -> None:
        report = trivy_report(vulnerability("CVE-2026-0001", "tar", "HIGH"), vulnerability("CVE-2026-0002", "zlib", "CRITICAL"))
        self.assertEqual(self.judge(report, []), (2, 0, 0))

    def test_a_finding_without_a_fixed_version_is_reported_and_does_not_fail(self) -> None:
        self.assertEqual(self.judge(trivy_report(vulnerability("CVE-2026-0003", "tar", "HIGH", fixed="")), []), (0, 0, 1))

    def test_medium_findings_are_not_judged(self) -> None:
        self.assertEqual(self.judge(trivy_report(vulnerability("CVE-2026-0004", "tar", "MEDIUM")), []), (0, 0, 0))

    def test_an_allowlisted_finding_passes_and_an_audit_exception_does_not_count(self) -> None:
        report = trivy_report(vulnerability("CVE-2026-0005", "tar", "HIGH"))
        self.assertEqual(self.judge(report, [entry(scanner="image", id="CVE-2026-0005", package="tar")]), (0, 1, 0))
        self.assertEqual(self.judge(report, [entry(scanner="audit", id="CVE-2026-0005", package="tar")]), (1, 0, 0))

    def test_the_fingerprint_follows_the_set_of_findings_not_their_order(self) -> None:
        a, b = scan.image_findings(trivy_report(vulnerability("CVE-2026-0001", "tar", "HIGH"), vulnerability("CVE-2026-0002", "zlib", "HIGH"))), []
        b = list(reversed(a))
        self.assertEqual(scan.fingerprint(a), scan.fingerprint(b))
        self.assertNotEqual(scan.fingerprint(a), scan.fingerprint(a[:1]))


class ToolchainTest(unittest.TestCase):
    def test_the_audit_uses_the_toolchain_of_the_dockerfile(self) -> None:
        image, pnpm = scan.toolchain()
        self.assertRegex(image, r"^node@sha256:[0-9a-f]{64}$")
        self.assertRegex(pnpm, r"^\d+\.\d+\.\d+$")
        self.assertIn(f"pnpm@{pnpm}", (ROOT / "app" / "package.json").read_text(encoding="utf-8"))

    def test_trivy_is_pinned_by_digest(self) -> None:
        self.assertRegex(scan.TRIVY_IMAGE, r"^ghcr\.io/aquasecurity/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$")


class WorkflowRulesTest(unittest.TestCase):
    """docs/agents/ci-and-releases.md: pinned actions, least privilege, cancelled superseded runs, no privileged PR triggers."""

    FILES = ("dependency-audit.yml", "codeql.yml", "image-scan.yml")

    def text(self, name: str) -> str:
        return (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")

    def test_every_action_is_pinned_to_a_commit(self) -> None:
        for name in self.FILES + ("final-release.yml",):
            for use in re.findall(r"(?m)^\s*(?:-\s*)?uses:\s*(\S+)", self.text(name)):
                with self.subTest(file=name, action=use):
                    self.assertRegex(use, r"@[0-9a-f]{40}$")

    def test_pull_request_workflows_are_unprivileged_and_cancel_superseded_runs(self) -> None:
        for name in self.FILES:
            text = self.text(name)
            with self.subTest(file=name):
                self.assertNotIn("pull_request_target", text)
                self.assertRegex(text, r"(?m)^concurrency:")
                self.assertIn("cancel-in-progress: true", text)
                self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n")
                self.assertRegex(text, r"timeout-minutes: \d+")

    def test_no_job_of_a_pull_request_scan_can_write_to_the_repository(self) -> None:
        for name in ("dependency-audit.yml", "codeql.yml"):
            self.assertNotRegex(self.text(name), r"contents: write|pull-requests: write|issues: write", name)

    def test_the_release_workflow_scans_both_images_before_the_draft(self) -> None:
        text = self.text("final-release.yml")
        self.assertRegex(text, r"(?m)^  scan:\n    name: Scan the images")
        self.assertRegex(text, r"needs: \[candidate, image, package, scan\]")
        self.assertIn("scripts/security_scan.py image", text)

    def test_dependabot_covers_the_three_ecosystems_with_a_limit_and_weekly_grouping(self) -> None:
        text = (ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8")
        for ecosystem in ("npm", "github-actions", "docker"):
            self.assertIn(f"package-ecosystem: {ecosystem}", text)
        self.assertEqual(text.count("interval: weekly"), text.count("package-ecosystem:"))
        self.assertEqual(text.count("open-pull-requests-limit:"), text.count("package-ecosystem:"))
        self.assertEqual(text.count("groups:"), text.count("package-ecosystem:"))


if __name__ == "__main__":
    unittest.main()
