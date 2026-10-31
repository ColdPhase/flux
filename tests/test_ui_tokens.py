"""The shared UI stylesheet takes its colours from the tokens (#433, F-026 Soft volume)."""

import re
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "app" / "apps" / "web" / "src"
UI = WEB / "ui"
AGENTS = ("clay", "ochre", "sage", "teal", "indigo", "plum", "rose")


def without_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


class SharedStylesUseTokens(unittest.TestCase):
    def test_ui_css_has_no_hex_colour_literals(self) -> None:
        css = without_comments((UI / "ui.css").read_text(encoding="utf-8"))
        literals = re.findall(r"#[0-9a-fA-F]{3,8}\b", css)
        self.assertEqual(literals, [], "ui.css should use tokens from tokens.css, not hex colours")

    def test_agent_colours_are_defined_for_light_and_both_dark_paths(self) -> None:
        css = without_comments((UI / "tokens.css").read_text(encoding="utf-8"))
        for name in AGENTS:
            # :root (light), the system-dark media block and the chosen-dark block
            self.assertEqual(len(re.findall(rf"--agent-{name}:\s*#[0-9a-f]{{6}}", css)), 3, name)

    def test_every_kreska_colour_class_reads_its_token(self) -> None:
        css = without_comments((UI / "ui.css").read_text(encoding="utf-8"))
        for name in AGENTS:
            self.assertIn(f".kreska--{name} {{ color: var(--agent-{name}); }}", css)


class TypeUsesTheRamp(unittest.TestCase):
    """#763 TY-1/TY-2: every size comes from the type tokens, so Settings → Appearance → Text size reaches all
    text, and the app keeps the design's weights (README §2: Geist 400 / 500 / 600)."""

    SIZE = re.compile(r"font-size:\s*([^;}]+)")
    SHORTHAND = re.compile(r"(?<![-\w])font:\s*([^;}]+)")
    LITERAL = re.compile(r"(?<![\w.-])[0-9]*\.?[0-9]+(px|rem|pt)\b")

    @classmethod
    def literal(cls, value: str) -> bool:
        """A literal size, unless it only bounds a size that scales (a token or em) inside min(), max() or clamp(),
        such as the 12 px floor of a task number or the phone tab labels' cap (#437)."""
        if not cls.LITERAL.search(value):
            return False
        bounded = re.match(r"\s*(min|max|clamp)\(", value) and re.search(r"var\(--fs-[\w-]+\)|\d(em|vw)\b", value)
        return not bounded

    def sheets(self):
        for path in sorted(WEB.rglob("*.css")):
            if path.name != "tokens.css":
                yield path.relative_to(WEB), without_comments(path.read_text(encoding="utf-8"))

    def test_font_sizes_are_type_tokens(self) -> None:
        found = []
        for name, css in self.sheets():
            for value in self.SIZE.findall(css):
                if self.literal(value):
                    found.append(f"{name}: font-size: {value.strip()}")
            for value in self.SHORTHAND.findall(css):
                if value.strip() in ("inherit", "unset", "initial"):
                    continue
                if self.literal(value.split("/")[0]):
                    found.append(f"{name}: font: {value.strip()}")
        self.assertEqual(found, [], "use a --fs-* token from ui/tokens.css (relative em is fine) instead of a literal size")

    def test_font_weights_are_400_500_or_600(self) -> None:
        found = [f"{name}: {weight}" for name, css in self.sheets()
                 for weight in re.findall(r"font-weight:\s*(\d+)", css) + re.findall(r"(?<![-\w])font:\s*(\d{3})\b", css)
                 if weight not in ("400", "500", "600")]
        self.assertEqual(found, [])

    def test_the_control_height_is_spokoj_32(self) -> None:
        css = without_comments((UI / "tokens.css").read_text(encoding="utf-8"))
        self.assertRegex(css, r"--ctl:\s*32px;", "Spokój rule 1: buttons are 32 px (44 px on touch)")

    def test_the_project_name_keeps_the_header_title_size(self) -> None:
        css = without_comments((WEB / "app" / "app.css").read_text(encoding="utf-8"))
        rules = re.findall(r"([^{}]*\.top__title h1[^{}]*)\{([^}]*)\}", css)
        sizes = {selector.strip(): body for selector, body in rules if "font-size" in body}
        self.assertEqual(list(sizes), [".top__title h1"], "only the base rule sizes the header title (--fs-title)")
        self.assertIn("var(--fs-title)", sizes[".top__title h1"])


if __name__ == "__main__":
    unittest.main()
