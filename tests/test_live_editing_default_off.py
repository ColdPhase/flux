"""#228: normal live availability and the isolated calibration marker are separate."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
MARKER = "FLUX_DEVELOPMENT_LIVE_EDITING"


class LiveEditingProductionConfiguration(unittest.TestCase):
    def test_normal_installations_pass_the_production_control_and_never_select_diagnostics(self):
        for name in ("compose.yaml", "compose.source.yaml"):
            content = (ROOT / "docker" / name).read_text()
            self.assertIn("FLUX_LIVE_EDITING: ${FLUX_LIVE_EDITING:-on}", content, name)
            self.assertNotIn(MARKER, content, name)
        for path in (ROOT / "docker" / ".env.example", ROOT / "app" / ".env.example"):
            self.assertIn("FLUX_LIVE_EDITING=on", path.read_text())
            self.assertNotIn(MARKER, path.read_text())

    def test_only_the_calibration_overlay_selects_diagnostics_and_canonical_ui_covers_both_modes(self):
        overlay = (ROOT / "docker" / "compose.live-editing.test.yaml").read_text()
        self.assertIn('FLUX_LIVE_EDITING: "on"', overlay)
        self.assertIn(f'{MARKER}: "true"', overlay)
        selecting = sorted(path.name for path in (ROOT / "docker").glob("compose*.yaml") if f'{MARKER}: "true"' in path.read_text())
        self.assertEqual(selecting, ["compose.live-editing.test.yaml"])
        script = (ROOT / "scripts" / "check_ui.sh").read_text()
        self.assertIn('on) export FLUX_LIVE_EDITING_TEST=1', script)
        self.assertIn('off) export FLUX_LIVE_EDITING_TEST=0', script)
        for name in ("check_application.sh", "check_ui.sh"):
            self.assertNotIn("compose.live-editing.test.yaml", (ROOT / "scripts" / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
