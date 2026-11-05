#!/usr/bin/env python3
"""Dependency and image security scans with one policy and one allowlist (#834, #835).

    python3 scripts/security_scan.py audit                  # pnpm audit --prod in Docker
    python3 scripts/security_scan.py image REF [REF ...]    # Trivy in Docker, registry references
    python3 scripts/security_scan.py image --local NAME ... # Trivy on images in the local Docker engine
    python3 scripts/security_scan.py allowlist              # validate .github/security-allowlist.json

Policy (docs/agents/ci-and-releases.md, "Security scanning"):

- `audit` fails on any HIGH or CRITICAL advisory in the production dependencies of app/ (`pnpm audit --prod`) that the
  allowlist does not name. Fixed or not: an advisory without a fix needs an allowlist entry with its reason.
- `image` fails on any HIGH or CRITICAL finding that HAS a fixed version and is not allowlisted. Findings without a fix
  are reported and do not fail.
- An allowlist entry (`.github/security-allowlist.json`) names the scanner (`audit` or `image`), the advisory or CVE, the
  package, a reason, a tracking link, the review date and an expiry at most 90 days after it. An expired entry fails the
  scan until somebody reviews it again or removes it; a malformed entry (a missing `package` included) fails too.
- The scan fails closed. A report that is empty, not JSON, not the scanner's report (`{}`, an error document) or lists no
  scanned target is an error, never "clean".

Exit codes (the Image scan workflow relies on them; anything not listed, such as the interpreter's 1 for an error that
escapes this script, is a crash and fails the job):

    0    clean
    10   findings: a policy failure (HIGH/CRITICAL findings, an expired or malformed allowlist entry); the only code that a
         pull request run of the Image scan lets through
    2    the scan did not run or its report is unusable (registry or advisory database unreachable, no report, empty,
         unparsable or without scanned targets, an unreadable allowlist)
    3    the script crashed (an unexpected exception; the traceback is printed)

The scanners run in containers pinned by digest, the same way the application's checks do: the Node image and pnpm
version are read from docker/Dockerfile, so the audit uses the toolchain that builds the lockfile. Python standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST = ROOT / ".github" / "security-allowlist.json"
DOCKERFILE = ROOT / "docker" / "Dockerfile"
# Trivy, pinned (v0.76.1, released 2026-10-21; the digest of the multi-platform index).
TRIVY_IMAGE = "ghcr.io/aquasecurity/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"
FAILING = ("HIGH", "CRITICAL")
MAX_EXCEPTION_DAYS = 90
SCANNERS = ("audit", "image")
ENTRY_KEYS = {"scanner", "id", "package", "reason", "tracking", "reviewed", "expires"}
REQUIRED_KEYS = ENTRY_KEYS  # every key; an entry without `package` would excuse the advisory in every package
EXIT_CLEAN = 0
EXIT_UNUSABLE = 2
EXIT_CRASH = 3
# Not 1: that is what the interpreter exits with for an exception nothing caught (an import error, a syntax error), which
# must never look like "findings" to a workflow that lets findings through on a pull request.
EXIT_FINDINGS = 10
ID_PATTERN = re.compile(r"(GHSA(-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})\Z")


class Problem(Exception):
    """A configuration or tool failure (EXIT_UNUSABLE), as opposed to a policy failure (EXIT_FINDINGS)."""


# --- the allowlist -------------------------------------------------------------------------------------------------

def load_allowlist(path: Path | None = None, today: dt.date | None = None) -> tuple[list[dict], list[str]]:
    """Returns the entries and the problems found in them (malformed, or expired on `today`)."""
    path = path or ALLOWLIST
    today = today or dt.date.today()
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise Problem(f"cannot read {path}: {error}") from error
    entries = document.get("exceptions")
    if not isinstance(entries, list):
        raise Problem(f"{path}: `exceptions` must be a list")
    problems: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    for index, entry in enumerate(entries):
        label = f"exception {index + 1}" + (f" ({entry.get('id')})" if isinstance(entry, dict) else "")
        if not isinstance(entry, dict):
            problems.append(f"{label}: must be an object")
            continue
        missing = REQUIRED_KEYS - entry.keys()
        extra = entry.keys() - ENTRY_KEYS
        if missing:
            problems.append(f"{label}: missing {', '.join(sorted(missing))}")
            continue
        if extra:
            problems.append(f"{label}: unknown keys {', '.join(sorted(extra))}")
        if entry["scanner"] not in SCANNERS:
            problems.append(f"{label}: scanner must be one of {', '.join(SCANNERS)}")
        if not isinstance(entry["id"], str) or not ID_PATTERN.match(entry["id"]):
            problems.append(f"{label}: id must be a GHSA or CVE identifier")
        if not isinstance(entry["package"], str) or not entry["package"].strip():
            problems.append(f"{label}: package must name the package the exception is for")
        if not isinstance(entry["reason"], str) or len(entry["reason"].strip()) < 30:
            problems.append(f"{label}: the reason must say why the risk is accepted, in at least 30 characters")
        if not isinstance(entry["tracking"], str) or not entry["tracking"].startswith(("https://github.com/", "#")):
            problems.append(f"{label}: tracking must be a GitHub issue or PR link")
        try:
            reviewed = dt.date.fromisoformat(entry["reviewed"])
            expires = dt.date.fromisoformat(entry["expires"])
        except (TypeError, ValueError):
            problems.append(f"{label}: reviewed and expires must be dates (YYYY-MM-DD)")
            continue
        if reviewed > today:
            problems.append(f"{label}: reviewed {reviewed} is in the future")
        if expires <= reviewed or (expires - reviewed).days > MAX_EXCEPTION_DAYS:
            problems.append(f"{label}: expires must be after reviewed and at most {MAX_EXCEPTION_DAYS} days later")
        if expires < today:
            problems.append(f"{label}: expired on {expires}; review it again (new dates) or remove it")
        key = (entry["scanner"], entry["id"], entry["package"])
        if key in seen:
            problems.append(f"{label}: listed twice")
        seen.add(key)
    return [entry for entry in entries if isinstance(entry, dict)], problems


def allowed(entries: Iterable[dict], scanner: str, finding_id: str, package: str) -> bool:
    """An entry excuses one advisory in one package; an entry without a package excuses nothing."""
    return bool(package) and any(entry.get("scanner") == scanner and entry.get("id") == finding_id and entry.get("package") == package
                                 for entry in entries)


# --- pnpm audit ----------------------------------------------------------------------------------------------------

def toolchain() -> tuple[str, str]:
    """The pinned Node image and the pnpm version of the Dockerfile's build toolchain."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    image = re.search(r"(?m)^FROM (node@sha256:[0-9a-f]{64}) AS (?:toolchain|build)$", text)
    pnpm = re.search(r"corepack install -g pnpm@(\d+\.\d+\.\d+)", text)
    if not image or not pnpm:
        raise Problem("docker/Dockerfile no longer has a build toolchain stage on a pinned Node image with a pinned pnpm")
    return image.group(1), pnpm.group(1)


