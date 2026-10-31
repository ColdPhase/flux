#!/usr/bin/env python3
"""Require an independent reviewer's exact artifact review before publication.

Line on the review issue (founder decision on #249, 2026-10-31), posted by a founder login:
  ACCEPTED RELEASE ARTIFACT <version> <sha> <sha256:digest> <SHA-256 of SHA256SUMS> reviewer=<name> session=<id>
The reviewer's session must not appear in any commit message reachable from <sha> (--commit-messages).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from prepare_assets import DIGEST, SHA, VERSION
from release_review import POSTERS, independent_reviews, lines_by, load_comments


def verify(comments_file: Path, version: str, source_sha: str, digest: str, checksums_sha: str,
           commit_messages: str) -> str:
    if (not VERSION.fullmatch(version) or not SHA.fullmatch(source_sha)
            or not DIGEST.fullmatch(digest) or not DIGEST.fullmatch("sha256:" + checksums_sha)):
        raise ValueError("invalid release identity")
    prefix = f"ACCEPTED RELEASE ARTIFACT {version} {source_sha} {digest} {checksums_sha}"
    reviewers, refused = independent_reviews(lines_by(load_comments(comments_file), POSTERS), prefix, commit_messages)
    if not reviewers:
        raise ValueError("missing an independent reviewer's exact artifact review"
                         + "".join(f"\n  {reason}" for reason in refused))
    return reviewers[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--comments", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--checksums-sha", required=True)
    parser.add_argument("--commit-messages", type=Path, required=True)
    args = parser.parse_args()
    reviewer = verify(args.comments, args.version, args.source_sha, args.digest, args.checksums_sha,
                      args.commit_messages.read_text(encoding="utf-8"))
    print(f"Artifact accepted by independent reviewer {reviewer}")


if __name__ == "__main__":
    main()
