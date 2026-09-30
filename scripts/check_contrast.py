#!/usr/bin/env python3
"""Checks WCAG 2.2 contrast of the web app's colour tokens in all three families and both themes.

Reads apps/web/src/ui/tokens.css (light/dark roles and each family override) and
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
    ("--on-accent", "--accent-pressed", 4.5, "primary button label while pressed"),
    ("--accent-selected-text", "--accent-selected-bg", 4.5, "selected control label"),
    ("--text-3", "--accent-soft", 4.5, "metadata on selected rows"),
    ("--accent-selected-border", "--accent-selected-bg", 3.0, "selected control boundary"),
    ("--link", "--bg", 4.5, "text link"),
    ("--link", "--accent-soft", 4.5, "link on selected surface"),
    ("--focus", "--bg-raised", 3.0, "focus ring on popovers"),
    ("--focus", "--accent-soft", 3.0, "focus ring on selection"),
    ("--map-guide", "--bg-side", 3.0, "map relationship guide"),
    ("--map-guide", "--line-strong", 3.0, "map relationship guide crossing canvas grid dots"),
    ("--resolution", "--bg", 4.5, "semantic resolution label"),
    ("--attention", "--bg", 4.5, "needs-you label"),
    ("--attention", "--bg-hover", 4.5, "needs-you label on hover"),
    ("--danger", "--bg", 4.5, "error text"),
    ("--danger", "--tint-danger", 4.5, "error text on its tint"),
    ("--warning", "--bg", 4.5, "warning text"),
    ("--ok", "--bg", 4.5, "success text"),
    ("--bg", "--text", 4.5, "toast text"),
    ("--line-input", "--bg", 3.0, "input boundary"),
    ("--focus", "--bg", 3.0, "focus ring"),
    ("--focus", "--bg-side", 3.0, "focus ring in the sidebar"),
    ("--text", "--bg", 3.0, "view switcher indicator"),
    ("--rail-fg", "--rail-bg", 4.5, "rail icons"),
    ("--rail-on", "--rail-hover", 4.5, "rail icon on hover"),
    ("--rail-on", "--rail-active", 4.5, "rail icon of the current place"),
    ("--lime", "--rail-bg", 3.0, "Flux mark, current-place marker and rail focus ring"),
    ("--lime", "--rail-active", 3.0, "rail focus ring on the current place"),
    ("--pm-1-t", "--pm-1", 4.5, "project monogram 1"),
    ("--pm-2-t", "--pm-2", 4.5, "project monogram 2"),
    ("--pm-3-t", "--pm-3", 4.5, "project monogram 3"),
    ("--pm-4-t", "--pm-4", 4.5, "project monogram 4"),
]


def parse(block: str) -> dict[str, str]:
    return dict(re.findall(r"(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|var\(--[a-z0-9-]+\))", block))


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


def main() -> int:
    css = TOKENS.read_text()
    light = parse(css[css.index(":root {"):css.index("}", css.index(":root {"))])
    dark_start = css.index(':root[data-theme="dark"] {')
    dark = {**light, **parse(css[dark_start:css.index("}", dark_start)])}
    palettes = []
    for family in ("mint", "iris", "sky"):
        override = {}
        if family != "mint":
            start = css.index(f':root[data-accent="{family}"]')
            override = parse(css[start:css.index("}", start)])
        palettes.extend((f"{theme}/{family}", {**tokens, **override}) for theme, tokens in (("light", light), ("dark", dark)))
    failures = 0
    mint_start = css.index('.me-accent__option[data-accent-option="mint"] {')
    mint_sample = parse(css[mint_start:css.index("}", mint_start)])
    if any(light.get(k) != v for k, v in mint_sample.items()):
        print("FAIL Mint sample differs from the default family primitives")
        failures += 1
    for theme, tokens in palettes:
        for fg, bg, minimum, purpose in PAIRS:
            value = ratio(resolve(tokens, fg), resolve(tokens, bg))
            ok = value >= minimum
            failures += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {theme:10} {value:5.2f}:1 (min {minimum}) {fg} on {bg}: {purpose}")
    # The dark tokens are duplicated for prefers-color-scheme; they must match the toggle block.
    media_start = css.index("@media (prefers-color-scheme: dark)")
    media = parse(css[media_start:css.index("}", css.index("{", css.index("{", media_start) + 1))])
    if {k: v.lower() for k, v in media.items()} != {k: v.lower() for k, v in parse(css[dark_start:css.index("}", dark_start)]).items()}:
        print("FAIL dark tokens differ between the media query and [data-theme=dark]")
        failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
