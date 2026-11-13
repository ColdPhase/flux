"""`./flux up` prints the setup link while no company exists (#1471).

The first account, the company's owner, is made only from `<origin>/setup#<token>` (FLUX_SETUP_TOKEN in docker/.env), so `./flux up`
writes the token when the file has none and prints the link while no company exists. Runs the real `flux` launcher with a stub `docker`
that answers the one question it asks (how many company workspaces exist). No Docker resource is created and nothing leaves the
temporary checkout.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INFO_OK = '{"OSType":"linux","OperatingSystem":"Ubuntu 24.04","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}'
TOKEN = "c0ffee" * 10 + "abcd"
SETUP_LINE = "Set up Flux: open this link and create the owner's account"

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


class SetupLinkTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="flux-setup-link-")
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
        self.env_file = self.checkout / "docker/.env"

    def up(self, origin: str, count: str, token: str | None = TOKEN, extra: str = "") -> subprocess.CompletedProcess[str]:
        self.env_file.write_text(
            f"FLUX_PROJECT=flux-setup-test\nFLUX_PORT=8081\nFLUX_PUBLIC_ORIGIN={origin}\nFLUX_AGENT_RUNTIME=\nFLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=\n"
            + (f"FLUX_SETUP_TOKEN={token}\n" if token is not None else "") + extra
            + "FLUX_RUNTIME_MANAGER_SECRET=" + "a" * 64 + "\nFLUX_RUNTIME_SECRET_1=" + "b" * 64 + "\n")
        self.env_file.chmod(0o600)
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        env.update(PATH=f"{self.bin_dir}:{os.environ['PATH']}", FLUX_TEST_LOG=str(self.log), FLUX_TEST_INFO=INFO_OK, FLUX_TEST_PSQL=count,
                   FLUX_WAIT_TIMEOUT="5")
        return subprocess.run([str(self.checkout / "flux"), "up"], cwd=self.base, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=60)

    def test_no_company_prints_the_setup_link_on_any_origin(self) -> None:
        for origin in ("https://flux.example.org", "http://127.0.0.1:8081"):
            done = self.up(origin, "0")
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertIn(SETUP_LINE, done.stdout)
            self.assertIn(f"  {origin}/setup#{TOKEN}\n", done.stdout)
            self.assertNotIn(TOKEN, done.stderr, "the token goes to the terminal's output only")

    def test_once_a_company_exists_there_is_no_link(self) -> None:
        done = self.up("https://flux.example.org", "1")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        self.assertIn("People join from the invite links you make in Settings › Company", done.stdout)

    def test_an_env_file_without_a_token_gets_one_and_keeps_every_other_line(self) -> None:
        done = self.up("https://flux.example.org", "0", token=None)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        text = self.env_file.read_text()
        tokens = re.findall(r"^FLUX_SETUP_TOKEN=([0-9a-f]{64})$", text, re.MULTILINE)
        self.assertEqual(len(tokens), 1, text)
        self.assertIn(f"/setup#{tokens[0]}", done.stdout)
        self.assertIn("FLUX_PUBLIC_ORIGIN=https://flux.example.org\n", text)
        self.assertEqual(oct(self.env_file.stat().st_mode & 0o777), "0o600")
        again = self.up("https://flux.example.org", "0", token=tokens[0])
        self.assertIn(f"/setup#{tokens[0]}", again.stdout, "the token stays the same")

    def test_with_single_sign_on_only_the_provider_makes_the_first_account(self) -> None:
        done = self.up("https://flux.example.org", "0", extra="FLUX_OIDC_ISSUER=https://id.example.org\n")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(TOKEN, done.stdout)
        self.assertIn("the first person your identity provider lets in becomes the company's owner", done.stdout)

    def test_a_database_that_does_not_answer_never_stops_up_and_says_nothing(self) -> None:
        done = self.up("https://flux.example.org", "fail")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        self.assertNotIn(SETUP_LINE, done.stdout)


if __name__ == "__main__":
    unittest.main()
