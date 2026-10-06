"""No Compose file in the repository gives a container the Docker or Podman API (F-022 T3, #278).

F-022 rejects every design in which a Flux service can reach a container engine's API: a socket proxy
or a validating proxy still leaves one gap away from root on the host. The agent runtime is a fixed
pool of Compose-declared slots instead. This test reads every Compose file in the repository and fails
if any of them mounts an engine socket or points DOCKER_HOST anywhere, and fails if a deployable one
shares the host's PID, IPC or network namespace, runs privileged or maps host devices. Standard library
only.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP = {".git", ".worktrees", ".harness", "node_modules", "dist"}
COMPOSE_NAME = re.compile(r"(^|[./-])(compose|docker-compose)[^/]*\.ya?ml$|runtime-slot[^/]*\.ya?ml$")

SOCKET = re.compile(r"(docker|podman|containerd|crio|cri-dockerd)\.sock|/var/run/docker\b|/run/podman\b|/run/user/[^/\s]+/(docker|podman)", re.I)
FORBIDDEN = [
    (re.compile(r"^\s*DOCKER_HOST\s*[:=]", re.M), "DOCKER_HOST"),
    (re.compile(r"^\s*CONTAINER_HOST\s*[:=]", re.M), "CONTAINER_HOST"),
    (re.compile(r"^\s*privileged:\s*true", re.M), "privileged"),
    (re.compile(r"^\s*(pid|ipc|userns_mode|cgroup):\s*[\"']?host", re.M), "host namespace"),
    (re.compile(r"^\s*network_mode:\s*[\"']?host", re.M), "host network"),
    (re.compile(r"^\s*devices:", re.M), "devices"),
]


def compose_files() -> list[Path]:
    found = []
    for path in ROOT.rglob("*"):
        if any(part in SKIP for part in path.relative_to(ROOT).parts):
            continue
        if path.is_file() and COMPOSE_NAME.search(path.name):
            found.append(path)
    return sorted(found)


class ContainerIsolationTest(unittest.TestCase):
    def test_compose_files_are_found(self) -> None:
        names = {path.relative_to(ROOT).as_posix() for path in compose_files()}
        for expected in ("docker/compose.yaml", "docker/compose.source.yaml", "docker/compose.runtime.test.yaml", "docker/runtime-slot.example.yaml"):
            self.assertIn(expected, names)

    def test_no_compose_file_mounts_an_engine_socket(self) -> None:
        for path in compose_files():
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                self.assertIsNone(SOCKET.search(line), f"{path.relative_to(ROOT)}:{number} mounts a container engine socket: {line.strip()}")

    def test_no_deployable_compose_file_shares_the_host_or_raises_privileges(self) -> None:
        # Test-only overlays (*.test.yaml) set up network fixtures; none of them mounts a socket either.
        for path in compose_files():
            if path.name.endswith(".test.yaml"):
                continue
            text = "\n".join(line for line in path.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#"))
            for pattern, what in FORBIDDEN:
                self.assertIsNone(pattern.search(text), f"{path.relative_to(ROOT)} uses {what}")

    def test_the_check_notices_a_socket(self) -> None:
        for line in ["      - /var/run/docker.sock:/var/run/docker.sock", "- ${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman.sock:z",
                     "      - /run/user/1000/docker.sock:/sock", "  - /run/containerd/containerd.sock:/c.sock"]:
            self.assertIsNotNone(SOCKET.search(line), line)

    def test_runtime_networks_are_internal_without_a_host_address(self) -> None:
        text = (ROOT / "docker" / "compose.source.yaml").read_text(encoding="utf-8")
        networks = text.split("\nnetworks:\n", 1)[1]
        for name in ("runtime-control", "runtime-api", "runtime-install", "runtime-1", "runtime-2", "runtime-3", "runtime-4"):
            self.assertRegex(networks, rf"\n  {name}:\n    internal: true\n    driver_opts: \*runtime-network-opts\n", name)
        self.assertIn('x-runtime-network-opts: &runtime-network-opts\n  com.docker.network.bridge.inhibit_ipv4: "true"', text)
        example = (ROOT / "docker" / "runtime-slot.example.yaml").read_text(encoding="utf-8")
        self.assertIn('  runtime-5:\n    internal: true\n    driver_opts:\n      com.docker.network.bridge.inhibit_ipv4: "true"', example)

    def test_the_application_image_stays_the_last_dockerfile_stage(self) -> None:
        # Builds without --target (Compose's migrate service, the release workflow) take the last stage.
        stages = re.findall(r"^FROM \S+ AS (\S+)$", (ROOT / "docker" / "Dockerfile").read_text(encoding="utf-8"), re.M)
        self.assertEqual(stages[-1], "runtime")
        self.assertIn("agent-runtime", stages)

    def test_the_release_compose_file_keeps_the_runtime_off(self) -> None:
        text = (ROOT / "docker" / "compose.yaml").read_text(encoding="utf-8")
        self.assertNotIn("FLUX_AGENT_RUNTIME", text)
        self.assertNotIn("runtime-manager", text)

    def test_runtime_services_are_only_in_the_runtime_profile(self) -> None:
        text = (ROOT / "docker" / "compose.source.yaml").read_text(encoding="utf-8")
        self.assertRegex(text, r"x-runtime-hardening: &runtime-hardening\n  profiles: \[\"runtime\"\]")
        for service in ("runtime-install", "runtime-manager", "runtime-egress", "runtime-1", "runtime-2", "runtime-3", "runtime-4"):
            block = re.search(rf"^  {service}:\n((?:    .*\n|\n)+)", text, re.M)
            self.assertIsNotNone(block, service)
            self.assertRegex(block.group(1), r"<<: \*runtime-(hardening|slot)", service)


if __name__ == "__main__":
    unittest.main()
