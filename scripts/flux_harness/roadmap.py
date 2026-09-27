"""Discover agent-owned milestones inside the founder's delegated product scope."""

import json
import re

from .github import HarnessError, digest


def configured_milestones(config):
    return [config["milestone"], *config.get("additional_milestones", [])]


def envelope(body, name):
    match = re.search(r"<!-- " + re.escape(name) + r"\s*(\{.*?\})\s*-->", body or "", re.S)
    if match:
        try:
            value = json.loads(match[1])
            return value if isinstance(value, dict) else {}
        except ValueError:
            pass
    return {}


def admitted(config, milestone):
    policy = config.get("milestone_discovery", {})
    metadata = envelope(milestone.get("description"), "flux-milestone:v1")
    return ((milestone.get("creator") or {}).get("login", "").casefold() in
            {login.casefold() for login in config["github"]["trusted_logins"]}
            and metadata.get("scope") == policy.get("scope")
            and metadata.get("phase") in ("planning", "implementation", "release"))


def scope_check(config, milestone):
    if config.get("milestone_discovery", {}).get("enabled"):
        if not admitted(config, milestone):
            raise HarnessError("Milestone lacks a trusted creator and the configured product scope marker")
        return
    selected = next((entry for entry in configured_milestones(config)
                     if entry["number"] == milestone["number"]), None)
    if selected is None:
        raise HarnessError("Wrong milestone returned by GitHub")
    if digest(milestone.get("description") or "") != selected["description_digest"]:
        raise HarnessError("Milestone description changed. Review the scope and update its committed digest.")


def milestone_numbers(github, config):
    numbers = {item["number"] for item in configured_milestones(config)}
    if config.get("milestone_discovery", {}).get("enabled"):
        for milestone in github.pages(f"{github.prefix}/milestones?state=all"):
            if admitted(config, milestone):
                numbers.add(milestone["number"])
    return sorted(numbers)


def read_snapshot(github, config):
    snapshots = [github.snapshot(number) for number in milestone_numbers(github, config)]
    for item in snapshots:
        scope_check(config, item["milestone"])
    return {"milestone": snapshots[0]["milestone"],
            "milestones": [item["milestone"] for item in snapshots],
            "issues": list({issue["number"]: issue for item in snapshots for issue in item["issues"]
                            if issue["number"] != config["peer_watch"]["issue_number"]}.values()),
            "pull_requests": list({pr["number"]: pr for item in snapshots for pr in item["pull_requests"]}.values())}


def accepted_product(snapshot, config):
    """Two authenticated peer reports, complete coverage, and closed required work.

    This checks coordination evidence, not application behavior. Peers must run
    the real scenarios; the runner additionally verifies live candidate CI.
    """
    if any(item["state"] != "closed" for item in snapshot["milestones"] + snapshot["issues"]):
        return None
    trusted = {login.casefold() for login in config["github"]["trusted_logins"]}
    required_areas = {f"8.{number}" for number in range(1, 17)}
    for issue in snapshot["issues"]:
        if issue.get("state_reason") != "completed" or "agent:product-acceptance" not in {
                label["name"] for label in issue.get("labels", [])}:
            continue
        reports = {}
        for comment in issue.get("comments", []):
            author = comment.get("user", {}).get("login", "").casefold()
            record = envelope(comment.get("body"), "flux-product-accepted:v1")
            if author in trusted and record:
                # The latest authored record replaces that author's old acceptance.
                reports[author] = record
        if set(reports) != trusted:
            continue
        records = list(reports.values())
        sha = records[0].get("candidate_sha", "")
        if not re.fullmatch(r"[a-f0-9]{40}", sha):
            continue
        if all(record.get("candidate_sha") == sha
               and record.get("scope") == config["milestone_discovery"]["scope"]
               and record.get("areas") == {key: "pass" for key in required_areas}
               and isinstance(record.get("evidence"), list) and record["evidence"]
               and all(isinstance(item, str) and item.strip() for item in record["evidence"])
               and isinstance(record.get("application_checks"), list) and record["application_checks"]
               and any(name != "Agent setup" for name in record["application_checks"])
               and all(isinstance(item, str) and item.strip() for item in record["application_checks"])
               for record in records):
            return {"candidate_sha": sha, "issue": issue["number"],
                    "checks": sorted({name for record in records for name in record["application_checks"]})}
    return None


def verify_product_ci(github, config, acceptance):
    sha = acceptance["candidate_sha"]
    head = github.api(f"{github.prefix}/commits/{config['github']['base_branch']}")["sha"]
    if head != sha:
        raise HarnessError("Product acceptance is stale: candidate differs from the protected base head")
    checks = github.pages(f"{github.prefix}/commits/{sha}/check-runs", "check_runs")
    required = set(acceptance["checks"])
    latest = {}
    for item in checks:
        if item["name"] not in latest or item["id"] > latest[item["name"]]["id"]:
            latest[item["name"]] = item
    if not required or any(name not in latest or latest[name].get("head_sha") != sha
                          or latest[name].get("conclusion") != "success"
                          or latest[name].get("status") != "completed"
                          or latest[name].get("app", {}).get("slug") != "github-actions" for name in required):
        raise HarnessError("Product acceptance is missing successful current application checks")
