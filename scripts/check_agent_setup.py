#!/usr/bin/env python3
"""Check the agent foundation offline, using only the Python standard library.

This validates the shared agent instructions, skills and local document links,
not GitHub enforcement, application correctness, or permission to publish anything.
"""

import argparse
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
    # Every Markdown file under docs/ (#84 AC-1), plus the root instructions and skills.
    documents = [root / "README.md", agents, claude, root / "docs/README.md",
                 root / "docs/CONTRIBUTING.md", *sorted((root / "docs").rglob("*.md")),
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
        # The v8 prototype notes (Polish, historical) use `flux-*` for browser storage keys.
        skills = [] if path.is_relative_to(root / "docs/prototype") else re.findall(r"`(flux-[a-z0-9-]+)`", content)
        for skill in skills:
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
    print("Agent foundation checks passed: shared instructions, skills, and local document links.")
    print("This does not verify live GitHub gates or application behavior.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