def parse_report(text: str, what: str) -> object:
    """The JSON of a scanner's report; an empty or unparsable one is a Problem."""
    if not text.strip():
        raise Problem(f"{what}: the report is empty")
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise Problem(f"{what}: the report is not JSON ({error})") from error


def validate_audit_report(report: object, what: str = "pnpm audit") -> dict:
    """A `pnpm audit --json` report that scanned something. `{}` or an error document is not a clean report."""
    if not isinstance(report, dict) or not isinstance(report.get("advisories"), dict):
        raise Problem(f"{what}: not a pnpm audit report (no `advisories` object): {json.dumps(report)[:200]}")
    metadata = report.get("metadata")
    total = metadata.get("totalDependencies") if isinstance(metadata, dict) else None
    if total is not None and not (isinstance(total, int) and total > 0):
        raise Problem(f"{what}: the report counts {total!r} dependencies, so nothing was scanned")
    return report


def run_audit() -> dict:
    image, pnpm = toolchain()
    command = ["docker", "run", "--rm", "-v", f"{ROOT / 'app'}:/work:ro,z", "-w", "/work", image, "sh", "-c",
               f"corepack enable && corepack install -g pnpm@{pnpm} >/dev/null 2>&1 && pnpm audit --prod --json"]
    last = ""
    for attempt in range(1, 4):
        result = subprocess.run(command, capture_output=True, text=True)
        # pnpm exits 1 when it found advisories and still prints the report; no report is a failure of the audit itself.
        try:
            return validate_audit_report(parse_report(result.stdout, "pnpm audit"))
        except Problem as error:
            last = f"{error}; {(result.stderr or '')[-300:]}"
        if attempt < 3:
            time.sleep(5 * attempt)
    raise Problem(f"pnpm audit gave no usable report after 3 attempts (registry unreachable?): {last.strip()}")


