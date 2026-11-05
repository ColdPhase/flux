"""The scripts that start Flux refuse a Docker Engine older than 25 with one line and the fix (#878).

The health checks use `start_interval`; `docker compose up` refuses on Engine 24 ("can't set healthcheck.start_interval as
feature require Docker Engine v25 or later") and starts nothing. `./flux` and the release's `runtime.sh` check the engine
first. Standard library only; `need_docker` is run from the real scripts with a stub of `docker`.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = "https://docs.docker.com/engine/install/"


def function(path: str, name: str) -> str:
    text = (ROOT / path).read_text(encoding="utf-8")
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.S | re.M)
    assert match, f"{name} not found in {path}"
    return match.group(0)


def stub(version: str | None) -> str:
    """A `docker` whose engine reports `version`; None = the daemon is not reachable."""
    answer = f"echo '{version}'"
    reach = "exit 1" if version is None else "exit 0"
    return f"""#!/bin/sh
case "$*" in
  "compose version") echo "Docker Compose version v2" ;;
  "version --format {{{{.Server.Version}}}}") {answer} ;;
  info*) {reach} ;;
esac
exit 0
"""


class EngineCheckTest(unittest.TestCase):
    def need_docker(self, path: str, version: str | None) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory(prefix="flux-engine-test-") as directory:
            base = Path(directory).resolve()
            (base / "bin").mkdir()
            docker = base / "bin" / "docker"
            docker.write_text(stub(version))
            docker.chmod(0o755)
            (base / ".env").write_text("A=1\n")
            (base / "compose.yaml").write_text("services: {}\n")
            script = (
                'warn() { printf "flux: %s\\n" "$*" >&2; }\ndie() { warn "$*"; exit 1; }\n'
                f'env_file="{base}/.env"; base_file="{base}/compose.yaml"; runtime_file="{base}/compose.yaml"\n'
                + re.search(r"^MIN_ENGINE_MAJOR=.*\n", (ROOT / path).read_text(encoding="utf-8"), re.M).group(0)
                + function(path, "need_docker") + "need_docker\necho passed\n"
            )
            return subprocess.run(["sh", "-c", script], capture_output=True, text=True,
                                  env={**os.environ, "PATH": f"{base / 'bin'}{os.pathsep}{os.environ['PATH']}"})

    def test_an_engine_older_than_25_is_refused_with_one_line_and_the_fix(self) -> None:
        for path in ("flux", "docker/runtime.sh"):
            for version in ("24.0.9", "20.10.24", "17.03.0-ce"):
                with self.subTest(path=path, version=version):
                    result = self.need_docker(path, version)
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertEqual(result.stderr.strip().splitlines(), [f"flux: Docker Engine 25 or newer is required; this one is {version}. Update it: {FIX}"])
                    self.assertNotIn("passed", result.stdout)

    def test_engine_25_and_newer_pass(self) -> None:
        for path in ("flux", "docker/runtime.sh"):
            for version in ("25.0.0", "25.0.0-rc.1", "28.0.4", "29.4.2"):
                with self.subTest(path=path, version=version):
                    result = self.need_docker(path, version)
                    self.assertEqual((result.returncode, result.stdout.strip(), result.stderr), (0, "passed", ""))

    def test_an_engine_that_is_not_docker_or_does_not_say_is_left_to_compose(self) -> None:
        for path in ("flux", "docker/runtime.sh"):
            for version in ("5.4.0", "", "unknown"):
                with self.subTest(path=path, version=version):
                    result = self.need_docker(path, version)
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, "passed"), result.stderr)

    def test_an_unreachable_daemon_still_says_so(self) -> None:
        result = self.need_docker("flux", None)
        self.assertEqual(result.returncode, 1)
        self.assertIn("The Docker daemon is not reachable", result.stderr)


if __name__ == "__main__":
    unittest.main()
