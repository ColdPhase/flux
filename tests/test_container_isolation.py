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
# A host path mounted into a container comes from the checkout (a relative path, or an operator secret file
# or an operator-chosen FLUX_* variable whose default is not an absolute path). Absolute host paths are refused: /var/run, /run or / would hand over a directory
# holding an engine socket without naming it.
BIND = re.compile(r"""^\s*-\s*["']?(?P<src>\$\{[^}]*\}|[^\s:"'$]+):(?P<dst>/[^\s"':]*)(?::[A-Za-z,]+)?["']?\s*$""")
ALLOWED_BIND_SOURCE = re.compile(r"^(?:\.\.?/[^\s]*|\$\{(?:FLUX_[A-Z0-9_]+|MOBILE_STATE)(?::[-?](?!\s*[/~$])[^}]*)?\})$")
NAMED_VOLUME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
# Long-form mounts (`- type: bind`, then `source:`), and a named volume backed by a host path through `device:`.
LONG_BIND_TYPE = re.compile(r"^\s*(?:-\s*)?type:\s*[\"']?bind\b")
LONG_SOURCE = re.compile(r"^\s*(?:-\s*)?source:\s*(?P<src>[^\s]+)")
DEVICE = re.compile(r"^\s*device:\s*(?P<src>[^\s]+)")
TRAILING_COMMENT = re.compile(r"\s+#.*$")
FORBIDDEN = [
    (re.compile(r"^\s*DOCKER_HOST\s*[:=]", re.M), "DOCKER_HOST"),
    (re.compile(r"^\s*CONTAINER_HOST\s*[:=]", re.M), "CONTAINER_HOST"),
    (re.compile(r"^\s*privileged:\s*true", re.M), "privileged"),
    (re.compile(r"^\s*(pid|ipc|userns_mode|cgroup):\s*[\"']?host", re.M), "host namespace"),
    (re.compile(r"^\s*network_mode:\s*[\"']?host", re.M), "host network"),
    (re.compile(r"^\s*devices:", re.M), "devices"),
]


def source_problem(compose: Path, source: str) -> str | None:
    """Why a mount source is refused, or None. Relative sources must stay inside the checkout once resolved."""
    source = source.strip("\"'")
    if NAMED_VOLUME.match(source):
        return None
    default = re.match(r"^\$\{[^}:]*:[-?](?P<default>[^}]*)\}$", source)
    if default and default.group("default").startswith("."):
        source = default.group("default")
    if source.startswith("."):
        if (compose.parent / source).resolve().is_relative_to(ROOT.resolve()):
            return None
        return "resolves outside the checkout"
    if ALLOWED_BIND_SOURCE.match(source):
        return None
    return "is a host path outside the checkout"


def bind_problems(compose: Path, text: str) -> list[str]:
    """Every mount or host-backed volume in one Compose file that is not from the checkout, as `line: problem`."""
    problems = []
    for number, raw in enumerate(text.splitlines(), 1):
        line = TRAILING_COMMENT.sub("", raw) if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        if LONG_BIND_TYPE.match(line):
            problems.append(f"{number}: long-form bind mount: {raw.strip()}")
        for pattern in (LONG_SOURCE, DEVICE):
            match = pattern.match(line)
            if match and (problem := source_problem(compose, match.group("src"))):
                problems.append(f"{number}: mount source {problem}: {raw.strip()}")
        match = BIND.match(line)
        if match and (problem := source_problem(compose, match.group("src"))):
            problems.append(f"{number}: mount source {problem}: {raw.strip()}")
    return problems


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

    def test_bind_mounts_come_only_from_the_checkout(self) -> None:
        for path in compose_files():
            problems = bind_problems(path, path.read_text(encoding="utf-8"))
            self.assertEqual(problems, [], f"{path.relative_to(ROOT)} binds a host path outside the checkout")

    def test_the_bind_guard_refuses_each_host_path_spelling(self) -> None:
        compose = ROOT / "docker" / "compose.yaml"
        cases = {
            "long form with type first": "services:\n  x:\n    volumes:\n      - type: bind\n        source: /var/run\n        target: /host-run\n",
            "long form source alone": "services:\n  x:\n    volumes:\n      - source: /var/run\n        target: /host-run\n",
            "short form with a trailing comment": "services:\n  x:\n    volumes:\n      - /run:/host-run:ro # operator mount\n",
            "relative path escaping the checkout": "services:\n  x:\n    volumes:\n      - ../../../../var/run:/host-run\n",
            "default that escapes the checkout": "services:\n  x:\n    volumes:\n      - ${FLUX_X:-../../../../var/run}:/host-run\n",
            "named volume backed by a host path": "volumes:\n  host:\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run\n",
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.assertTrue(bind_problems(compose, text), f"accepted: {label}")

    def test_the_bind_guard_keeps_the_legitimate_mounts(self) -> None:
        compose = ROOT / "docker" / "compose.yaml"
        text = "services:\n  x:\n    volumes:\n      - files:/data/files:z\n      - ../app/tooling/migrate.ts:/app/tooling/migrate.ts:ro,z\n" \
               "      - ${FLUX_BACKGROUND_KEY_HOST_FILE:-./background-key-unavailable}:/run/secrets/flux_background_key:ro,z\n" \
               "      - ${MOBILE_STATE:?}:/state:ro,z\n      - ../scripts/mobile-push:/fixture:ro,z  # fixture\n"
        self.assertEqual(bind_problems(compose, text), [])

    def test_the_bind_check_notices_directory_mounts(self) -> None:
        for line in ["      - /var/run:/host-run", "      - /run:/host-run:ro", "      - /:/host", "      - ${FLUX_X:-/var/run}:/x", "      - ~/sock:/sock"]:
            match = BIND.match(line)
            self.assertIsNotNone(match, line)
            source = match.group("src")
            self.assertFalse(NAMED_VOLUME.match(source) or ALLOWED_BIND_SOURCE.match(source), line)
        for line in ["      - pgdata:/var/lib/postgresql", "      - ../app/tooling/migrate.ts:/app/tooling/migrate.ts:ro,z",
                     "      - ${FLUX_BACKGROUND_KEY_HOST_FILE:-./background-key-unavailable}:/run/secrets/flux_background_key:ro,z"]:
            source = BIND.match(line).group("src")
            self.assertTrue(NAMED_VOLUME.match(source) or ALLOWED_BIND_SOURCE.match(source), line)

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
