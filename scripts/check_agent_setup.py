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


def heading_anchors(content: str) -> set[str]:
    """GitHub's anchors for a Markdown file: heading slugs (with -1, -2 for repeats) and explicit ids."""
    anchors: set[str] = set(re.findall(r'<a\s+(?:id|name)="([^"]+)"', content))
    seen: dict[str, int] = {}
    in_fence = False
    for line in content.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        match = None if in_fence else re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if not match:
            continue
        text = re.sub(r"`([^`]*)`", r"\1", match[1])
        text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
        slug = re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")
        count = seen.get(slug, 0)
        seen[slug] = count + 1
        anchors.add(slug if count == 0 else f"{slug}-{count}")
    return anchors


def mask_inline_code(content: str) -> str:
    """Mask matching backtick runs within one Markdown text block."""
    runs = list(re.finditer(r"`+", content))
    pieces: list[str] = []
    start = 0
    index = 0
    while index < len(runs):
        opening = runs[index]
        opening_start, length = opening.start(), len(opening[0])
        if is_escaped(content, opening_start):
            # A backslash escapes just the first backtick, not the whole run.
            opening_start += 1
            length -= 1
        if not length:
            index += 1
            continue
        closing = next((other for other in range(index + 1, len(runs))
                        if len(runs[other][0]) == length), None)
        if closing is None:
            index += 1
            continue
        end = runs[closing].end()
        pieces.extend((content[start:opening_start],
                       re.sub(r"[^\r\n]", " ", content[opening_start:end])))
        start = end
        index = closing + 1
    pieces.append(content[start:])
    return "".join(pieces)


def markdown_without_code(content: str) -> str:
    """Mask code without joining inline spans across paragraph or fence boundaries."""
    output: list[str] = []
    paragraph: list[str] = []
    fence: tuple[str, int, int] | None = None
    quote_depth = 0

    def flush() -> None:
        output.append(mask_inline_code("".join(paragraph)))
        paragraph.clear()

    for line in content.splitlines(keepends=True):
        quote = re.match(r"^(?: {0,3}>[ \t]?)+", line)
        depth = quote[0].count(">") if quote else 0
        text = line[quote.end():] if quote else line
        if depth != quote_depth:
            flush()
            quote_depth = depth
        if fence is not None and depth < fence[2]:
            fence = None
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)", text)
        if fence is not None:
            if (marker and depth == fence[2] and marker[1][0] == fence[0]
                    and len(marker[1]) >= fence[1] and not marker[2].strip()):
                fence = None
            output.append(re.sub(r"[^\r\n]", " ", line))
        elif marker and (marker[1][0] != "`" or "`" not in marker[2]):
            flush()
            fence = (marker[1][0], len(marker[1]), depth)
            output.append(re.sub(r"[^\r\n]", " ", line))
        elif not text.strip():
            flush()
            output.append(line)
        elif re.match(r"^ {0,3}#{1,6}(?:[ \t]+|$)", text):
            flush()
            output.append(mask_inline_code(line))
        else:
            # A new list item starts a different inline text block.
            if re.match(r"^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+", text):
                flush()
            paragraph.append(line)
    flush()
    return "".join(output)


def is_escaped(content: str, position: int) -> bool:
    slashes = 0
    while position > 0 and content[position - 1] == "\\":
        slashes += 1
        position -= 1
    return slashes % 2 == 1


def undefined_numeric_references(content: str) -> list[tuple[int, str]]:
    """Check issue/PR reference labels only; research labels are intentionally free-form."""
    masked = markdown_without_code(content)
    definitions = list(re.finditer(r"^ {0,3}\[(#\d+)\]:[ \t]*(?:\S[^\n]*|\n[ \t]*\S[^\n]*)", masked, re.MULTILINE))
    defined = {definition[1] for definition in definitions}
    definition_spans = [(definition.start(), definition.end()) for definition in definitions]
    missing: list[tuple[int, str]] = []
    for reference in re.finditer(r"\[(#\d+)\]", masked):
        if is_escaped(masked, reference.start()):
            continue
        if any(start <= reference.start() < end for start, end in definition_spans):
            continue
        following = masked[reference.end():]
        # A numeric display label can belong to an inline or a full reference link.
        # A collapsed reference [#1][] still resolves using its numeric label.
        if following.startswith("(") or re.match(r"\[[^\]\n]+\]", following):
            continue
        if reference[1] not in defined:
            missing.append((masked.count("\n", 0, reference.start()) + 1, reference[1]))
    return missing


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
    documents = list(dict.fromkeys([root / "README.md", agents, claude, root / "GOVERNANCE.md", root / "CHANGELOG.md",
                                    *sorted((root / "docs").rglob("*.md")), *skill_files]))
    anchor_cache: dict[Path, set[str]] = {}
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
        for line, label in undefined_numeric_references(content):
            errors.append(f"{path.relative_to(root)}:{line}: undefined numeric reference [{label}]")
        # The v8 prototype notes (Polish, historical) use `flux-*` for browser storage keys.
        skills = [] if path.is_relative_to(root / "docs/prototype") else re.findall(r"`(flux-[a-z0-9-]+)`", content)
        for skill in skills:
            require(skill in skill_names,
                    f"{path.relative_to(root)}: references missing skill {skill}")
        for link in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", content):
            url = urlsplit(link.strip().strip("<>"))
            if url.scheme or url.netloc or (not url.path and not url.fragment):
                continue
            destination = (path.parent / unquote(url.path)).resolve() if url.path else path.resolve()
            if not (destination.is_relative_to(root) and destination.exists()):
                errors.append(f"{path.relative_to(root)}: broken/local-external link {link}")
                continue
            # A fragment into a Markdown file must name one of its headings or explicit anchors.
            if url.fragment and destination.suffix == ".md" and destination.is_file():
                if destination not in anchor_cache:
                    anchor_cache[destination] = heading_anchors(destination.read_text(encoding="utf-8"))
                require(unquote(url.fragment).lower() in anchor_cache[destination],
                        f"{path.relative_to(root)}: link {link} names a missing heading anchor")
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
