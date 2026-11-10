"""`./flux up` warns while nobody has signed up on a public address (#994, OWASP ASVS 4.0.3 V14.1).

The first account becomes the company's owner (F-037), so on a server whoever signs up first after the proxy goes live owns it. Runs the
real `flux` launcher with a stub `docker` that answers the one question the warning asks (how many company workspaces exist). No Docker
resource is created and nothing leaves the temporary checkout.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INFO_OK = '{"OSType":"linux","OperatingSystem":"Ubuntu 24.04","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}'
WARNING = "Nobody has signed up yet, and the first account becomes the company's owner."

DOCKER_STUB = r"""#!/bin/sh
[ "${1:-}" != --log-level ] || shift 2   # the launcher runs `docker --log-level error compose ...` (#1174)
printf '%s\n' "$*" >> "$FLUX_TEST_LOG"
case "$1" in
  info) [ "${2:-}" != --format ] || printf '%s\n' "$FLUX_TEST_INFO" ;;
  compose)
    case "$*" in
      *'config --services') printf 'runtime-1\n' ;;
      *'generate-vapid-keys'*) printf '{"publicKey":"PUBLIC","privateKey":"PRIVATE"}\n' ;;
      *'exec -T db psql'*) [ "$FLUX_TEST_PSQL" != fail ] || exit 1; printf '%s\n' "$FLUX_TEST_PSQL" ;;
    esac ;;
esac
exit 0
"""


class UnclaimedCompanyWarningTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="flux-unclaimed-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.checkout = self.base / "checkout"
        (self.checkout / "docker").mkdir(parents=True)
        shutil.copy2(ROOT / "flux", self.checkout / "flux")
        shutil.copy2(ROOT / "docker/.env.example", self.checkout / "docker/.env.example")
        shutil.copy2(ROOT / "docker/Dockerfile", self.checkout / "docker/Dockerfile")
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").write_text(DOCKER_STUB)
        (bin_dir / "docker").chmod(0o700)
        self.bin_dir = bin_dir
        self.log = self.base / "docker-calls"

    def up(self, origin: str, count: str, signup: str = "open") -> subprocess.CompletedProcess[str]:
        env_file = self.checkout / "docker/.env"
        env_file.write_text(
            f"FLUX_PROJECT=flux-unclaimed-test\nFLUX_PORT=8081\nFLUX_PUBLIC_ORIGIN={origin}\nFLUX_SIGNUP={signup}\nFLUX_AGENT_RUNTIME=\nFLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=\n"
            "FLUX_RUNTIME_MANAGER_SECRET=" + "a" * 64 + "\nFLUX_RUNTIME_SECRET_1=" + "b" * 64 + "\n")
        env_file.chmod(0o600)
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        env.update(PATH=f"{self.bin_dir}:{os.environ['PATH']}", FLUX_TEST_LOG=str(self.log), FLUX_TEST_INFO=INFO_OK, FLUX_TEST_PSQL=count,
                   FLUX_WAIT_TIMEOUT="5")
        return subprocess.run([str(self.checkout / "flux"), "up"], cwd=self.base, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=60)

    def asked(self) -> bool:
        return self.log.exists() and any("psql" in call for call in self.log.read_text().splitlines())

    def test_a_public_address_with_no_company_gets_the_warning_and_up_still_succeeds(self) -> None:
        done = self.up("https://flux.example.org", "0")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn(WARNING, done.stdout + done.stderr)
        self.assertIn("http://127.0.0.1:8081", done.stdout + done.stderr)
        self.assertIn("docs/operations/install.md", done.stdout + done.stderr)

    def test_no_warning_once_a_company_exists(self) -> None:
        done = self.up("https://flux.example.org", "1")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(WARNING, done.stdout + done.stderr)
        self.assertTrue(self.asked())

    def test_no_warning_and_no_question_for_a_loopback_origin(self) -> None:
        done = self.up("http://127.0.0.1:8081", "0")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(WARNING, done.stdout + done.stderr)
        self.assertFalse(self.asked(), "a local try-out is never asked about")

    def test_closed_sign_up_needs_no_warning(self) -> None:
        done = self.up("https://flux.example.org", "0", signup="off")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(WARNING, done.stdout + done.stderr)

    def test_a_database_that_does_not_answer_never_stops_up_and_says_nothing(self) -> None:
        done = self.up("https://flux.example.org", "fail")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(WARNING, done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main()
