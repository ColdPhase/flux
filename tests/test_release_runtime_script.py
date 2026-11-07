"""docker/runtime.sh (the release's runtime operator script) with a recording stub of `docker`."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "docker" / "runtime.sh"
STUB = """#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$*" in
  "compose version") echo "Docker Compose version v2" ;;
  "volume inspect"*) exit 1 ;;
  "info --format {{.MemTotal}}") echo 4000000000 ;;
  "info --format {{.NCPU}}") echo 2 ;;
  *" logs "*)
    [ -z "${STUB_REFUSED:-}" ] || echo '{"event":"runtime_refused","message":"The agent runtime needs kernel.yama.ptrace_scope of 1 or higher"}'
    # The same container started again after the fix: its log keeps the old refusal and goes on with `ready`.
    [ -z "${STUB_READY_AFTER:-}" ] || echo '{"event":"ready","slot":"runtime-1","bootId":"b","enabled":["codex"],"capacity":2}' ;;
esac
exit 0
"""


class RuntimeScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        for name in ("compose.yaml", "compose.runtime.yaml"):
            (self.dir / name).write_text("services: {}\n")
        shutil_script = self.dir / "runtime.sh"
        shutil_script.write_bytes(SCRIPT.read_bytes())
        self.env = self.dir / ".env"
        self.env.write_text("FLUX_PROJECT=t\nFLUX_AGENT_RUNTIME=\nFLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=\n")
        (self.dir / "bin").mkdir()
        stub = self.dir / "bin" / "docker"
        stub.write_text(STUB)
        stub.chmod(0o755)
        self.log = self.dir / "log"

    def run_script(self, *args: str, stdin: str = "") -> subprocess.CompletedProcess:
        env = dict(
            os.environ, STUB_LOG=str(self.log), PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}",
            FLUX_ENV_FILE=str(self.env),
        )
        return subprocess.run(["sh", str(self.dir / "runtime.sh"), *args], env=env, input=stdin,
                              capture_output=True, text=True)

    def settings(self) -> dict[str, str]:
        return dict(line.split("=", 1) for line in self.env.read_text().splitlines())

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_codex_switches_on_with_secrets_and_both_compose_files(self) -> None:
        result = self.run_script("on", "codex")
        self.assertEqual(result.returncode, 0, result.stderr)
        settings = self.settings()
        self.assertEqual(settings["FLUX_AGENT_RUNTIME"], "codex")
        self.assertRegex(settings["FLUX_RUNTIME_MANAGER_SECRET"], r"^[0-9a-f]{64}$")
        self.assertRegex(settings["FLUX_RUNTIME_SECRET_1"], r"^[0-9a-f]{64}$")
        self.assertNotIn("FLUX_RUNTIME_SECRET_2", settings)  # one runtime for everyone
        up = [call for call in self.calls() if " up -d --wait" in call]
        self.assertEqual(len(up), 1)
        self.assertIn("-f " + str(self.dir / "compose.yaml") + " -f " + str(self.dir / "compose.runtime.yaml") + " --profile runtime", up[0])
        self.assertTrue(up[0].endswith("api worker runtime-manager runtime-egress runtime-1"), up[0])

    def test_claude_code_is_refused_without_the_commercial_terms_and_changes_nothing(self) -> None:
        before = self.env.read_text()
        result = self.run_script("on", "claude_code")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Commercial Terms", result.stderr)
        self.assertEqual(self.env.read_text(), before)
        self.assertEqual([c for c in self.calls() if " up " in c], [])
        bad = self.run_script("on", "claude_code", "--commercial-terms", "yesterday")
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(self.env.read_text(), before)
        ok = self.run_script("on", "claude_code,codex", "--commercial-terms", "2026-10-05")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(self.settings()["FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"], "2026-10-05")

    def test_unknown_values_and_commands_are_refused(self) -> None:
        for args in (("on", "gemini"), ("on",), ("frobnicate",), ("release", "slot-1"), ("purge", "--force")):
            with self.subTest(args=args):
                self.assertNotEqual(self.run_script(*args).returncode, 0)
        self.assertEqual([c for c in self.calls() if " up " in c], [])

    def test_off_empties_the_switch_and_removes_only_runtime_containers(self) -> None:
        self.run_script("on", "codex")
        self.log.unlink()
        result = self.run_script("off")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.settings()["FLUX_AGENT_RUNTIME"], "")
        self.assertFalse(any(" down" in c or "volume rm" in c for c in self.calls()))

    def test_purge_asks_first_and_only_yes_proceeds(self) -> None:
        self.assertNotEqual(self.run_script("purge", stdin="n\n").returncode, 0)
        self.assertEqual([c for c in self.calls() if " stop api worker" in c], [])
        self.assertEqual(self.run_script("purge", "-y").returncode, 0)
        self.assertTrue(any(" stop api worker" in c for c in self.calls()))

    def test_up_starts_a_refused_runtime_again_so_the_documented_fix_works(self) -> None:
        """#860: Compose leaves a running container alone, so without this the refusal of the old container would stay after the fix."""
        self.assertEqual(self.run_script("on", "codex").returncode, 0)
        self.log.write_text("")
        with mock.patch.dict(os.environ, {"STUB_REFUSED": "1"}):
            self.assertEqual(self.run_script("up").returncode, 0)
        calls = self.calls()
        removed = next(index for index, call in enumerate(calls) if call.endswith("rm -fs runtime-1"))
        started = next(index for index, call in enumerate(calls) if " up -d --wait " in call and "runtime-1" in call)
        self.assertLess(removed, started)
        self.log.write_text("")
        self.assertEqual(self.run_script("up").returncode, 0)
        self.assertFalse([call for call in self.calls() if "rm -fs runtime-1" in call], "a healthy runtime is left alone")

    def test_up_leaves_a_healthy_runtime_alone_whose_log_still_has_the_old_refusal(self) -> None:
        """#910: Compose started the refused container again after the fix, so its log has the refusal and then `ready`: it is not removed."""
        self.assertEqual(self.run_script("on", "codex").returncode, 0)
        self.log.write_text("")
        with mock.patch.dict(os.environ, {"STUB_REFUSED": "1", "STUB_READY_AFTER": "1"}):
            self.assertEqual(self.run_script("up").returncode, 0)
        self.assertFalse([call for call in self.calls() if "rm -fs runtime-1" in call], "a runtime that came up after its refusal is left alone")
        self.assertTrue([call for call in self.calls() if " up -d --wait " in call and "runtime-1" in call], "and up still checks it")

    def test_the_launcher_and_the_script_read_the_log_the_same_way(self) -> None:
        """#910: `runtime_refusal` of ./flux and of docker/runtime.sh report a refusal only when it is the last of refusal and `ready`."""
        refused = '{"event":"runtime_refused","message":"The agent runtime needs kernel.yama.ptrace_scope of 1 or higher"}'
        ready = '{"event":"ready","slot":"runtime-1","bootId":"b","enabled":["codex"],"capacity":2}'
        cases = (([], ""), ([refused], "ptrace_scope"), ([refused, ready], ""), ([refused, ready, refused], "ptrace_scope"), ([ready], ""))
        for path, compose in ((ROOT / "flux", "compose_main"), (SCRIPT, "compose")):
            function = re.search(r"^runtime_refusal\(\) \{\n.*?^\}", path.read_text(), re.M | re.S)
            self.assertIsNotNone(function, path.name)
            for lines, expected in cases:
                (self.dir / "container.log").write_text("".join(f"{line}\n" for line in lines))
                script = f'{compose}() {{ cat "{self.dir / "container.log"}"; }}\n{function.group(0)}\nruntime_refusal'
                out = subprocess.run(["sh", "-eu", "-c", script], capture_output=True, text=True)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertIn(expected, out.stdout, (path.name, lines))
                if not expected:
                    self.assertEqual(out.stdout.strip(), "", (path.name, lines))

    def test_the_script_never_touches_an_engine_socket(self) -> None:
        text = SCRIPT.read_text()
        self.assertNotIn("docker.sock", text)
        self.assertNotIn("podman", text)
        self.assertNotRegex(text, r"docker (run|exec|cp|inspect)\b")


if __name__ == "__main__":
    unittest.main()
