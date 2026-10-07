#!/usr/bin/env python3
"""Checks WCAG 2.2 contrast of the web app's colour tokens in both themes (final design, F-026).

Reads app/apps/web/src/ui/tokens.css (the light :root block and the dark block) and fails when a
text pair is below 4.5:1 or an icon, glyph or indicator pair is below 3:1. Gradients are checked
at both stops. `--failures-only` prints only failing pairs and a one-line summary; the exit code
is the same.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TOKENS = Path(__file__).resolve().parent.parent / "app/apps/web/src/ui/tokens.css"

# (foreground, background, minimum ratio, purpose). A name ending in @0 or @1 is the first or last
# stop of a gradient token. --t3 is muted text: it is used only on --bg and --el; text on the quiet
# fills (--side, --sub, --hov) is --t2 or --t1.
PAIRS = [
    ("--t1", "--bg", 4.5, "body text on the screen"),
    ("--t1", "--el", 4.5, "text in cards, bubbles and fields"),
    ("--t1", "--side", 4.5, "sidebar item text"),
    ("--t1", "--sub", 4.5, "text on quiet fills and chips"),
    ("--t1", "--hov", 4.5, "text on hover"),
    ("--t2", "--bg", 4.5, "secondary text"),
    ("--t2", "--el", 4.5, "secondary text in cards"),
    ("--t2", "--side", 4.5, "sidebar labels and section headings"),
    ("--t2", "--sub", 4.5, "segmented control and chip labels"),
    ("--t2", "--hov", 4.5, "secondary text on hover"),
    ("--t3", "--bg", 4.5, "meta text on the screen"),
    ("--t3", "--el", 4.5, "meta text in cards and bubbles"),
    ("--oninv", "--inv", 4.5, "inverted text: own bubbles, chosen chips, toasts"),
    ("--oninv", "--grad-inv@0", 4.5, "primary button label, top of its gradient"),
    ("--oninv", "--grad-inv@1", 4.5, "primary button label, bottom of its gradient"),
    ("--t1", "--grad-btn@0", 4.5, "button label, top of its gradient"),
    ("--t1", "--grad-btn@1", 4.5, "button label, bottom of its gradient"),
    ("--inv", "--bg", 3.0, "primary button and inverted pill on the screen"),
    ("--t1", "--bg", 3.0, "focus ring and filled state glyphs"),
    ("--t1", "--el", 3.0, "focus ring and glyphs in cards"),
    ("--t1", "--side", 3.0, "focus ring in the sidebar"),
    ("--t3", "--bg", 3.0, "open and not-pursued glyphs"),
    ("--t3", "--el", 3.0, "open and not-pursued glyphs in cards"),
    ("--t2", "--sub", 3.0, "icons on quiet fills"),
]

HEX = r"#[0-9a-fA-F]{6}"


def parse(block: str) -> dict[str, str]:
    tokens = dict(re.findall(rf"(--[a-z0-9-]+):\s*({HEX}|var\(--[a-z0-9-]+\))", block))
    for name, first, last in re.findall(rf"(--[a-z0-9-]+):\s*linear-gradient\(\s*({HEX})\s*,\s*({HEX})\s*\)", block):
        tokens[f"{name}@0"], tokens[f"{name}@1"] = first, last
    return tokens


def resolve(tokens: dict[str, str], name: str, seen: tuple[str, ...] = ()) -> str:
    if name in seen:
        raise ValueError(f"cyclic token: {name}")
    value = tokens[name]
    return resolve(tokens, value[4:-1], (*seen, name)) if value.startswith("var(") else value


def luminance(hex_colour: str) -> float:
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def block_after(css: str, opener: str) -> str:
    start = css.index(opener)
    return css[start:css.index("}", start)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check WCAG contrast of the web app's colour tokens.")
    parser.add_argument("--failures-only", action="store_true", help="print only failing pairs and a summary")
    parser.add_argument("--tokens", type=Path, default=TOKENS, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    quiet = args.failures_only
    css = args.tokens.read_text()
    light = parse(block_after(css, ":root {"))
    dark_block = block_after(css, ':root[data-theme="dark"] {')
    dark = {**light, **parse(dark_block)}
    failures = 0
    checked = 0
    for theme, tokens in (("light", light), ("dark", dark)):
        for fg, bg, minimum, purpose in PAIRS:
            value = ratio(resolve(tokens, fg), resolve(tokens, bg))
            ok = value >= minimum
            failures += not ok
            checked += 1
            if not (quiet and ok):
                print(f"{'ok  ' if ok else 'FAIL'} {theme:5} {value:5.2f}:1 (min {minimum}) {fg} on {bg}: {purpose}")
    # The dark tokens are duplicated for prefers-color-scheme; they must match the toggle block.
    media = block_after(css, ':root:not([data-theme="light"]) {')
    normalise = lambda block: re.sub(r"\s+", "", re.sub(r"color-scheme:\s*dark;", "", block.split("{", 1)[1]))
    if normalise(media) != normalise(dark_block):
        print("FAIL dark tokens differ between the media query and [data-theme=dark]")
        failures += 1
    if re.search(r"--accent|data-accent", css):
        print("FAIL tokens.css defines an accent colour; the final design has none")
        failures += 1
    if quiet:
        print(f"{checked} pairs checked, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
