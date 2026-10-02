#!/usr/bin/env python3
"""Require both delegated agents to accept one exact release candidate."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ACCEPTORS = {"PelikanFix16", "Zamojski5"}
SHA = re.compile(r"[0-9a-f]{40}\Z")


def verify(comments_file: Path, source_sha: str) -> None:
    if not SHA.fullmatch(source_sha):
        raise ValueError("candidate SHA must be 40 lowercase hex characters")
    pages = json.loads(comments_file.read_text(encoding="utf-8"))
    comments = [comment for page in pages for comment in page]
    marker = f"ACCEPTED RELEASE CANDIDATE {source_sha}"
    accepted = {
        comment["user"]["login"]
        for comment in comments
        if marker in comment.get("body", "").splitlines()
        and comment.get("user", {}).get("login") in ACCEPTORS
    }
    if accepted != ACCEPTORS:
        raise ValueError(f"missing exact-SHA acceptance from {', '.join(sorted(ACCEPTORS - accepted))}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comments", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    verify(args.comments, args.source_sha)


if __name__ == "__main__":
    main()
