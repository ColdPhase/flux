#!/usr/bin/env python3
"""Which releases a release upgrades from (#1241), and the sentence its notes say.

An instance installed from any release from v0.2.0 on upgrades to any later release (docs/operations/upgrade.md). v0.1 is not
upgraded (#1176). This module is the one place that says what "a release from v0.2.0 on" and "a later release" mean, for
scripts/check_upgrade_matrix.sh, the release workflow and the immutability check of released migrations.

    release_versions.py from --candidate v0.2.1 [--releases releases.json]
        the published releases the candidate upgrades from, oldest first, one per line. Reads the JSON of
        `gh release list --json tagName,isDraft` from the file or from `gh release list` itself.
    release_versions.py next --releases releases.json
        the patch after the newest published release (the version of a candidate that nobody named).
    release_versions.py notes --candidate v0.2.1 v0.2.0 [v0.2.1 ...]
        the line of the release notes, from the versions the upgrade checks passed.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

OLDEST_SUPPORTED = (0, 2, 0)
TAG = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.([1-9][0-9]*))?$")


def parse(tag: str) -> tuple[int, int, int, int, int] | None:
    """A sortable key, or None for a name that is no release tag. A release candidate sorts before its release."""
    match = TAG.match(tag)
    if not match:
        return None
    major, minor, patch, rc = match.groups()
    return (int(major), int(minor), int(patch), 0 if rc else 1, int(rc or 0))


def supported(tag: str) -> bool:
    """Every release from v0.2.0 on; v0.1 (a failed release with no users) is not upgraded."""
    key = parse(tag)
    return key is not None and key[:3] >= OLDEST_SUPPORTED


def upgrades_from(candidate: str, published: list[str]) -> list[str]:
    """The published, supported releases that come before the candidate, oldest first (the candidate itself never)."""
    candidate_key = parse(candidate)
    if candidate_key is None or not supported(candidate):
        raise ValueError(f"{candidate!r} is not a release version from v0.2.0 on")
    found = {tag for tag in published if supported(tag) and tag != candidate and parse(tag) < candidate_key}  # type: ignore[operator]
    return sorted(found, key=lambda tag: parse(tag))  # type: ignore[arg-type,return-value]


def published_tags(releases: list[dict]) -> list[str]:
    """Drafts are not published: nobody has installed them."""
    return [item["tagName"] for item in releases if not item.get("isDraft")]


def next_version(published: list[str]) -> str:
    """The patch after the newest published release: what a candidate built between releases is called when nobody named it."""
    stable = [tag for tag in published if supported(tag) and parse(tag)[3] == 1]  # type: ignore[index]
    if not stable:
        return "v0.2.0"
    major, minor, patch = parse(max(stable, key=lambda tag: parse(tag)))[:3]  # type: ignore[arg-type,index]
    return f"v{major}.{minor}.{patch + 1}"


def notes_line(candidate: str, tested: list[str]) -> str:
    ordered = sorted(set(tested), key=lambda tag: parse(tag))  # type: ignore[arg-type,return-value]
    if not ordered:
        return (
            f"Upgrades: {candidate} is the first release that is upgraded to. Every later release upgrades from it "
            "(docs/operations/upgrade.md); there is no earlier release to test from."
        )
    return (
        f"Upgrades from: {', '.join(ordered)}. Every one of them was installed from its own release assets, seeded, upgraded to this "
        "candidate and read back before this draft was made (check_upgrade_matrix.sh and the upgrade legs of the release run); "
        "v0.1 is not upgraded and a downgrade is not supported: the way back is the backup taken before the upgrade."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("from")
    listing.add_argument("--candidate", required=True)
    listing.add_argument("--releases", type=Path, help="JSON of `gh release list --json tagName,isDraft`; default: ask gh")
    following = sub.add_parser("next")
    following.add_argument("--releases", type=Path, required=True)
    notes = sub.add_parser("notes")
    notes.add_argument("--candidate", required=True)
    notes.add_argument("tested", nargs="*")
    args = parser.parse_args()
    if args.command == "from":
        if args.releases:
            releases = json.loads(args.releases.read_text(encoding="utf-8"))
        else:
            releases = json.loads(subprocess.run(
                ["gh", "release", "list", "--limit", "200", "--json", "tagName,isDraft"], check=True, capture_output=True, text=True,
            ).stdout)
        print("\n".join(upgrades_from(args.candidate, published_tags(releases))))
    elif args.command == "next":
        print(next_version(published_tags(json.loads(args.releases.read_text(encoding="utf-8")))))
    else:
        print(notes_line(args.candidate, args.tested))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"release_versions: {error}", file=sys.stderr)
        sys.exit(2)
