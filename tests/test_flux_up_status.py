"""`./flux up` ends with a short status, and `./flux backup` names the AI key file it leaves out (#1471).

Runs the real `flux` launcher with a stub `docker`, so nothing is built or started and nothing leaves the temporary checkout.
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

DOCKER_STUB = r"""#!/bin/sh
[ "${1:-}" != --log-level ] || shift 2   # the launcher runs `docker --log-level error compose ...` (#1174)
printf '%s\n' "$*" >> "$FLUX_TEST_LOG"
case "$1" in
  info) [ "${2:-}" != --format ] || printf '%s\n' "$FLUX_TEST_INFO" ;;
  compose)
    case "$*" in
      *'psql'*'max(version)'*) printf '78\n' ;;
      *'psql'*'string_agg'*) printf '1,2,3\n' ;;
      *'psql'*) printf '1\n' ;;
      *'pg_dump --version'*) printf 'pg_dump (PostgreSQL) 17.0\n' ;;
      *'pg_dump'*) printf 'dump' ;;
      *'files-archive'*) printf 'files' ;;
    esac ;;
esac
exit 0
"""

STATUS_HEAD = "Status"


class UpStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="flux-status-")
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

    def run_flux(self, command: str, lines: list[str], *extra: str) -> subprocess.CompletedProcess[str]:
        env_file = self.checkout / "docker/.env"
        env_file.write_text("\n".join(["FLUX_PROJECT=flux-status-test", "FLUX_PORT=8081", "FLUX_SIGNUP=open", *lines]) + "\n")
        env_file.chmod(0o600)
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        env.update(PATH=f"{self.bin_dir}:{os.environ['PATH']}", FLUX_TEST_LOG=str(self.log), FLUX_TEST_INFO=INFO_OK, FLUX_WAIT_TIMEOUT="5")
        return subprocess.run([str(self.checkout / "flux"), command, *extra], cwd=self.base, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=60)

    def status(self, done: subprocess.CompletedProcess[str]) -> list[str]:
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        lines = done.stdout.splitlines()
        self.assertEqual(lines[-7], STATUS_HEAD, done.stdout)
        return lines[-6:]

    def test_a_local_install_says_what_is_off_and_still_offers_the_demo(self) -> None:
        done = self.run_flux("up", ["FLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081", "FLUX_VAPID_PUBLIC_KEY=PUBLIC", "FLUX_AGENT_RUNTIME="])
        self.assertEqual(self.status(done), [
            "  Address   http://127.0.0.1:8081",
            "  Email     off (set FLUX_SMTP_URL and FLUX_MAIL_FROM in docker/.env to send email)",
            "  Push      on for this computer; iPhone and iPad need an https address (FLUX_PUBLIC_ORIGIN)",
            "  AI        plans off (./flux ai on lets people sign in with their ChatGPT or Claude plan)",
            "  Calls     off (FLUX_CALLS=on in docker/.env turns them on)",
            "  Backups   none yet (run ./flux backup, and add it to cron: docs/operations/backup-restore.md)",
        ])
        self.assertIn("Create an account there, or run ./flux demo for sample data and two logins.", done.stdout)

    def test_a_server_with_everything_on_says_so_and_never_suggests_the_demo(self) -> None:
        backups = self.checkout / "backups"
        backups.mkdir()
        (backups / "flux-backup-flux-status-test-20261113T101500Z-0a1b2c3d.tar").write_text("x")
        done = self.run_flux("up", [
            "FLUX_PUBLIC_ORIGIN=https://flux.example.org", "FLUX_SMTP_URL=smtp://mail:25", "FLUX_VAPID_PUBLIC_KEY=PUBLIC",
            "FLUX_AGENT_RUNTIME=claude_code,codex", "FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-11-01",
            "FLUX_RUNTIME_MANAGER_SECRET=" + "a" * 64, "FLUX_RUNTIME_SECRET_1=" + "b" * 64])
        self.assertEqual(self.status(done), [
            "  Address   https://flux.example.org (HTTPS by the bundled Caddy)",
            "  Email     on",
            "  Push      on",
            "  AI        ChatGPT and Claude plans on",
            "  Calls     off (FLUX_CALLS=on in docker/.env turns them on)",
            "  Backups   last one 2026-11-13, in backups",
        ])
        self.assertNotIn("./flux demo", done.stdout + done.stderr)
        self.assertIn("Create an account there.", done.stdout)

    def test_calls_and_https_read_their_switches(self) -> None:
        """#1472 with #1477: the Calls line reads FLUX_CALLS, and the Address line says who serves HTTPS."""
        done = self.run_flux("up", ["FLUX_PUBLIC_ORIGIN=https://203.0.113.20", "FLUX_CALLS=on", "FLUX_AGENT_RUNTIME="])
        status = self.status(done)
        self.assertEqual(status[0], "  Address   https://203.0.113.20 (HTTPS by the bundled Caddy)")
        self.assertEqual(status[4], "  Calls     on (open 7881/tcp, 7882/udp and 3478/udp to this server)")
        done = self.run_flux("up", ["FLUX_PUBLIC_ORIGIN=https://flux.example.org", "FLUX_TRUSTED_PROXIES=172.27.0.1/32", "FLUX_AGENT_RUNTIME="])
        self.assertEqual(self.status(done)[0], "  Address   https://flux.example.org (HTTPS by your own proxy)")

    def test_each_plan_alone_is_named(self) -> None:
        for runtime, line in (("codex", "ChatGPT plans on, Claude plans off (./flux ai on turns them on)"),
                              ("claude_code", "Claude plans on, ChatGPT plans off")):
            with self.subTest(runtime=runtime):
                done = self.run_flux("up", ["FLUX_PUBLIC_ORIGIN=https://flux.example.org", f"FLUX_AGENT_RUNTIME={runtime}",
                                            "FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-11-01",
                                            "FLUX_RUNTIME_MANAGER_SECRET=" + "a" * 64, "FLUX_RUNTIME_SECRET_1=" + "b" * 64])
                self.assertEqual(self.status(done)[3], f"  AI        {line}")

    def test_without_vapid_keys_push_is_off(self) -> None:
        done = self.run_flux("up", ["FLUX_PUBLIC_ORIGIN=https://flux.example.org", "FLUX_AGENT_RUNTIME="])
        self.assertEqual(self.status(done)[2], "  Push      off (no VAPID keys in docker/.env)")

    def test_a_backup_names_the_ai_key_file_it_leaves_out_only_when_there_is_one(self) -> None:
        origin = "FLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081"
        done = self.run_flux("backup", [origin, "FLUX_BACKGROUND_KEY_HOST_FILE=/etc/flux/background.key"], "--output", str(self.base / "out"))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("Not in it: the AI key file /etc/flux/background.key. Copy that file to the same safe place; without it people connect their AI keys again.", done.stdout)
        plain = self.run_flux("backup", [origin], "--output", str(self.base / "out"))
        self.assertEqual(plain.returncode, 0, plain.stdout + plain.stderr)
        self.assertIn("Backup written:", plain.stdout)
        self.assertNotIn("AI key file", plain.stdout)


if __name__ == "__main__":
    unittest.main()
