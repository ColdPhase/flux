"""`./flux upgrade` handles the settings that a release renamed or removed (#1241): it moves a renamed one with its value and says so,
names a removed one with the reason, and ignores none silently. The functions are extracted from the real launcher; a new setting needs no line."""

from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def launcher_function(name: str) -> str:
    text = (ROOT / "flux").read_text(encoding="utf-8")
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.S | re.M)
    assert match, f"{name} not found in ./flux"
    return match.group(0)


class EnvChangesTest(unittest.TestCase):
    def apply(self, changes: str, env: str) -> tuple[str, str]:
        with tempfile.TemporaryDirectory(prefix="flux-env-changes-") as directory:
            root = Path(directory).resolve()
            (root / "docker").mkdir()
            (root / "docker" / "env-changes.txt").write_text(changes, encoding="utf-8")
            env_file = root / "docker" / ".env"
            env_file.write_text(env, encoding="utf-8")
            script = (
                f'FLUX_ROOT="{root}"\nENV_FILE="{env_file}"\nsay() {{ printf "%s\\n" "$*"; }}\ndie() {{ printf "DIE %s\\n" "$*"; exit 1; }}\n'
                + launcher_function("set_env_line") + launcher_function("drop_env_line") + launcher_function("apply_env_changes") + "apply_env_changes\n"
            )
            result = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout, env_file.read_text(encoding="utf-8")

    def test_a_renamed_setting_moves_with_its_value_and_is_reported(self) -> None:
        out, env = self.apply("# comment\nrename FLUX_OLD FLUX_NEW\n", "A=1\nFLUX_OLD=a/b=c\nB=2\n")
        self.assertEqual(env, "A=1\nB=2\nFLUX_NEW=a/b=c\n")
        self.assertIn("renamed FLUX_OLD to FLUX_NEW", out)
        self.assertIn("the value is kept", out)

    def test_a_renamed_setting_that_is_set_under_both_names_keeps_the_new_one_and_says_so(self) -> None:
        out, env = self.apply("rename FLUX_OLD FLUX_NEW\n", "FLUX_OLD=1\nFLUX_NEW=2\n")
        self.assertEqual(env, "FLUX_OLD=1\nFLUX_NEW=2\n")
        self.assertIn("FLUX_NEW is used", out)
        self.assertIn("Remove FLUX_OLD", out)

    def test_a_removed_setting_is_named_with_its_reason_and_left_alone(self) -> None:
        out, env = self.apply("remove FLUX_GONE the feature is always on\n", "FLUX_GONE=off\nB=2\n")
        self.assertEqual(env, "FLUX_GONE=off\nB=2\n")
        self.assertIn("FLUX_GONE", out)
        self.assertIn("is no longer used: the feature is always on", out)

    def test_a_setting_the_file_does_not_hold_says_nothing_and_changes_nothing(self) -> None:
        out, env = self.apply("rename FLUX_OLD FLUX_NEW\nremove FLUX_GONE why\n", "B=2\n")
        self.assertEqual((out, env), ("", "B=2\n"))

    def test_an_unknown_action_fails_the_function_so_the_upgrade_reports_a_failed_upgrade(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-env-changes-") as directory:
            root = Path(directory).resolve()
            (root / "docker").mkdir()
            (root / "docker" / "env-changes.txt").write_text("rename-ish A B\n", encoding="utf-8")
            (root / "docker" / ".env").write_text("A=1\n", encoding="utf-8")
            script = (f'FLUX_ROOT="{root}"\nENV_FILE="{root}/docker/.env"\nsay() {{ :; }}\nwarn() {{ printf "WARN %s\\n" "$*"; }}\n'
                      'upgrade_failed() { printf "UPGRADE_FAILED %s\\n" "$1"; exit 1; }\n'
                      + launcher_function("set_env_line") + launcher_function("drop_env_line") + launcher_function("apply_env_changes")
                      + 'apply_env_changes || upgrade_failed "docker/env-changes.txt could not be applied (see above)"\necho not-reached\n')
            result = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("WARN docker/env-changes.txt: unknown action 'rename-ish'", result.stdout)
            self.assertIn("UPGRADE_FAILED docker/env-changes.txt could not be applied", result.stdout)
            self.assertNotIn("not-reached", result.stdout)

    def test_the_launcher_calls_upgrade_failed_when_the_changes_cannot_be_applied(self) -> None:
        upgrade = launcher_function("upgrade_apply")
        self.assertRegex(upgrade, r'apply_env_changes \|\| upgrade_failed "[^"]+"')
        self.assertNotIn('die "docker/env-changes.txt', launcher_function("apply_env_changes"), "a bare die would leave the writers stopped without the way back")

    def test_the_shipped_file_lists_no_change_and_the_launcher_calls_it_during_an_upgrade(self) -> None:
        lines = [l for l in (ROOT / "docker" / "env-changes.txt").read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
        self.assertEqual(lines, [], "a release that renames or removes a setting adds its line here and to its notes")
        upgrade = launcher_function("upgrade_apply")
        self.assertIn("apply_env_changes", upgrade)
        self.assertLess(upgrade.index("apply_env_changes"), upgrade.index("get_images"), "reported before the images, after the backup")


if __name__ == "__main__":
    unittest.main()
