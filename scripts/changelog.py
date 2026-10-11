#!/usr/bin/env python3
"""Changelog fragments: one file per pull request under changes/, assembled at release.

Parallel pull requests used to conflict on the same lines of CHANGELOG.md. Each PR now
adds its own file, changes/<number>-<slug>.<section>.md, holding one or more "- " lines.

  python3 scripts/changelog.py check                     validate every fragment
  python3 scripts/changelog.py show                      print the pending entries
  python3 scripts/changelog.py release 0.1.0 2026-10-12  move them into CHANGELOG.md
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGES = ROOT / "changes"
CHANGELOG = ROOT / "CHANGELOG.md"
SECTIONS = ("added", "changed", "deprecated", "removed", "fixed", "security")
NAME = re.compile(r"^(?P<number>\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.(?P<section>[a-z]+)\.md$")


def fragments(directory: Path = CHANGES) -> list[Path]:
    return sorted(p for p in directory.glob("*.md") if p.name != "README.md")


def problems(directory: Path = CHANGES) -> list[str]:
    found = []
    for path in fragments(directory):
        match = NAME.match(path.name)
        if not match:
            found.append(f"{path.name}: name must be <number>-<slug>.<section>.md")
            continue
        if match["section"] not in SECTIONS:
            found.append(f"{path.name}: section must be one of {', '.join(SECTIONS)}")
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not lines:
            found.append(f"{path.name}: empty")
        elif not lines[0].startswith("- "):
            found.append(f"{path.name}: entries start with '- '")
    return found


def entries(directory: Path = CHANGES) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {section: [] for section in SECTIONS}
    for path in fragments(directory):
        match = NAME.match(path.name)
        if match and match["section"] in grouped:
            grouped[match["section"]].append(path.read_text(encoding="utf-8").strip())
    return grouped


def render(grouped: dict[str, list[str]]) -> str:
    blocks = [f"### {section.capitalize()}\n\n" + "\n".join(items)
              for section, items in grouped.items() if items]
    return "\n\n".join(blocks)


def release(version: str, date: str, directory: Path = CHANGES, changelog: Path = CHANGELOG) -> str:
    body = render(entries(directory))
    if not body:
        raise SystemExit("no pending fragments under changes/")
    text = changelog.read_text(encoding="utf-8")
    marker = "## [Unreleased]"
    if marker not in text:
        raise SystemExit(f"{changelog.name} has no '{marker}' heading")
    # The new version goes right under [Unreleased]; earlier entries stay below it.
    text = text.replace(marker, f"{marker}\n\n## [{version}] - {date}\n\n{body}", 1)
    changelog.write_text(text, encoding="utf-8")
    for path in fragments(directory):
        path.unlink()
    return body


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "check"
    if command == "check":
        found = problems()
        for line in found:
            print(line, file=sys.stderr)
        print(f"{len(fragments())} changelog fragment(s), {len(found)} problem(s)")
        return 1 if found else 0
    if command == "show":
        print(render(entries()) or "(no pending fragments)")
        return 0
    if command == "release" and len(argv) == 4:
        release(argv[2], argv[3])
        print(f"moved pending fragments into CHANGELOG.md under {argv[2]}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
