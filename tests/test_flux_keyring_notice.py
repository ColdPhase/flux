"""#1559: `./flux up` says so when the keyring refused to start or locked itself because its swap limit was reset.

Runs the launcher's own `keyring_notice` function against a fake `compose_main` that prints a keyring log, so nothing needs Docker.
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = (ROOT / "flux").read_text(encoding="utf-8")
LOCKED = ("Flux keyring locked itself: this container can now write memory to disk (its swap limit is gone, as `systemctl daemon-reload` does), "
          "so it wiped its boot key and refuses every request. Encrypted spaces stay locked until you restart Flux.")
REFUSED = "Flux keyring refuses to start: this server can write memory to disk. Turn off swap, limit this container's swap."


def function(name: str) -> str:
    start = LAUNCHER.index(f"\n{name}() {{") + 1
    line = LAUNCHER[start:LAUNCHER.index("\n", start)]
    return line if line.endswith("}") else LAUNCHER[start:LAUNCHER.index("\n}\n", start) + 3]


def notice(keyring_log: str) -> subprocess.CompletedProcess[str]:
    functions = "\n".join(function(name) for name in ("warn", "keyring_notice"))
    script = f"set -eu\ncompose_main() {{ printf '%s\\n' \"$KEYRING_LOG\"; }}\n{functions}\nkeyring_notice\n"
    return subprocess.run(["sh", "-c", script], env={"KEYRING_LOG": keyring_log, "PATH": "/usr/bin:/bin"}, capture_output=True, text=True, check=True)


class KeyringNoticeTest(unittest.TestCase):
    def test_a_keyring_that_locked_itself_is_reported_with_its_own_line(self) -> None:
        result = notice(f"Flux keyring ready\nGET /v1/boot 200 1ms\n{LOCKED}\nGET /v1/boot 503 1ms\n")
        self.assertEqual(result.stderr, f"flux: {LOCKED}\n")
        self.assertEqual(result.stdout, "")

    def test_a_keyring_that_refused_to_start_is_reported(self) -> None:
        self.assertEqual(notice(f"{REFUSED}\n{REFUSED}\n").stderr, f"flux: {REFUSED}\n")

    def test_a_restart_after_the_lock_clears_the_notice(self) -> None:
        # `docker restart` keeps the container's log: the lock line is old once "ready" came after it.
        self.assertEqual(notice(f"Flux keyring ready\n{LOCKED}\nFlux keyring ready\nGET /v1/boot 200 1ms\n").stderr, "")

    def test_a_healthy_idle_or_silent_keyring_is_not_reported(self) -> None:
        for log in ("Flux keyring ready\n", "Flux keyring is idle: FLUX_KEYRING_TOKEN is not set.\n", ""):
            with self.subTest(log=log):
                self.assertEqual(notice(log).stderr, "")

    def test_the_launcher_calls_it_after_a_start_and_after_a_failed_one(self) -> None:
        body = LAUNCHER[LAUNCHER.index("start_main() {"):]
        body = body[:body.index("\n}\n")]
        self.assertEqual(body.count("keyring_notice"), 3, "after both failed `up` commands and after a successful one")

    def test_the_line_it_looks_for_is_the_one_the_keyring_writes(self) -> None:
        keyring = (ROOT / "app/apps/keyring/src/server.ts").read_text(encoding="utf-8")
        main = (ROOT / "app/apps/keyring/src/main.ts").read_text(encoding="utf-8")
        self.assertIn("'Flux keyring locked itself: ", keyring)
        self.assertIn("Flux keyring refuses to start: ", main)
        self.assertIn("Flux keyring ready", main)


if __name__ == "__main__":
    unittest.main()
