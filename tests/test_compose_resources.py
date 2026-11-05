"""#862: the base stack is light at idle and its default limits fit a 4 GB host.

Cheap health checks (a probe is an `exec` into the container, so a Node process every few seconds was most of an idle
instance's CPU), a long interval with a fast first start, and default memory limits that add up to under 3 GiB.
Standard library only (no YAML parser), like the other Compose tests.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ROOT / "docker"
FILES = ("compose.yaml", "compose.source.yaml")
LIMITS = {"db": "FLUX_DB_MEMORY", "api": "FLUX_API_MEMORY", "worker": "FLUX_WORKER_MEMORY", "keyring": "FLUX_KEYRING_MEMORY"}
UNITS = {"m": 1, "g": 1024}


def service_block(text: str, name: str) -> str:
    match = re.search(rf"(?m)^  {name}:\n((?:    .*\n|\n)+)", text)
    assert match, name
    return match.group(1)


def mebibytes(size: str) -> int:
    match = re.fullmatch(r"(\d+)([mg])", size)
    assert match, size
    return int(match.group(1)) * UNITS[match.group(2)]


class ComposeResourcesTest(unittest.TestCase):
    def test_probes_do_not_start_node_and_run_rarely(self) -> None:
        for name in FILES:
            text = (DOCKER / name).read_text(encoding="utf-8")
            for service in ("db", "api", "keyring"):
                with self.subTest(file=name, service=service):
                    health = re.search(r"(?s)    healthcheck:\n(.*?)(?=\n    \S|\n  \S|\Z)", service_block(text, service))
                    self.assertIsNotNone(health, "no healthcheck")
                    block = health.group(1)
                    self.assertNotRegex(block, r'"node"', "a probe that starts Node costs about 70 ms of CPU each time")
                    self.assertIn("interval: 30s", block)
                    self.assertRegex(block, r"start_period: \d+s")
                    self.assertRegex(block, r"start_interval: (250ms|500ms|1s)")
                    if service == "api":
                        self.assertIn('"-Y", "off"', block, "busybox wget follows http_proxy unless told not to, and the loopback probe would fail")

    def test_the_keyring_token_never_goes_into_a_process_argument(self) -> None:
        for name in FILES:
            block = service_block((DOCKER / name).read_text(encoding="utf-8"), "keyring")
            probe = re.search(r"(?m)^      test: (\[.*\])$", block)
            self.assertIsNotNone(probe, name)
            self.assertIn("printf", probe.group(1))
            self.assertIn("nc -w", probe.group(1))
            self.assertNotIn("--header", probe.group(1), f"{name}: a header argument would show the token in a process list")

    def test_default_limits_of_the_base_stack_fit_a_4_gb_host(self) -> None:
        for name in FILES:
            text = (DOCKER / name).read_text(encoding="utf-8")
            total = 0
            for service, variable in LIMITS.items():
                block = service_block(text, service)
                match = re.search(rf"mem_limit: \$\{{{variable}:-(\d+[mg])\}}\n    memswap_limit: \$\{{{variable}:-\1\}}", block)
                self.assertIsNotNone(match, f"{name}: {service} needs mem_limit and an equal memswap_limit from {variable}")
                total += mebibytes(match.group(1))
            self.assertLessEqual(total, 3 * 1024, f"{name}: the default limits add up to {total} MiB")


if __name__ == "__main__":
    unittest.main()
