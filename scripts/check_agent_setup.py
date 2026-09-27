#!/usr/bin/env python3
"""Check the agent foundation offline, using only the Python standard library.

This validates repository structure and configuration, not a live agent runner,
GitHub enforcement, application correctness, or permission to publish anything.
"""

import argparse
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit


def validate(root: Path) -> list[str]:
    root = root.resolve()
    errors: list[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    def record(value: object, name: str, fields: set[str]) -> dict:
        if not isinstance(value, dict):
            errors.append(f"{name}: expected an object")
            return {}
        missing, unknown = fields - value.keys(), value.keys() - fields
        require(not missing, f"{name}: missing fields {sorted(missing)}")
        require(not unknown, f"{name}: unknown fields {sorted(unknown)}")
        return value

    def text_list(value: object, name: str) -> list[str]:
        valid = isinstance(value, list) and all(
            isinstance(item, str) and bool(item.strip()) for item in value
        )
        require(valid, f"{name}: expected a list of nonempty strings")
        return value if valid else []

    def positive(value: object) -> bool:
        return type(value) is int and value > 0

    def inside_file(value: object, name: str) -> None:
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{name}: expected a repository-relative file path")
            return
        path = root / value
        require(
            not Path(value).is_absolute()
            and path.resolve().is_relative_to(root)
            and path.is_file(),
            f"{name}: missing file or path outside the repository",
        )

    manifest = root / ".harness/project.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [f".harness/project.json: {error}"]

    data = record(data, "manifest", {
        "version", "state", "github", "workers", "milestone", "loop", "limits",
        "verification", "merge", "publishing", "deployment", "local_state_directory",
        "additional_milestones", "milestone_discovery", "peer_watch",
    })
    require(type(data.get("version")) is int and data["version"] == 4,
            "manifest.version: supported version is 4")
    require(data.get("state") in ("design", "active"),
            "manifest.state: expected design or active")

    github = record(data.get("github"), "github", {
        "repository", "base_branch", "trusted_logins",
    })
    require(isinstance(github.get("repository"), str) and
            bool(re.fullmatch(r"[\w.-]+/[\w.-]+", github["repository"])),
            "github.repository: expected owner/repository")
    require(isinstance(github.get("base_branch"), str) and
            bool(github["base_branch"].strip()), "github.base_branch: required")
    logins = text_list(github.get("trusted_logins"), "github.trusted_logins")
    trusted = {login.casefold() for login in logins}
    require(bool(trusted) and len(trusted) == len(logins),
            "github.trusted_logins: must be nonempty and unique")

    workers = data.get("workers")
    require(isinstance(workers, list) and len(workers) == 2,
            "workers: this topology requires two workers")
    ids, accounts = [], []
    for index, value in enumerate(workers if isinstance(workers, list) else []):
        worker = record(value, f"workers[{index}]", {"id", "provider", "github_login"})
        worker_id = worker.get("id")
        require(isinstance(worker_id, str) and
                bool(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", worker_id)),
                f"workers[{index}].id: expected a lowercase hyphenated ID")
        require(worker.get("provider") in ("codex", "claude"),
                f"workers[{index}].provider: expected codex or claude")
        account = worker.get("github_login")
        require(isinstance(account, str) and account.casefold() in trusted,
                f"workers[{index}].github_login: must be a trusted identity")
        if isinstance(worker_id, str):
            ids.append(worker_id)
        if isinstance(account, str):
            accounts.append(account.casefold())
    require(len(ids) == len(set(ids)), "workers: IDs must be distinct")
    require(len(accounts) == len(set(accounts)),
            "workers: GitHub identities must be distinct for independent review")

    release = record(data.get("milestone"), "milestone", {
        "number", "phase", "brief_path", "description_digest", "spec_path", "architecture_path",
    })
    require(release.get("phase") in ("planning", "implementation", "release"),
            "milestone.phase: expected planning, implementation or release")
    for key in ("number",):
        require(release.get(key) is None or positive(release[key]),
                f"milestone.{key}: expected null or a positive integer")
    for key in ("brief_path", "spec_path", "architecture_path"):
        if release.get(key) is not None:
            inside_file(release[key], f"milestone.{key}")
    pinned_digest = release.get("description_digest")
    require(pinned_digest is None or (isinstance(pinned_digest, str) and
            bool(re.fullmatch(r"sha256:[a-f0-9]{64}", pinned_digest))),
            "milestone.description_digest: expected null or a SHA-256 digest")

    extra = data.get("additional_milestones")
    require(isinstance(extra, list), "additional_milestones: expected a list")
    numbers = [release.get("number")]
    phases = [release.get("phase")]
    for index, value in enumerate(extra if isinstance(extra, list) else []):
        name = f"additional_milestones[{index}]"
        item = record(value, name, {"number", "phase", "brief_path", "description_digest",
                                   "spec_path", "architecture_path"})
        require(positive(item.get("number")), f"{name}.number: expected a positive integer")
        require(item.get("phase") in ("planning", "implementation", "release"), f"{name}.phase: invalid")
        inside_file(item.get("brief_path"), f"{name}.brief_path")
        require(isinstance(item.get("description_digest"), str) and
                bool(re.fullmatch(r"sha256:[a-f0-9]{64}", item["description_digest"])), f"{name}: invalid digest")
        for key in ("spec_path", "architecture_path"):
            if item.get(key) is not None or item.get("phase") == "release":
                inside_file(item.get(key), f"{name}.{key}")
        numbers.append(item.get("number"))
        phases.append(item.get("phase"))
    require(len(numbers) == len(set(numbers)), "milestones: numbers must be unique")
    discovery = record(data.get("milestone_discovery"), "milestone_discovery", {"enabled", "scope"})
    require(type(discovery.get("enabled")) is bool, "milestone_discovery.enabled: expected boolean")
    require(isinstance(discovery.get("scope"), str) and
            bool(re.fullmatch(r"[a-z0-9-]+", discovery["scope"])), "milestone_discovery.scope: invalid")

    loop = record(data.get("loop"), "loop", {
        "enabled", "poll_seconds", "max_active_tasks_per_worker",
        "max_attempts_without_progress", "coordinator",
    })
    for key in ("poll_seconds", "max_attempts_without_progress"):
        require(positive(loop.get(key)), f"loop.{key}: expected a positive integer")
    require(type(loop.get("max_active_tasks_per_worker")) is int and
            loop["max_active_tasks_per_worker"] == 1,
            "loop.max_active_tasks_per_worker: must be 1 for this topology")
    require(loop.get("coordinator") in ids, "loop.coordinator: must identify a configured worker")

    limits = record(data.get("limits"), "limits", {"max_run_minutes", "max_turn_minutes", "max_turns"})
    for key in ("max_run_minutes", "max_turn_minutes", "max_turns"):
        require(limits.get(key) is None or positive(limits[key]),
                f"limits.{key}: expected null or a positive integer")
    watch = record(data.get("peer_watch"), "peer_watch", {
        "issue_number", "heartbeat_seconds", "stale_after_seconds", "startup_wait_seconds",
        "provider_idle_seconds",
    })
    for key in ("issue_number", "heartbeat_seconds", "stale_after_seconds", "startup_wait_seconds",
                "provider_idle_seconds"):
        require(positive(watch.get(key)), f"peer_watch.{key}: expected a positive integer")
    if positive(watch.get("heartbeat_seconds")) and positive(watch.get("stale_after_seconds")):
        require(watch["heartbeat_seconds"] >= 30, "peer_watch.heartbeat_seconds: minimum 30 seconds")
        require(watch["stale_after_seconds"] >= 3 * watch["heartbeat_seconds"],
                "peer_watch.stale_after_seconds: allow at least three heartbeats")
    if positive(watch.get("provider_idle_seconds")) and positive(limits.get("max_turn_minutes")):
        require(watch["provider_idle_seconds"] <= limits["max_turn_minutes"] * 60,
                "peer_watch.provider_idle_seconds: cannot exceed the turn deadline")
    checks = record(data.get("verification"), "verification", {
        "repository_commands", "task_commands", "release_commands", "required_status_checks",
    })
    check_lists = {key: text_list(checks.get(key), f"verification.{key}") for key in (
        "repository_commands", "task_commands", "release_commands", "required_status_checks",
    )}
    require(bool(check_lists["repository_commands"]),
            "verification.repository_commands: the foundation needs a real check")

    merge = record(data.get("merge"), "merge", {"enabled", "mode"})
    require(merge.get("mode") == "peer-review-and-required-checks",
            "merge.mode: expected peer-review-and-required-checks")
    publishing = record(data.get("publishing"), "publishing", {
        "enabled", "target", "formats",
    })
    require(publishing.get("target") == "github-releases",
            "publishing.target: expected github-releases")
    formats = text_list(publishing.get("formats"), "publishing.formats")
    if publishing.get("enabled") is True:
        require(bool(formats), "publishing.formats: required before publication")
    deployment = record(data.get("deployment"), "deployment", {"enabled", "target"})
    target = deployment.get("target")
    require(target is None or (isinstance(target, str) and bool(target.strip())),
            "deployment.target: expected null or a nonempty string")
    if deployment.get("enabled") is True:
        require(isinstance(target, str) and bool(target.strip()),
                "deployment.target: required before deployment")

    for name, capability in (("loop", loop), ("merge", merge),
                             ("publishing", publishing), ("deployment", deployment)):
        require(type(capability.get("enabled")) is bool, f"{name}.enabled: expected boolean")
        if data.get("state") == "design":
            require(capability.get("enabled") is False,
                    f"{name}.enabled: must remain false in design state")
    if data.get("state") == "active":
        require(loop.get("enabled") is True, "active state requires loop.enabled")
        require(positive(release.get("number")), "active milestone requires milestone.number")
        inside_file(release.get("brief_path"), "active milestone.brief_path")
        require(pinned_digest is not None, "active milestone requires milestone.description_digest")
        if "release" in phases:
            if release.get("phase") == "release":
                for key in ("spec_path", "architecture_path"):
                    inside_file(release.get(key), f"active milestone.{key}")
            for key in ("task_commands", "release_commands", "required_status_checks"):
                require(bool(check_lists[key]), f"active release requires verification.{key}")
        require(positive(limits.get("max_turn_minutes")),
                "active milestone requires a positive limits.max_turn_minutes")
        if positive(limits.get("max_turn_minutes")) and positive(limits.get("max_run_minutes")):
            require(limits["max_turn_minutes"] <= limits["max_run_minutes"],
                    "limits.max_turn_minutes cannot exceed max_run_minutes")
    if all(phase == "planning" for phase in phases):
        require(publishing.get("enabled") is False and deployment.get("enabled") is False,
                "planning milestones cannot enable publication or deployment")

    require(data.get("local_state_directory") == ".harness/local",
            "local_state_directory: expected .harness/local")
    ignore = root / ".gitignore"
    require(ignore.is_file() and "/.harness/local/" in ignore.read_text().splitlines(),
            ".gitignore: must exclude /.harness/local/")
    agents = root / "AGENTS.md"
    require(agents.is_file() and agents.stat().st_size < 32768,
            "AGENTS.md: must exist and fit the instruction budget")
    claude = root / "CLAUDE.md"
    require(claude.is_file() and "@AGENTS.md" in claude.read_text().splitlines(),
            "CLAUDE.md: must import @AGENTS.md")
    shared = root / ".agents/skills"
    claude_skills = root / ".claude/skills"
    require(claude_skills.is_symlink() and claude_skills.resolve() == shared.resolve()
            and shared.is_dir(), ".claude/skills: must link to the shared .agents/skills")

    skill_files = sorted(shared.glob("*/SKILL.md"))
    require(bool(skill_files), ".agents/skills: no SKILL.md files found")
    skill_names = {path.parent.name for path in skill_files}
    documents = [root / "README.md", agents, claude, root / "docs/README.md",
                 root / "docs/CONTRIBUTING.md", *sorted((root / "docs/agents").rglob("*.md")),
                 *sorted((root / "docs/product").rglob("*.md")),
                 *sorted((root / "docs/design").rglob("*.md")),
                 *skill_files]
    for path in skill_files:
        body = path.read_text(encoding="utf-8")
        parts = body.split("---", 2)
        if len(parts) != 3 or parts[0].strip():
            errors.append(f"{path.relative_to(root)}: missing YAML frontmatter")
            continue
        name = re.search(r"^name:\s*([^\n]+)$", parts[1], re.MULTILINE)
        description = re.search(r"^description:\s*([^\n]+)$", parts[1], re.MULTILINE)
        require(name is not None and name[1].strip(" \"'") == path.parent.name,
                f"{path.relative_to(root)}: name must match its folder")
        require(description is not None and bool(description[1].strip(" \"'")),
                f"{path.relative_to(root)}: needs a single-line description")

    for path in documents:
        if not path.is_file():
            errors.append(f"missing document: {path.relative_to(root)}")
            continue
        content = path.read_text(encoding="utf-8")
        for skill in re.findall(r"`(flux-[a-z0-9-]+)`", content):
            require(skill in skill_names,
                    f"{path.relative_to(root)}: references missing skill {skill}")
        for link in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", content):
            url = urlsplit(link.strip().strip("<>"))
            if url.scheme or url.netloc or not url.path:
                continue
            destination = (path.parent / unquote(url.path)).resolve()
            require(destination.is_relative_to(root) and destination.exists(),
                    f"{path.relative_to(root)}: broken/local-external link {link}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        errors = validate(args.root)
    except (OSError, UnicodeError, ValueError) as error:
        errors = [f"cannot read the foundation: {error}"]
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Agent foundation checks passed: manifest, shared skills, and local document links.")
    print("This does not verify a running harness, live GitHub gates, or application behavior.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