def audit_findings(report: dict) -> list[dict]:
    findings = []
    for advisory in (report.get("advisories") or {}).values():
        version = (advisory.get("findings") or [{}])[0].get("version", "")
        findings.append({
            "id": advisory.get("github_advisory_id") or str(advisory.get("id")),
            "severity": str(advisory.get("severity", "")).upper(),
            "package": advisory.get("module_name", ""),
            "installed": version,
            "fixed": advisory.get("patched_versions") if advisory.get("patched_versions") not in (None, "None", "<0.0.0") else "",
            "title": advisory.get("title", ""),
            "url": advisory.get("url", ""),
        })
    return findings


# --- Trivy ---------------------------------------------------------------------------------------------------------

def image_findings(report: dict) -> list[dict]:
    findings = []
    for result in report.get("Results") or []:
        for vulnerability in result.get("Vulnerabilities") or []:
            findings.append({
                "id": vulnerability.get("VulnerabilityID", ""),
                "severity": str(vulnerability.get("Severity", "")).upper(),
                "package": vulnerability.get("PkgName", ""),
                "installed": vulnerability.get("InstalledVersion", ""),
                "fixed": vulnerability.get("FixedVersion", "") or "",
                "title": vulnerability.get("Title", "") or "",
                "url": vulnerability.get("PrimaryURL", "") or "",
                "target": result.get("Target", ""),
            })
    return findings


def validate_trivy_report(report: object, reference: str) -> dict:
    """A Trivy report of an artifact with scanned targets. `{}` or a report without `Results` is not a clean image."""
    if not isinstance(report, dict) or not report.get("ArtifactName"):
        raise Problem(f"{reference}: not a Trivy report (no `ArtifactName`): {json.dumps(report)[:200]}")
    results = report.get("Results")
    if not isinstance(results, list) or not results:
        raise Problem(f"{reference}: the report has no scanned targets (`Results` is missing or empty), so nothing was checked")
    return report


def run_trivy(reference: str, report_file: Path, *, local: bool, platform: str, cache: Path, network: str, insecure: bool) -> dict:
    report_file.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="flux-scan-") as work:
        os.chmod(work, 0o777)  # the scanner runs as root in its container but may be rootless
        arguments = ["image", "--quiet", "--scanners", "vuln", "--severity", "HIGH,CRITICAL", "--format", "json",
                     "--output", "/work/report.json", "--timeout", "15m"]
        if local:
            subprocess.run(["docker", "save", reference, "-o", f"{work}/image.tar"], check=True)
            arguments += ["--input", "/work/image.tar"]
        else:
            arguments += ["--image-src", "remote", reference]
            if platform:
                arguments += ["--platform", platform]
            if insecure:
                arguments += ["--insecure"]
        command = ["docker", "run", "--rm", "--network", network, "-v", f"{work}:/work:z", "-v", f"{cache}:/root/.cache:z",
                   "-e", "TRIVY_USERNAME", "-e", "TRIVY_PASSWORD", TRIVY_IMAGE, *arguments]
        last = ""
        for attempt in range(1, 4):
            result = subprocess.run(command)
            report_path = Path(work) / "report.json"
            if result.returncode != 0:
                last = f"Trivy exited {result.returncode}"
            elif not report_path.exists():
                last = "Trivy wrote no report"
            else:
                shutil.copy(report_path, report_file)  # kept for the run's artifact even when it is unusable
                try:
                    return validate_trivy_report(parse_report(report_path.read_text(encoding="utf-8"), reference), reference)
                except Problem as error:
                    last = str(error)
            if attempt < 3:
                time.sleep(10 * attempt)  # the vulnerability database and registries answer 429 now and then
        raise Problem(f"Trivy could not scan {reference} after 3 attempts: {last}")


