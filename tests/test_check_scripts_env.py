"""A check script's test stack must not read the operator's `docker/.env` (#1210).

Compose reads `.env` from the project directory (`docker/`) for interpolation. The check scripts export only the
variables they need, so anything they leave unset (`FLUX_PERSONAL_RUNS`, `FLUX_AGENT_RUNTIME`, the VAPID keys) came
from the `docker/.env` that `./flux up` wrote in the same checkout, and four API tests failed there (v0.2 final check).
Every script that runs the source stack passes `--env-file /dev/null`.

The first test reads every script; the second one lets Compose resolve the real `compose=` line of three scripts with
a `.env` full of switches next to the Compose files. The second one is skipped without `docker compose`.
Standard library only.
"""

from __future__ import annotations

import re
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = sorted(p for p in (ROOT / "scripts").rglob("*.sh") if "node_modules" not in p.parts)
# A line that only prints a command for a person to copy, or asks Compose for its version.
NOT_A_RUN = re.compile(r"docker compose version|^\s*(printf|echo|step)\b|^\s*#")
# Scripts that run an operator-style stack on purpose, each with an env file of its own that replaces docker/.env
# (a copy of the checkout after `./flux up`, a generated .env from .env.example, a fixture file).
OWN_ENV = {
    "check_agent_runtime.sh", "check_backup.sh", "check_first_up.sh", "check_flux_cli.sh", "check_operator_compose.sh",
    "check_runtime_install.sh", "mobile_push_fixture.sh", "smoke_artifacts.sh", "smoke_runtime.sh",
}
# Release assets: an extracted release directory with its own compose.yaml, not the source stack.
RELEASE_ASSETS = re.compile(r"release-assets|local-assets|\"\$assets\"|\$assets/|\"\$dir/compose|\$assets\b")
# What the fixture `docker/.env` sets, as `docker compose config` prints it.
SETTINGS = ('FLUX_PERSONAL_RUNS: "on"', "FLUX_AGENT_RUNTIME: claude_code", "from-the-operator")
VARIABLES = {
    "POSTGRES_USER": "flux", "POSTGRES_DB": "flux", "POSTGRES_PASSWORD": "x", "FLUX_FIXTURE_TOKEN": "x",
    "FLUX_AUTH_SECRET": "x", "FLUX_PUBLIC_ORIGIN": "http://127.0.0.1:18089", "FLUX_KEYRING_TOKEN": "x",
    "FLUX_KEY_PIN_SECRET": "x", "FLUX_BACKGROUND_KEY_HOST_FILE": "/dev/null",
    "FLUX_LIVEKIT_API_KEY": "key", "FLUX_LIVEKIT_API_SECRET": "secret", "FLUX_LIVEKIT_PUBLIC_IP": "127.0.0.1",
    "FLUX_LIVEKIT_DOMAIN": "media.example.test", "FLUX_IMAGE_TAG": "envtest",
}


def compose_runs(path: Path) -> list[tuple[int, str]]:
    runs = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if "docker compose" in line and not NOT_A_RUN.search(line):
            runs.append((number, line))
    return runs


class CheckScriptsEnvTest(unittest.TestCase):
    def test_every_source_stack_run_ignores_the_operators_env_file(self) -> None:
        checked = 0
        for path in SCRIPTS:
            text = path.read_text(encoding="utf-8")
            if "docker/compose" not in text:
                continue
            for number, line in compose_runs(path):
                if RELEASE_ASSETS.search(line):
                    continue
                checked += 1
                where = f"{path.relative_to(ROOT)}:{number}"
                self.assertIn("--env-file", line, f"{where} lets Compose read docker/.env: {line.strip()}")
                if path.name not in OWN_ENV:
                    self.assertIn("--env-file /dev/null", line, f"{where} must pass --env-file /dev/null: {line.strip()}")
        # The three scripts of the issue are among them, not skipped by a changed pattern.
        self.assertGreaterEqual(checked, 20)
        for name in ("check_application.sh", "check_ui.sh", "check_live_ui.sh"):
            self.assertTrue(any("--env-file /dev/null" in line for _, line in compose_runs(ROOT / "scripts" / name)), name)

    @unittest.skipUnless(shutil.which("docker"), "docker compose is not installed")
    def test_a_docker_env_with_switches_does_not_reach_the_test_stack(self) -> None:
        if subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0:
            self.skipTest("docker compose is not installed")
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "docker").mkdir()
            for compose_file in (ROOT / "docker").glob("compose*.yaml"):
                shutil.copy(compose_file, work / "docker" / compose_file.name)
            (work / "docker" / ".env").write_text(
                "FLUX_PERSONAL_RUNS=on\nFLUX_AGENT_RUNTIME=claude_code\nFLUX_VAPID_PUBLIC_KEY=from-the-operator\n", encoding="utf-8"
            )
            for name in ("check_application.sh", "check_ui.sh", "check_live_ui.sh"):
                match = re.search(r'^compose="(docker compose [^"]*)"', (ROOT / "scripts" / name).read_text(encoding="utf-8"), re.M)
                self.assertIsNotNone(match, f"{name} has no compose= line")
                command = shlex.split(match.group(1).replace("$project", "envtest").replace("docker/compose", f"{work}/docker/compose"))
                resolved = self.config(command, work)
                # Control: without the flag the same stack does read the operator's file, so the check can fail.
                without = [word for word in command if word not in ("--env-file", "/dev/null")]
                leaked = self.config(without, work)
                for setting in SETTINGS:
                    self.assertIn(setting, leaked, f"{name}: {setting} does not reach a stack without the flag")
                    self.assertNotIn(setting, resolved, f"{name}: {setting} from docker/.env reached the test stack")

    def config(self, command: list[str], work: Path) -> str:
        environment = {"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(work), **VARIABLES}
        result = subprocess.run([*command, "config"], capture_output=True, text=True, env=environment, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout


if __name__ == "__main__":
    unittest.main()
