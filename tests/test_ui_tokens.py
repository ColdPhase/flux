"""The shared UI stylesheet takes its colours from the tokens (#433, F-026 Soft volume)."""

import re
import unittest
from pathlib import Path

UI = Path(__file__).resolve().parents[1] / "app" / "apps" / "web" / "src" / "ui"
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


if __name__ == "__main__":
    unittest.main()
