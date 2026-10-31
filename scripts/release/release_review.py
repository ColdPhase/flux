"""Shared rules for release acceptance lines (founder decision on #249, 2026-10-31).

The release owner is PelikanFix16. The second record comes from an independent agent reviewer who
did not write the code under review. Agents post through a founder login, so the login alone cannot
tell an author from a reviewer: the review line names the reviewer and the reviewer's session, and
that session must not appear in any commit message reachable from the candidate (every agent commit
carries its session in a trailer, for example `Claude-Session: <url>`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

OWNER = "PelikanFix16"
# Founder logins; agents post through them (docs/agents/github-protocol.md).
POSTERS = {"PelikanFix16", "Zamojski5"}
REVIEWER = re.compile(r"reviewer=(?P<reviewer>[A-Za-z0-9._-]{2,64}) session=(?P<session>\S{16,256})\Z")


def load_comments(comments_file: Path) -> list[dict]:
    pages = json.loads(comments_file.read_text(encoding="utf-8"))
    return [comment for page in pages for comment in page]


def lines_by(comments: list[dict], logins: set[str]) -> list[str]:
    return [
        line.strip()
        for comment in comments
        if comment.get("user", {}).get("login") in logins
        for line in comment.get("body", "").splitlines()
    ]


def independent_reviews(lines: list[str], prefix: str, commit_messages: str) -> tuple[list[str], list[str]]:
    """Reviewers whose line is `<prefix> reviewer=<name> session=<id>` and whose session wrote no commit.

    Returns (accepted reviewers, refusals)."""
    accepted, refused = [], []
    for line in lines:
        if not line.startswith(prefix + " "):
            continue
        match = REVIEWER.fullmatch(line[len(prefix) + 1:])
        if not match:
            refused.append(f"malformed review line: {line}")
        elif match["reviewer"] == OWNER:
            refused.append(f"the release owner {OWNER} cannot be the independent reviewer")
        elif match["session"] in commit_messages:
            refused.append(f"reviewer {match['reviewer']} is an author: session {match['session']} is in the commit history")
        else:
            accepted.append(match["reviewer"])
    return accepted, refused
