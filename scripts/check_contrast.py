#!/usr/bin/env python3
"""Checks WCAG 2.2 contrast of the web app's colour tokens in both themes.

Reads apps/web/src/ui/tokens.css (light :root block and the [data-theme="dark"] block) and
fails when a text pair is below 4.5:1 or a UI boundary/indicator pair is below 3:1.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TOKENS = Path(__file__).resolve().parent.parent / "apps/web/src/ui/tokens.css"

# (foreground, background, minimum ratio, purpose)
PAIRS = [
    ("--text", "--bg", 4.5, "body text"),
    ("--text-2", "--bg", 4.5, "secondary text"),
    ("--text-3", "--bg", 4.5, "muted text"),
    ("--text-3", "--bg-side", 4.5, "muted sidebar text"),
    ("--text-3", "--bg-hover", 4.5, "muted text on hover"),
    ("--text-2", "--bg-active", 4.5, "selected item text"),
    ("--text-3", "--bg-active", 4.5, "muted text on selection"),
    ("--text-3", "--bg-raised", 4.5, "muted text on popovers"),
    ("--accent", "--bg", 4.5, "links and accent text"),
    ("--accent", "--bg-side", 4.5, "accent text in the sidebar"),
    ("--on-accent", "--accent", 4.5, "primary button label"),
    ("--on-accent", "--accent-hover", 4.5, "primary button label on hover"),
    ("--danger", "--bg", 4.5, "error text"),
    ("--danger", "--tint-danger", 4.5, "error text on its tint"),
    ("--warning", "--bg", 4.5, "warning text"),
    ("--ok", "--bg", 4.5, "success text"),
    ("--bg", "--text", 4.5, "toast text"),
    ("--line-input", "--bg", 3.0, "input boundary"),
    ("--focus", "--bg", 3.0, "focus ring"),
    ("--focus", "--bg-side", 3.0, "focus ring in the sidebar"),
    ("--text", "--bg", 3.0, "view switcher indicator"),
]


def parse(block: str) -> dict[str, str]:
    return dict(re.findall(r"(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b", block))


def luminance(hex_colour: str) -> float:
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def main() -> int:
    css = TOKENS.read_text()
    light = parse(css[css.index(":root {"):css.index("}", css.index(":root {"))])
    dark_start = css.index(':root[data-theme="dark"] {')
    dark = {**light, **parse(css[dark_start:css.index("}", dark_start)])}
    failures = 0
    for theme, tokens in (("light", light), ("dark", dark)):
        for fg, bg, minimum, purpose in PAIRS:
            value = ratio(tokens[fg], tokens[bg])
            ok = value >= minimum
            failures += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {theme:5} {value:5.2f}:1 (min {minimum}) {fg} on {bg}: {purpose}")
    # The dark tokens are duplicated for prefers-color-scheme; they must match the toggle block.
    media_start = css.index("@media (prefers-color-scheme: dark)")
    media = parse(css[media_start:css.index("}", css.index("{", css.index("{", media_start) + 1))])
    if {k: v.lower() for k, v in media.items()} != {k: v.lower() for k, v in parse(css[dark_start:css.index("}", dark_start)]).items()}:
        print("FAIL dark tokens differ between the media query and [data-theme=dark]")
        failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
