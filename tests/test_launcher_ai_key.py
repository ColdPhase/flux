"""`./flux up` makes the AI key file and turns agents on API keys on (founder decision 2026-11-13, #1438).

The functions are extracted from the real launcher and run against a temporary env file and state directory, with a stand-in
`docker`, so nothing touches the operator's own files. Standard library only.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ("say", "warn", "die", "env_value", "set_env_line", "background_key_dir", "docker_rootless", "check_background_key_file",
             "ensure_background_key")


def launcher_function(name: str) -> str:
    text = (ROOT / "flux").read_text(encoding="utf-8")
    match = re.search(rf"^{name}\(\) \{{.*?^\}}\n|^{name}\(\) \{{[^\n]*\}}\n", text, re.S | re.M)
    assert match, f"{name} not found in ./flux"
    return match.group(0)


class EnsureBackgroundKeyTest(unittest.TestCase):
    def run_launcher(self, base: Path, env_text: str, *, rootless: bool = False, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env_file = base / "docker" / ".env"
        env_file.parent.mkdir(parents=True, exist_ok=True)
        env_file.write_text(env_text)
        bindir = base / "bin"
        bindir.mkdir(exist_ok=True)
        docker = bindir / "docker"
        docker.write_text('#!/bin/sh\nprintf \'%s\\n\' \'["name=seccomp,profile=builtin"' + (',"name=rootless"' if rootless else '') + ']\'\n')
        docker.chmod(0o755)
        script = "".join(launcher_function(name) for name in FUNCTIONS)
        script = f'set -eu\nFLUX_ROOT="{base}"\nENV_FILE="{env_file}"\nPROJECT=flux-test\n{script}\nensure_background_key\n'
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        env.update({"PATH": f"{bindir}:{os.environ['PATH']}", "XDG_STATE_HOME": str(base / "state"), **(extra_env or {})})
        return subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env)

    def test_a_new_install_gets_a_private_key_file_and_agents_on_api_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            result = self.run_launcher(base, "FLUX_PERSONAL_RUNS=\nFLUX_BACKGROUND_KEY_HOST_FILE=\nOTHER=1\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            key = base / "state" / "flux" / "flux-test" / "background.key"
            self.assertEqual(key.stat().st_size, 32)
            self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700, "only this user reaches the directory")
            mode = stat.S_IMODE(key.stat().st_mode)
            self.assertEqual(mode & 0o222, 0, "nobody writes the key")
            if os.getuid() == 1000:
                self.assertEqual(mode, 0o400, "the containers' user is this user: nobody else reads it")
            env_text = (base / "docker" / ".env").read_text()
            self.assertIn(f"FLUX_BACKGROUND_KEY_HOST_FILE={key}\n", env_text)
            self.assertIn("FLUX_PERSONAL_RUNS=on\n", env_text)
            self.assertIn("OTHER=1\n", env_text)
            secret = key.read_bytes()
            self.assertNotIn(secret.hex(), result.stdout + result.stderr, "the key's bytes are never printed")
            # A second `up` keeps the file and the settings as they are.
            again = self.run_launcher(base, env_text)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertEqual(key.read_bytes(), secret)
            self.assertEqual((base / "docker" / ".env").read_text(), env_text)

    def test_an_existing_key_file_is_reused_never_replaced(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            key = base / "state" / "flux" / "flux-test" / "background.key"
            key.parent.mkdir(parents=True)
            key.write_bytes(b"k" * 32)
            result = self.run_launcher(base, "FLUX_PERSONAL_RUNS=\nFLUX_BACKGROUND_KEY_HOST_FILE=\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(key.read_bytes(), b"k" * 32)
            self.assertNotIn("Created the AI key file", result.stdout)

    def test_a_rootless_engine_or_another_uid_gets_a_readable_file_inside_the_private_directory(self) -> None:
        if os.getuid() == 0:
            self.skipTest("root hands the file to user 1000 instead")
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            result = self.run_launcher(base, "FLUX_PERSONAL_RUNS=\n", rootless=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            key = base / "state" / "flux" / "flux-test" / "background.key"
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o444)
            self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)

    def test_the_operators_off_switch_and_own_key_file_are_left_alone(self) -> None:
        for own in (False, True):
            with self.subTest(own_key_file=own), tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
                base = Path(directory).resolve()
                (base / "own.key").write_bytes(b"o" * 32)
                env_text = f"FLUX_PERSONAL_RUNS=\nFLUX_BACKGROUND_KEY_HOST_FILE={base / 'own.key'}\n" if own else "FLUX_PERSONAL_RUNS=off\nFLUX_BACKGROUND_KEY_HOST_FILE=\n"
                result = self.run_launcher(base, env_text)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((base / "docker" / ".env").read_text(), env_text)
                self.assertFalse((base / "state").exists(), "no key file is made")

    def test_a_setting_from_the_shell_wins_like_every_other(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            result = self.run_launcher(base, "FLUX_PERSONAL_RUNS=\n", extra_env={"FLUX_PERSONAL_RUNS": "off"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((base / "state").exists())

    def test_a_named_key_file_missing_on_this_machine_stops_before_compose_makes_it_a_directory(self) -> None:
        # A restore on another machine, or a copied docker/.env, names the original machine's file (#1438 review).
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            missing = base / "state" / "flux" / "old-project" / "background.key"
            env_text = f"FLUX_PERSONAL_RUNS=on\nFLUX_BACKGROUND_KEY_HOST_FILE={missing}\n"
            result = self.run_launcher(base, env_text)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not a file on this machine", result.stderr)
            self.assertFalse(missing.exists(), "nothing is made in its place")
            self.assertEqual((base / "docker" / ".env").read_text(), env_text)

    def test_a_left_temporary_link_is_not_written_through(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            target = base / "elsewhere"
            target.write_bytes(b"")
            key = base / "state" / "flux" / "flux-test" / "background.key"
            key.parent.mkdir(parents=True)
            Path(f"{key}.flux-new").symlink_to(target)
            result = self.run_launcher(base, "FLUX_PERSONAL_RUNS=\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_bytes(), b"", "the random bytes never go through a planted link")
            self.assertEqual(key.stat().st_size, 32)
            self.assertFalse(key.is_symlink())

    def test_a_symlinked_key_is_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-ai-key-") as directory:
            base = Path(directory).resolve()
            target = base / "elsewhere"
            target.write_bytes(b"x" * 32)
            key = base / "state" / "flux" / "flux-test" / "background.key"
            key.parent.mkdir(parents=True)
            key.symlink_to(target)
            result = self.run_launcher(base, "FLUX_PERSONAL_RUNS=\n")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr)


if __name__ == "__main__":
    unittest.main()
