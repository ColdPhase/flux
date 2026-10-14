"""#228/#239: live map/wiki editing is off unless a test overlay selects it.

F-021 is outside v0.1.0. The source, development and operator Compose files and the example
environments never set FLUX_DEVELOPMENT_LIVE_EDITING; only the test-only overlay used by
scripts/check_live_editing.sh does.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
SWITCH = "FLUX_DEVELOPMENT_LIVE_EDITING"


class LiveEditingDefaultOff(unittest.TestCase):
    def test_ordinary_compose_and_env_files_never_select_live_editing(self):
        files = [ROOT / "docker" / name for name in ("compose.yaml", "compose.source.yaml", "compose.dev.yaml", "compose.test.yaml", ".env.example")]
        files.append(ROOT / "app" / ".env.example")
        for path in files:
            if path.exists():
                self.assertNotIn(SWITCH, path.read_text(), path.name)

    def test_only_the_test_overlay_and_its_check_select_it(self):
        overlay = (ROOT / "docker" / "compose.live-editing.test.yaml").read_text()
        self.assertIn(f'{SWITCH}: "true"', overlay)
        self.assertIn("TEST ONLY", overlay)
        selecting = sorted(path.name for path in (ROOT / "docker").glob("compose*.yaml") if f'{SWITCH}: "true"' in path.read_text())
        self.assertEqual(selecting, ["compose.live-editing.test.yaml"])
        script = (ROOT / "scripts" / "check_live_editing.sh").read_text()
        self.assertIn("docker/compose.live-editing.test.yaml", script)
        for name in ("check_application.sh", "check_ui.sh"):
            self.assertNotIn("compose.live-editing.test.yaml", (ROOT / "scripts" / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
