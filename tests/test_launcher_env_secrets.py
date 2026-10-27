"""The launcher's env-file rewrite never exposes the secrets it copies (F-022 T3, #331 nit).

`set_env_line` writes a temporary copy of docker/.env, which holds every secret, before it replaces the file. The
copy must be private from the moment it is created, whatever umask the operator's shell has.
Standard library only; the function is extracted from the real launcher.
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


def launcher_function(name: str) -> str:
    text = (ROOT / "flux").read_text(encoding="utf-8")
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.S | re.M)
    assert match, f"{name} not found in ./flux"
    return match.group(0)


class EnvFileRewriteTest(unittest.TestCase):
    def test_the_temporary_copy_is_created_private_under_a_permissive_umask(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-env-test-") as directory:
            base = Path(directory).resolve()
            env_file = base / ".env"
            env_file.write_text("FLUX_RUNTIME_MANAGER_SECRET=aaaa\nOTHER=1\n")
            modes = base / "modes"
            bindir = base / "bin"
            bindir.mkdir()
            # A stand-in awk records the temporary copy's mode while it is being written (the shell has already
            # created it by then), then does the real work.
            real_awk = subprocess.run(["sh", "-c", "command -v awk"], capture_output=True, text=True, check=True).stdout.strip()
            stub = bindir / "awk"
            stub.write_text(f'#!/bin/sh\nfor last; do :; done\nstat -c %a "{env_file}.flux-tmp" 2>/dev/null >> "{modes}" || stat -f %Lp "{env_file}.flux-tmp" >> "{modes}"\nexec {real_awk} "$@"\n')
            stub.chmod(0o755)
            script = launcher_function("set_env_line") + f'\numask 000\nset_env_line "{env_file}" FLUX_RUNTIME_SECRET_1 bbbb\n'
            result = subprocess.run(["sh", "-c", script], capture_output=True, text=True, env={**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(modes.read_text().split(), ["600"], "the copy was not private while it held the secrets")
            self.assertEqual(env_file.read_text(), "FLUX_RUNTIME_MANAGER_SECRET=aaaa\nOTHER=1\nFLUX_RUNTIME_SECRET_1=bbbb\n")
            self.assertFalse((base / ".env.flux-tmp").exists(), "the temporary copy is removed")
            self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o644, "the real file keeps its own mode")

    def test_without_the_subshell_umask_the_copy_would_be_world_readable_negative_control(self) -> None:
        # The launcher before this change: the same function without the private umask.
        with tempfile.TemporaryDirectory(prefix="flux-env-test-") as directory:
            base = Path(directory).resolve()
            env_file = base / ".env"
            env_file.write_text("A=1\n")
            old = launcher_function("set_env_line").replace("umask 077", "true")
            script = old + f'\numask 000\nawk() {{ {{ stat -c %a "{env_file}.flux-tmp" 2>/dev/null || stat -f %Lp "{env_file}.flux-tmp"; }} >&2; command awk "$@"; }}\nset_env_line "{env_file}" B 2\n'
            result = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("666", result.stderr.split(), result.stderr)


if __name__ == "__main__":
    unittest.main()
