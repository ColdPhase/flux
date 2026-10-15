"""The live vendor check is optional: it refuses by default and no required check runs it (#279)."""

import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = "check_vendor_live"


class VendorLiveTest(unittest.TestCase):
    def test_refuses_without_the_explicit_opt_in(self) -> None:
        env = {key: value for key, value in os.environ.items() if key != "FLUX_LIVE_VENDOR"}
        for value in (None, "", "0", "true"):
            with self.subTest(value=value):
                run_env = dict(env) if value is None else {**env, "FLUX_LIVE_VENDOR": value}
                result = subprocess.run(["sh", str(ROOT / "scripts/check_vendor_live.sh")], env=run_env, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("FLUX_LIVE_VENDOR=1", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_no_required_check_or_workflow_runs_it(self) -> None:
        # The application check, every GitHub workflow that is not manually dispatched only, the
        # repository-check entry points and the other check scripts.
        names = ["scripts/check_application.sh", "scripts/check_agent_setup.py", "scripts/check_agent_runtime.sh", "scripts/check_ui.sh", "docker/compose.test.yaml"]
        for workflow in (ROOT / ".github/workflows").glob("*.y*ml"):
            names.append(str(workflow.relative_to(ROOT)))
        for name in names:
            path = ROOT / name
            if not path.exists():
                continue
            with self.subTest(file=name):
                self.assertNotIn(SCRIPT, path.read_text(encoding="utf-8"), f"{name} must not run the optional live vendor check")
        for path in (ROOT / "scripts").glob("check_*"):
            if path.name == "check_vendor_live.sh":
                continue
            with self.subTest(file=str(path.relative_to(ROOT))):
                self.assertNotIn(SCRIPT, path.read_text(encoding="utf-8", errors="ignore"), f"{path.name} must not run the optional live vendor check")

    def test_the_script_only_reads_status(self) -> None:
        text = (ROOT / "scripts/check_vendor_live.sh").read_text(encoding="utf-8")
        for forbidden in ("auth login", "login --", "auth logout", " logout", "-p ", "exec "):
            self.assertNotIn(forbidden, text.replace("# ", "\n# ").split("set -eu", 1)[1], forbidden)
