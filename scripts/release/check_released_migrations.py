#!/usr/bin/env python3
"""A released migration never changes (#1241).

Every migration file of every release from v0.2.0 on must be byte-identical to the file of that release's tag, and still exist
under its name: an instance that ran it has it in its ledger, and the migrator refuses a ledger row without a file. A fix is a new
migration. A migration that no release holds yet must be numbered above the highest released one, so that migrations apply in order
and an instance that skips a release gets the same history as one that did not.

    check_released_migrations.py [--root REPO] [--tree DIR]

`--tree` checks another directory of migration files against the tags (check_upgrade_matrix.sh uses it for its negative control).
Exit 0 when nothing differs, 1 for a difference, 2 when no release tag is in the repository (`git fetch --tags`; a shallow clone
without its tags cannot be checked, and must not pass).
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_versions import parse, supported  # noqa: E402

MIGRATIONS = "app/packages/db/migrations"
FILE = re.compile(r"^(\d{4})_.+\.sql$")


class NoReleaseTags(Exception):
    pass


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True).stdout


def release_tags(root: Path) -> list[str]:
    tags = [tag for tag in git(root, "tag", "--list", "v*").decode().split() if supported(tag)]
    return sorted(tags, key=lambda tag: parse(tag))  # type: ignore[arg-type,return-value]


def released_migrations(root: Path, tags: list[str]) -> tuple[dict[str, tuple[str, str]], list[str]]:
    """name -> (first release that holds it, sha256), and the problems found between the releases themselves."""
    released: dict[str, tuple[str, str]] = {}
    problems: list[str] = []
    for tag in tags:
        names = git(root, "ls-tree", "-r", "--name-only", tag, MIGRATIONS).decode().split("\n")
        for path in sorted(name for name in names if FILE.match(Path(name).name)):
            name = Path(path).name
            digest = hashlib.sha256(git(root, "show", f"{tag}:{path}")).hexdigest()
            if name in released and released[name][1] != digest:
                problems.append(f"{name} differs between {released[name][0]} and {tag}: a released migration was edited in a later release")
            released.setdefault(name, (tag, digest))
    return released, problems


def check(root: Path, tree: Path | None = None) -> list[str]:
    tags = release_tags(root)
    if not tags:
        raise NoReleaseTags("no release tag from v0.2.0 on is in this repository (git fetch --tags)")
    tree = tree or root / MIGRATIONS
    released, problems = released_migrations(root, tags)
    current = {path.name: path for path in tree.iterdir() if FILE.match(path.name)}
    for name, (tag, digest) in sorted(released.items()):
        if name not in current:
            problems.append(f"{name} is in {tag} and is gone: a released migration cannot be deleted or renamed")
        elif hashlib.sha256(current[name].read_bytes()).hexdigest() != digest:
            problems.append(f"{name} differs from the file of {tag}: a released migration cannot change, a fix is a new migration")
    highest = max(int(FILE.match(name).group(1)) for name in released)  # type: ignore[union-attr]
    for name in sorted(set(current) - set(released)):
        number = int(FILE.match(name).group(1))  # type: ignore[union-attr]
        if number <= highest:
            problems.append(f"{name} is new and numbered at or below the highest released migration ({highest:04d}): use the next free number")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--tree", type=Path)
    args = parser.parse_args()
    try:
        problems = check(args.root, args.tree)
    except NoReleaseTags as error:
        print(f"check_released_migrations: {error}", file=sys.stderr)
        return 2
    for problem in problems:
        print(f"check_released_migrations: {problem}", file=sys.stderr)
    if not problems:
        tags = release_tags(args.root)
        print(f"Released migrations are byte-identical to their tags ({', '.join(tags)}); new ones are numbered after the last released.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
