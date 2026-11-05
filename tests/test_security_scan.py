"""The security scans' policy and allowlist (#834, #835): scripts/security_scan.py.

The policy is tested on small reports shaped like `pnpm audit --json` and `trivy image --format json`; nothing here runs
Docker, the network or a scanner. The workflows are checked for the rules of docs/agents/ci-and-releases.md.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

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
    return {"advisories": merged, "metadata": {"totalDependencies": 1234}}


def trivy_report(*vulnerabilities: dict) -> dict:
    return {"ArtifactName": "ghcr.io/coldphase/flux@sha256:" + "0" * 64,
            "Results": [{"Target": "app/node_modules", "Class": "lang-pkgs", "Vulnerabilities": list(vulnerabilities)}]}


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

    def test_an_entry_without_a_package_is_refused(self) -> None:
        without = entry()
        del without["package"]
        problems = self.check([without])
        self.assertEqual(len(problems), 1)
        self.assertIn("missing package", problems[0])
        self.assertTrue(any("package" in p for p in self.check([entry(package="")])))
        self.assertTrue(any("package" in p for p in self.check([entry(package="  ")])))

    def test_an_entry_without_a_package_excuses_nothing(self) -> None:
        without = entry(id="GHSA-cccc-ffff-gggg")
        del without["package"]
        self.assertFalse(scan.allowed([without], "audit", "GHSA-cccc-ffff-gggg", "fastify"))
        self.assertFalse(scan.allowed([without], "audit", "GHSA-cccc-ffff-gggg", ""))
        self.assertTrue(scan.allowed([entry(id="GHSA-cccc-ffff-gggg", package="fastify")], "audit", "GHSA-cccc-ffff-gggg", "fastify"))

    def test_an_entry_without_a_package_fails_the_allowlist_command_and_the_audit(self) -> None:
        without = entry(id="GHSA-cccc-ffff-gggg")
        del without["package"]
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(scan, "ALLOWLIST", allowlist_file(directory, [without])):
            report = Path(directory) / "audit.json"
            report.write_text(json.dumps(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "fastify", "high"))), encoding="utf-8")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(scan.main(["allowlist"]), scan.EXIT_FINDINGS)
                self.assertEqual(scan.main(["audit", "--json", str(report)]), scan.EXIT_FINDINGS)

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
        self.assertEqual(code, scan.EXIT_FINDINGS)
        self.assertIn("GHSA-cccc-ffff-gggg", text)

    def test_critical_fails_even_without_a_fix(self) -> None:
        code, _ = self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "x", "critical", fixed="None")), [])
        self.assertEqual(code, scan.EXIT_FINDINGS)

    def test_moderate_and_low_do_not_fail(self) -> None:
        code, _ = self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "x", "moderate"), advisory(2, "GHSA-cccc-ffff-gggh", "y", "low")), [])
        self.assertEqual(code, 0)

    def test_an_allowlisted_advisory_passes_for_its_package_only(self) -> None:
        listed = entry(id="GHSA-cccc-ffff-gggg", package="fastify")
        self.assertEqual(self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "fastify", "high")), [listed])[0], 0)
        self.assertEqual(self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "another", "high")), [listed])[0], scan.EXIT_FINDINGS)

    def test_an_image_exception_does_not_excuse_an_audit_finding(self) -> None:
        listed = entry(id="GHSA-cccc-ffff-gggg", package="fastify", scanner="image")
        self.assertEqual(self.run_audit(audit_report(advisory(1, "GHSA-cccc-ffff-gggg", "fastify", "high")), [listed])[0], scan.EXIT_FINDINGS)

    def test_an_expired_exception_fails_the_audit_even_when_nothing_is_found(self) -> None:
        code, text = self.run_audit(audit_report(), [entry(reviewed="2025-01-01", expires="2025-02-01")])
        self.assertEqual(code, scan.EXIT_FINDINGS)
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


class FailClosedTest(unittest.TestCase):
    """An unusable report, or a script that crashed, is never a clean scan and never the "findings" a pull request may let through."""

    # pnpm audit --json

    def audit_file(self, text: str) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ), \
                mock.patch.object(scan, "ALLOWLIST", allowlist_file(directory, [])):
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            report = Path(directory) / "audit.json"
            report.write_text(text, encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = scan.main(["audit", "--json", str(report)])
            return code, out.getvalue() + err.getvalue()

    def test_an_empty_audit_report_is_an_error(self) -> None:
        for text in ("", "  \n"):
            with self.subTest(text=text):
                code, output = self.audit_file(text)
                self.assertEqual(code, scan.EXIT_UNUSABLE)
                self.assertIn("empty", output)

    def test_an_empty_object_as_an_audit_report_is_an_error(self) -> None:
        code, output = self.audit_file("{}")
        self.assertEqual(code, scan.EXIT_UNUSABLE)
        self.assertIn("not a pnpm audit report", output)

    def test_an_audit_report_that_does_not_parse_is_an_error(self) -> None:
        for text in ("not json at all", '{"advisories": {', "ERR_PNPM_AUDIT_BAD_RESPONSE"):
            with self.subTest(text=text):
                code, output = self.audit_file(text)
                self.assertEqual(code, scan.EXIT_UNUSABLE)
                self.assertIn("not JSON", output)

    def test_an_error_document_or_a_report_that_scanned_nothing_is_an_error(self) -> None:
        for report in ([], {"error": {"code": "ERR_PNPM_AUDIT_BAD_RESPONSE"}}, {"advisories": None}, {"advisories": []},
                       {"advisories": {}, "metadata": {"totalDependencies": 0}}):
            with self.subTest(report=report):
                self.assertEqual(self.audit_file(json.dumps(report))[0], scan.EXIT_UNUSABLE)

    def test_an_audit_report_with_no_advisories_is_clean(self) -> None:
        self.assertEqual(self.audit_file(json.dumps(audit_report()))[0], scan.EXIT_CLEAN)

    # Trivy

    def trivy(self, report: str | None, returncode: int = 0) -> tuple[int, str, int, Path]:
        """Runs `image` against a fake scanner that writes `report` (or nothing) and exits `returncode`."""
        calls: list[list[str]] = []

        def fake(command, *args, **kwargs):
            calls.append(command)
            work = next(part for part in command if part.endswith(":/work:z")).split(":")[0]
            if report is not None:
                (Path(work) / "report.json").write_text(report, encoding="utf-8")
            return subprocess.CompletedProcess(command, returncode)

        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ), \
                mock.patch.object(scan, "ALLOWLIST", allowlist_file(directory, [])), \
                mock.patch.object(scan.time, "sleep"), mock.patch.object(scan.subprocess, "run", fake):
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            reports = Path(directory) / "reports"
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = scan.main(["image", "--report-dir", str(reports), "--cache", str(Path(directory) / "cache"), "ghcr.io/coldphase/flux@sha256:" + "0" * 64])
            kept = list(reports.glob("*.json"))
            return code, out.getvalue() + err.getvalue(), len(calls), (kept[0].read_text(encoding="utf-8") if kept else None)

    def test_an_empty_trivy_report_is_an_error_after_three_attempts(self) -> None:
        for text in ("", "\n"):
            with self.subTest(text=text):
                code, output, attempts, kept = self.trivy(text)
                self.assertEqual((code, attempts), (scan.EXIT_UNUSABLE, 3))
                self.assertIn("the report is empty", output)
                self.assertEqual(kept, text)  # kept for the run's artifact

    def test_an_empty_object_as_a_trivy_report_is_an_error(self) -> None:
        code, output, attempts, _ = self.trivy("{}")
        self.assertEqual((code, attempts), (scan.EXIT_UNUSABLE, 3))
        self.assertIn("not a Trivy report", output)

    def test_a_trivy_report_that_does_not_parse_is_an_error(self) -> None:
        for text in ("not json", '{"ArtifactName": "x", "Results": [', "FATAL unable to initialize"):
            with self.subTest(text=text):
                code, output, _, _ = self.trivy(text)
                self.assertEqual(code, scan.EXIT_UNUSABLE)
                self.assertIn("not JSON", output)

    def test_a_trivy_report_without_scanned_targets_is_an_error(self) -> None:
        for report in ({"ArtifactName": "img"}, {"ArtifactName": "img", "Results": []}, {"ArtifactName": "img", "Results": None},
                       {"ArtifactName": "img", "Metadata": {"OS": {"Family": "debian"}}}):
            with self.subTest(report=report):
                code, output, _, _ = self.trivy(json.dumps(report))
                self.assertEqual(code, scan.EXIT_UNUSABLE)
                self.assertIn("no scanned targets", output)

    def test_a_trivy_report_that_is_not_a_report_is_an_error(self) -> None:
        for report in ([], "text", None, {"Results": [{"Target": "x"}]}, {"error": "boom"}):
            with self.subTest(report=report):
                self.assertEqual(self.trivy(json.dumps(report))[0], scan.EXIT_UNUSABLE)

    def test_a_trivy_run_without_a_report_or_with_a_failing_exit_code_is_an_error(self) -> None:
        self.assertEqual(self.trivy(None)[0], scan.EXIT_UNUSABLE)
        code, output, attempts, _ = self.trivy(json.dumps(trivy_report()), returncode=1)
        self.assertEqual((code, attempts), (scan.EXIT_UNUSABLE, 3))
        self.assertIn("Trivy exited 1", output)

    def test_clean_and_failing_trivy_reports_keep_their_meaning(self) -> None:
        clean = {"ArtifactName": "img", "Results": [{"Target": "img (debian 13)", "Class": "os-pkgs", "Type": "debian"}]}
        self.assertEqual(self.trivy(json.dumps(clean))[0], scan.EXIT_CLEAN)
        self.assertEqual(self.trivy(json.dumps(trivy_report(vulnerability("CVE-2026-0001", "tar", "HIGH"))))[0], scan.EXIT_FINDINGS)

    # a crash

    def test_a_scanner_crash_has_its_own_exit_code_and_prints_the_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(scan, "ALLOWLIST", allowlist_file(directory, [])), \
                mock.patch.object(scan, "run_audit", side_effect=RuntimeError("boom")):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = scan.main(["audit"])
        self.assertEqual(code, scan.EXIT_CRASH)
        self.assertIn("Traceback", err.getvalue())
        self.assertIn("RuntimeError: boom", err.getvalue())

    def test_a_failing_docker_command_is_a_crash_and_a_missing_docker_too(self) -> None:
        for error in (subprocess.CalledProcessError(1, ["docker", "save"]), FileNotFoundError("docker")):
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as directory, \
                    mock.patch.object(scan, "ALLOWLIST", allowlist_file(directory, [])), mock.patch.object(scan.subprocess, "run", side_effect=error):
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    code = scan.main(["image", "--local", "--report-dir", directory + "/r", "--cache", directory + "/c", "flux:test"])
                self.assertEqual(code, scan.EXIT_CRASH)

    def test_the_exit_codes_are_distinct_and_none_is_the_interpreters_code_for_an_uncaught_error(self) -> None:
        codes = [scan.EXIT_CLEAN, scan.EXIT_FINDINGS, scan.EXIT_UNUSABLE, scan.EXIT_CRASH]
        self.assertEqual(len(set(codes)), 4)
        self.assertEqual(scan.EXIT_CLEAN, 0)
        self.assertNotIn(1, codes)


class ImageScanWorkflowTest(unittest.TestCase):
    """.github/workflows/image-scan.yml: a pull request lets the findings code through and nothing else."""

    TEXT = (ROOT / ".github" / "workflows" / "image-scan.yml").read_text(encoding="utf-8")

    def fails(self, rc: str, event: str) -> bool:
        """Evaluates the `if:` of the step that fails the job, for the exit code `rc` of the scan step."""
        condition = re.search(r"(?m)^\s+if: (steps\.scan\.outputs\.rc != .*)$", self.TEXT)
        self.assertIsNotNone(condition, "the step that fails the job has no condition on the scan's exit code")
        expression = condition.group(1).replace("steps.scan.outputs.rc", repr(rc)).replace("github.event_name", repr(event))
        return bool(eval(expression.replace("&&", " and ").replace("||", " or "), {"__builtins__": {}}))  # the repository's own text

    def test_on_a_pull_request_only_clean_and_findings_pass(self) -> None:
        for rc in (str(scan.EXIT_CLEAN), str(scan.EXIT_FINDINGS)):
            self.assertFalse(self.fails(rc, "pull_request"), rc)
        # 1 is the interpreter's code for an error nothing caught (an import or syntax error); 127 and 137 are a missing
        # interpreter and a killed process; the empty string is a step that wrote no code.
        for rc in (str(scan.EXIT_UNUSABLE), str(scan.EXIT_CRASH), "1", "127", "137", ""):
            self.assertTrue(self.fails(rc, "pull_request"), rc)

    def test_on_a_schedule_or_a_dispatch_anything_but_clean_fails(self) -> None:
        for event in ("schedule", "workflow_dispatch"):
            self.assertFalse(self.fails(str(scan.EXIT_CLEAN), event), event)
            for rc in (str(scan.EXIT_FINDINGS), str(scan.EXIT_UNUSABLE), str(scan.EXIT_CRASH), "1", ""):
                self.assertTrue(self.fails(rc, event), (event, rc))

    def test_only_the_findings_code_opens_the_issue_and_a_pull_request_validates_the_allowlist(self) -> None:
        self.assertIn(f"failed: ${{{{ steps.scan.outputs.rc == '{scan.EXIT_FINDINGS}' }}}}", self.TEXT)
        self.assertRegex(self.TEXT, r"(?s)- name: Validate the allowlist\n\s+if: github.event_name == 'pull_request'\n\s+run: python3 scripts/security_scan.py allowlist")


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

    def test_dependabot_batches_updates_rather_than_opening_one_pull_request_per_dependency(self) -> None:
        text = (ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8")
        # `group-by: dependency-name` is one pull request per dependency across directories: not a batch.
        self.assertNotRegex(text, r"(?m)^\s*group-by:")

    def dependabot_directories(self) -> dict[str, list[str]]:
        """ecosystem -> the directories (globs) its `updates` blocks list."""
        text = (ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8")
        found: dict[str, list[str]] = {}
        for block in re.split(r"(?m)^  - package-ecosystem: ", text)[1:]:
            ecosystem = block.split("\n", 1)[0].strip()
            listed = re.search(r"(?m)^    directories: \[(.*)\]", block)
            single = re.search(r"(?m)^    directory: (\S+)", block)
            names = listed.group(1).split(",") if listed else [single.group(1)] if single else []
            found.setdefault(ecosystem, []).extend(name.strip().strip('"') for name in names)
        return found

    def test_dependabot_covers_every_directory_with_a_manifest_a_lockfile_or_a_dockerfile(self) -> None:
        listing = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True) if shutil.which("git") else None
        if listing is None or listing.returncode != 0:
            self.skipTest("not a git checkout")
        configured = self.dependabot_directories()
        # Documented in dependabot.yml: the Playwright pin must equal the tag of the image in docker/ui-tests.Dockerfile, and the
        # prototype Dockerfile is the evidence of a research issue, not something that is built.
        deliberately_left_out = {"pip": {"/app/tests/ui"}, "docker": {"/docs/product/research/evidence/460"}}

        def covered(ecosystem: str, directory: str) -> bool:
            return any(re.fullmatch(glob.replace("*", "[^/]+"), directory) for glob in configured.get(ecosystem, []))

        wanted: dict[str, set[str]] = {"npm": set(), "docker": set(), "docker-compose": set(), "pip": set()}
        for name in listing.stdout.splitlines():
            directory, base = "/" + str(Path(name).parent).strip("."), Path(name).name
            directory = directory.rstrip("/") or "/"
            if base in ("package.json", "package-lock.json", "pnpm-lock.yaml"):
                wanted["npm"].add(directory)
            elif "dockerfile" in base.lower():
                wanted["docker"].add(directory)
            elif re.fullmatch(r"(docker-)?compose[\w.-]*\.ya?ml", base):
                wanted["docker-compose"].add(directory)
            elif base == "requirements.txt":
                wanted["pip"].add(directory)
        for ecosystem, directories in wanted.items():
            for directory in sorted(directories - deliberately_left_out.get(ecosystem, set())):
                with self.subTest(ecosystem=ecosystem, directory=directory):
                    self.assertTrue(covered(ecosystem, directory), f"dependabot.yml does not cover {directory} ({ecosystem})")
        self.assertIn("/site", configured["npm"])


if __name__ == "__main__":
    unittest.main()
