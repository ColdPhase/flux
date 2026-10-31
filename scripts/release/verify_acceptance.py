#!/usr/bin/env python3
"""Require the release owner's and an independent reviewer's acceptance of one exact candidate.

Lines on the acceptance issue (founder decision on #249, 2026-10-31):
  ACCEPTED RELEASE CANDIDATE <sha>                                         posted by PelikanFix16
  INDEPENDENT RELEASE REVIEW <sha> reviewer=<name> session=<session id>    posted by a founder login
The reviewer's session must not appear in any commit message reachable from <sha>
(`git log --format=%B <sha>`, passed as --commit-messages): the reviewer wrote none of the code.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from release_review import OWNER, POSTERS, independent_reviews, lines_by, load_comments

SHA = re.compile(r"[0-9a-f]{40}\Z")


def verify(comments_file: Path, source_sha: str, commit_messages: str) -> str:
    if not SHA.fullmatch(source_sha):
        raise ValueError("candidate SHA must be 40 lowercase hex characters")
    comments = load_comments(comments_file)
    if f"ACCEPTED RELEASE CANDIDATE {source_sha}" not in lines_by(comments, {OWNER}):
        raise ValueError(f"missing exact-SHA acceptance from the release owner {OWNER}")
    reviewers, refused = independent_reviews(
        lines_by(comments, POSTERS), f"INDEPENDENT RELEASE REVIEW {source_sha}", commit_messages)
    if not reviewers:
        raise ValueError("missing an independent reviewer's exact-SHA review"
                         + "".join(f"\n  {reason}" for reason in refused))
    return reviewers[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--comments", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--commit-messages", type=Path, required=True)
    args = parser.parse_args()
    reviewer = verify(args.comments, args.source_sha, args.commit_messages.read_text(encoding="utf-8"))
    print(f"Accepted by {OWNER} and independent reviewer {reviewer}")


if __name__ == "__main__":
    main()
