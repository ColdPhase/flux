#!/usr/bin/env python3
"""Require the independent evaluator's exact artifact review before publication."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from prepare_assets import DIGEST, SHA, VERSION


def verify(comments_file: Path, version: str, source_sha: str, digest: str, checksums_sha: str) -> None:
    if (not VERSION.fullmatch(version) or not SHA.fullmatch(source_sha)
            or not DIGEST.fullmatch(digest) or not DIGEST.fullmatch("sha256:" + checksums_sha)):
        raise ValueError("invalid release identity")
    pages = json.loads(comments_file.read_text(encoding="utf-8"))
    marker = f"ACCEPTED RELEASE ARTIFACT {version} {source_sha} {digest} {checksums_sha}"
    for page in pages:
        for comment in page:
            if comment.get("user", {}).get("login") == "Zamojski5" and marker in comment.get("body", "").splitlines():
                return
    raise ValueError("missing exact artifact acceptance from independent evaluator Zamojski5")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comments", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--checksums-sha", required=True)
    args = parser.parse_args()
    verify(args.comments, args.version, args.source_sha, args.digest, args.checksums_sha)


if __name__ == "__main__":
    main()
