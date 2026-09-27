"""Recover an interrupted task from durable files and authenticated GitHub claims."""

import json
from pathlib import Path
import re

from .github import command


def work_inventory(root, directory):
    records = []
    for raw in command(["git", "worktree", "list", "--porcelain"], root).split("\n\n"):
        lines = raw.splitlines()
        if not lines or not lines[0].startswith("worktree "):
            continue
        path = Path(lines[0][9:]).resolve()
        if not path.is_relative_to(directory.resolve()) or not path.exists():
            continue
        records.append({"path": str(path), "git_record": raw,
                        "changes": command(["git", "status", "--porcelain"], path)})
    return records


def recovery_context(root, directory, state, snapshot, worker):
    interrupted = state.get("active_turn")
    previous = state.get("last_result")
    candidates = []
    # Claims can be newer than last_result when the process stopped mid-turn.
    for issue in snapshot["issues"]:
        if issue["state"] != "open" or [x["login"].casefold() for x in issue.get("assignees", [])] != [
                worker["github_login"].casefold()]:
            continue
        latest_claim = None
        for comment in issue.get("comments", []):
            if comment.get("user", {}).get("login", "").casefold() != worker["github_login"].casefold():
                continue
            match = re.search(r"<!-- flux-agent:v1\s*(\{.*?\})\s*-->", comment.get("body", ""), re.S)
            if not match:
                continue
            try:
                record = json.loads(match[1])
            except ValueError:
                continue
            if record.get("worker") != worker["id"] or record.get("task") != issue["number"]:
                continue
            if record.get("kind") == "claim" and record.get("role") == "implementation":
                latest_claim = comment.get("id", 0)
            elif record.get("kind") in ("release", "handoff"):
                latest_claim = None
        if latest_claim is not None:
            candidates.append((latest_claim, issue["number"]))
        elif previous and previous.get("outcome") == "progress" and previous.get("task") == issue["number"]:
            candidates.append((0, issue["number"]))
    candidates.sort(reverse=True)
    logs = directory / "turns" / str(interrupted)
    return {"interrupted_turn": interrupted, "previous_checkpoint": previous,
            "resume_issue_numbers": [number for _, number in candidates],
            "saved_worktrees": work_inventory(root, directory),
            "interrupted_logs": str(logs) if interrupted and logs.is_dir() else None}