# --- reports -------------------------------------------------------------------------------------------------------

def judge(findings: list[dict], scanner: str, entries: list[dict], *, need_fix: bool) -> tuple[list[dict], list[dict], list[dict]]:
    """(failing, allowlisted, unfixed) among the HIGH/CRITICAL findings."""
    failing, excused, unfixed = [], [], []
    for finding in findings:
        if finding["severity"] not in FAILING:
            continue
        if need_fix and not finding["fixed"]:
            unfixed.append(finding)
        elif allowed(entries, scanner, finding["id"], finding["package"]):
            excused.append(finding)
        else:
            failing.append(finding)
    return failing, excused, unfixed


def table(findings: list[dict], *, target: bool = False) -> list[str]:
    rows = ["| Severity | Id | Package | Installed | Fixed in | Title |", "| --- | --- | --- | --- | --- | --- |"] if not target else \
           ["| Severity | Id | Package | Installed | Fixed in | Title | Target |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for f in sorted(findings, key=lambda item: (item["severity"] != "CRITICAL", item["package"], item["id"])):
        title = f["title"].replace("|", "\\|")[:90]
        row = f"| {f['severity']} | [{f['id']}]({f['url']}) | {f['package']} | {f['installed']} | {f['fixed'] or '-'} | {title} |" if f["url"] \
              else f"| {f['severity']} | {f['id']} | {f['package']} | {f['installed']} | {f['fixed'] or '-'} | {title} |"
        rows.append(row + (f" {f['target']} |" if target else ""))
    return rows


def fingerprint(findings: list[dict]) -> str:
    """Stable over the set of failing findings, so a weekly scan can tell new findings from the same ones."""
    keys = sorted({f"{f['id']}:{f['package']}" for f in findings})
    return hashlib.sha256("\n".join(keys).encode()).hexdigest()[:16]


def emit(markdown: str, summary_file: str | None = None) -> None:
    print(markdown)
    if summary_file:
        Path(summary_file).write_text(markdown + "\n", encoding="utf-8")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(markdown + "\n")


# --- commands ------------------------------------------------------------------------------------------------------

def command_allowlist(_: argparse.Namespace) -> int:
    entries, problems = load_allowlist()
    for problem in problems:
        print(f"allowlist: {problem}", file=sys.stderr)
    print(f"allowlist: {len(entries)} exceptions, {len(problems)} problems")
    return EXIT_FINDINGS if problems else EXIT_CLEAN


def command_audit(arguments: argparse.Namespace) -> int:
    entries, problems = load_allowlist()
    if arguments.json:
        try:
            text = Path(arguments.json).read_text(encoding="utf-8")
        except OSError as error:
            raise Problem(f"cannot read {arguments.json}: {error}") from error
        report = validate_audit_report(parse_report(text, arguments.json), arguments.json)
    else:
        report = run_audit()
    findings = audit_findings(report)
    failing, excused, _ = judge(findings, "audit", entries, need_fix=False)
    lines = ["## Dependency audit (`pnpm audit --prod`)", "",
             f"{len(findings)} advisories in production dependencies; {len(failing)} HIGH/CRITICAL not allowlisted, "
             f"{len(excused)} HIGH/CRITICAL allowlisted."]
    if failing:
        lines += ["", "### Fails the check", "", *table(failing)]
    if excused:
        lines += ["", "<details><summary>Allowlisted HIGH/CRITICAL (reviewed exceptions)</summary>", "", *table(excused), "", "</details>"]
    lines += [""] + [f"Allowlist problem: {problem}" for problem in problems]
    emit("\n".join(lines), arguments.summary_file)
    if failing:
        print("\nTo accept a finding you have reviewed, add it to .github/security-allowlist.json with a reason, a tracking link and an expiry "
              "(docs/agents/ci-and-releases.md#security-scanning). Otherwise upgrade the package.", file=sys.stderr)
    return EXIT_FINDINGS if failing or problems else EXIT_CLEAN


def command_image(arguments: argparse.Namespace) -> int:
    entries, problems = load_allowlist()
    report_dir = Path(arguments.report_dir)
    cache = Path(arguments.cache or os.environ.get("TRIVY_CACHE_DIR") or Path(tempfile.gettempdir()) / "flux-trivy-cache")
    platforms = [p for p in (arguments.platforms or "").split(",") if p] or [""]
    lines = ["## Image scan (Trivy)", ""]
    failed: list[dict] = []
    for reference in arguments.references:
        for platform in platforms:
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_", reference.split("/")[-1] + ("-" + platform if platform else ""))
            report = run_trivy(reference, report_dir / f"{name}.json", local=arguments.local, platform=platform, cache=cache,
                               network=arguments.network, insecure=arguments.insecure)
            findings = image_findings(report)
            failing, excused, unfixed = judge(findings, "image", entries, need_fix=True)
            failed += failing
            lines += [f"### `{reference}`" + (f" on {platform}" if platform else ""), "",
                      f"HIGH/CRITICAL: {len(failing)} fixable and not allowlisted (fail), {len(excused)} allowlisted, {len(unfixed)} without a fix (reported only).", ""]
            if failing:
                lines += table(failing, target=True) + [""]
            if unfixed:
                lines += ["<details><summary>Without a fixed version</summary>", "", *table(unfixed, target=True), "", "</details>", ""]
    lines += [f"Fingerprint of the failing findings: `{fingerprint(failed)}`", ""] + [f"Allowlist problem: {problem}" for problem in problems]
    emit("\n".join(lines), arguments.summary_file)
    if arguments.fingerprint_file:
        Path(arguments.fingerprint_file).write_text(fingerprint(failed) + "\n", encoding="utf-8")
    return EXIT_FINDINGS if failed or problems else EXIT_CLEAN


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("allowlist", help="validate the allowlist").set_defaults(run=command_allowlist)
    audit = commands.add_parser("audit", help="pnpm audit --prod on app/pnpm-lock.yaml")
    audit.add_argument("--json", help="read this `pnpm audit --json` report instead of running pnpm (for tests)")
    audit.add_argument("--summary-file", help="also write the Markdown summary to this file")
    audit.set_defaults(run=command_audit)
    image = commands.add_parser("image", help="Trivy on container images")
    image.add_argument("references", nargs="+", help="registry references (digest-pinned in releases), or local names with --local")
    image.add_argument("--local", action="store_true", help="the references are images of the local Docker engine (docker save)")
    image.add_argument("--platforms", help="comma-separated, for example linux/amd64,linux/arm64 (registry images only)")
    image.add_argument("--report-dir", default="security-reports")
    image.add_argument("--cache", help="Trivy's cache directory (the vulnerability database); default $TRIVY_CACHE_DIR or a temporary directory")
    image.add_argument("--network", default="bridge", help="Docker network of the scanner; `host` reaches a registry on 127.0.0.1")
    image.add_argument("--insecure", action="store_true", help="allow plain HTTP to the registry (a throwaway local registry)")
    image.add_argument("--fingerprint-file", help="write the fingerprint of the failing findings here")
    image.add_argument("--summary-file", help="also write the Markdown summary to this file")
    image.set_defaults(run=command_image)
    arguments = parser.parse_args(argv)
    try:
        return arguments.run(arguments)
    except Problem as error:
        print(f"security_scan: {error}", file=sys.stderr)
        return EXIT_UNUSABLE
    except Exception:  # a crash is neither clean nor findings: it gets its own code, and it fails the job everywhere
        traceback.print_exc()
        print("security_scan: crashed (see the traceback above); the scan did not complete", file=sys.stderr)
        return EXIT_CRASH


if __name__ == "__main__":
    sys.exit(main())
