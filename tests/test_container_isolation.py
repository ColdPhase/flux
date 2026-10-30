"""No Compose file in the repository gives a container the Docker or Podman API (F-022 T3, #278).

F-022 rejects every design in which a Flux service can reach a container engine's API: a socket proxy
or a validating proxy still leaves one gap away from root on the host. The agent runtime is a fixed
pool of Compose-declared slots instead. This test reads every Compose file in the repository and fails
if any of them mounts an engine socket or points DOCKER_HOST anywhere, and fails if a deployable one
shares the host's PID, IPC or network namespace, runs privileged or maps host devices. Standard library
only.

Service mounts use block lists of plain or simply quoted short-form scalars, including indentless
lists. Unparsed mount entries, volume aliases/anchors/tags, block scalars and flow-style services or
volume declarations are refused. Escaped quoted mapping keys are refused throughout the document,
including extension mappings merged into services. Empty top-level named-volume mappings are supported.
This is a fail-closed spelling restriction, not a YAML resolver; scripts/agent-runtime/inspect.py is the
authoritative check of Docker's resolved mount sources in the supported-host runtime check.
"""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP = {".git", ".worktrees", ".harness", "node_modules", "dist"}
COMPOSE_NAME = re.compile(r"(^|[./-])(compose|docker-compose)[^/]*\.ya?ml$|runtime-slot[^/]*\.ya?ml$")

SOCKET = re.compile(r"(docker|podman|containerd|crio|cri-dockerd)\.sock|/var/run/docker\b|/run/podman\b|/run/user/[^/\s]+/(docker|podman)", re.I)
# A host path mounted into a container comes from the checkout (a relative path, or an operator secret file
# or an operator-chosen FLUX_* variable whose default is not an absolute path). Absolute host paths are refused: /var/run, /run or / would hand over a directory
# holding an engine socket without naming it.
BIND = re.compile(r"""^\s*-\s*(?P<quote>["']?)(?P<src>\$\{[^}\\]*\}|[^\s:"'$\\]+):(?P<dst>/[^\s"':\\]*)(?::[A-Za-z,]+)?(?P=quote)\s*$""")
ALLOWED_BIND_SOURCE = re.compile(r"^(?:\.\.?/[^\s]*|\$\{(?:FLUX_[A-Z0-9_]+|MOBILE_STATE)(?::[-?](?!\s*[/~$])[^}]*)?\})$")
NAMED_VOLUME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
# Long-form mounts (`- type: bind`, then `source:`), and a named volume backed by a host path through `device:`.
LONG_BIND_TYPE = re.compile(r"^\s*(?:-\s*)?type:\s*[\"']?bind\b")
LONG_SOURCE = re.compile(r"^\s*(?:-\s*)?[\"']?source[\"']?:\s*(?P<src>[^\s]+)")
DEVICE = re.compile(r"^\s*[\"']?device[\"']?:\s*(?P<src>[^\s]+)")
TRAILING_COMMENT = re.compile(r"\s+#.*$")
VOLUMES = re.compile(r"""^(?P<indent> *)["']?volumes["']?:\s*(?P<value>.*)$""")
INLINE_VOLUMES = re.compile(r"""(?:^|[,{])\s*(?:volumes|["']volumes["'])\s*:""")
SERVICES = re.compile(r"""^["']?services["']?:\s*(?P<value>.*)$""")
MAPPING_ENTRY = re.compile(r"""^\s*(?P<key>[A-Za-z0-9_.-]+|["'][A-Za-z0-9_.-]+["']):\s*(?P<value>.*)$""")
BLOCK_ANCHOR = re.compile(r"&[A-Za-z0-9_-]+$")
EMPTY_NAMED_VOLUME = re.compile(r"^\s*[A-Za-z0-9][A-Za-z0-9_.-]*:\s*\{\s*\}\s*$")
UNSUPPORTED_VOLUME_STYLE = re.compile(r"(?:^\s*(?:-\s*)?|:\s*)[\[{>|&*!]")
YAML_TEXT_TOKEN = re.compile(r"""(?P<comment>(?<!\S)\#[^\n]*)|(?P<quoted>"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')""", re.S)
BLOCK_SCALAR = re.compile(r"^(?P<indent> *)(?:[^:\n]+:\s*|-\s*)[>|](?:[+-]?[1-9]?|[1-9][+-]?)\s*(?:#.*)?$")
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


def escaped_key_problems(text: str) -> list[str]:
    """Refuse YAML escapes in quoted keys without mistaking quoted or block-scalar values for keys."""
    lines = []
    scalar_indent = None
    for raw in text.splitlines(keepends=True):
        indent = len(raw) - len(raw.lstrip(" "))
        if scalar_indent is not None and (not raw.strip() or indent > scalar_indent):
            lines.append("\n" if raw.endswith("\n") else "")
            continue
        scalar_indent = None
        if match := BLOCK_SCALAR.fullmatch(raw.rstrip("\r\n")):
            scalar_indent = len(match.group("indent"))
        lines.append(raw)
    yaml_text = "".join(lines)
    problems = []
    for token in YAML_TEXT_TOKEN.finditer(yaml_text):
        quoted = token.group("quoted")
        if quoted and "\\" in quoted and yaml_text[token.end():].lstrip().startswith(":"):
            number = yaml_text.count("\n", 0, token.start()) + 1
            problems.append(f"{number}: unsupported escaped mapping key: {quoted}")
    return problems


def bind_problems(compose: Path, text: str) -> list[str]:
    """Refused sources and unparsed mount declarations in one Compose file, as `line: problem`."""
    problems = escaped_key_problems(text)
    volumes_indent = None
    named_volume_indent = None
    services_indent = None
    in_services = False
    for number, raw in enumerate(text.splitlines(), 1):
        line = TRAILING_COMMENT.sub("", raw) if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        # A flow/aliased service may hide all its mounts from the line parser. Restrict only
        # service mappings, leaving flow commands, environment and network settings alone.
        services = SERVICES.match(line)
        if services:
            in_services = True
            services_indent = None
            value = services.group("value")
            if value and not BLOCK_ANCHOR.fullmatch(value):
                problems.append(f"{number}: unsupported services spelling: {raw.strip()}")
        elif indent == 0:
            in_services = False
            services_indent = None
            if line.startswith(("{", "[")):
                problems.append(f"{number}: unsupported Compose spelling: {raw.strip()}")
        elif in_services:
            if services_indent is None:
                services_indent = indent
            if indent == services_indent:
                entry = MAPPING_ENTRY.fullmatch(line)
                if not entry or (entry.group("value") and not BLOCK_ANCHOR.fullmatch(entry.group("value"))):
                    problems.append(f"{number}: unsupported service spelling: {raw.strip()}")
        declaration = VOLUMES.match(line)
        if declaration:
            volumes_indent = len(declaration.group("indent"))
            named_volume_indent = None
            if declaration.group("value") and not (volumes_indent == 0 and declaration.group("value") == "{}"):
                problems.append(f"{number}: unsupported volume spelling: {raw.strip()}")
        elif INLINE_VOLUMES.search(line):
            problems.append(f"{number}: unsupported volume spelling: {raw.strip()}")
        elif volumes_indent is not None and (indent < volumes_indent or (indent == volumes_indent and not line.lstrip().startswith("- "))):
            volumes_indent = None
        if volumes_indent is not None and not declaration:
            if volumes_indent > 0:
                if not BIND.fullmatch(line):
                    problems.append(f"{number}: unsupported volume spelling: {raw.strip()}")
            else:
                if named_volume_indent is None:
                    named_volume_indent = indent
                empty_named = indent == named_volume_indent and EMPTY_NAMED_VOLUME.fullmatch(line)
                if not empty_named:
                    entry = MAPPING_ENTRY.fullmatch(line)
                    if not entry or "\\" in line or UNSUPPORTED_VOLUME_STYLE.search(line):
                        problems.append(f"{number}: unsupported volume spelling: {raw.strip()}")
                    elif entry.group("key").strip("\"'") in {"source", "device"}:
                        if problem := source_problem(compose, entry.group("value")):
                            problems.append(f"{number}: mount source {problem}: {raw.strip()}")
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
        for expected in ("docker/compose.yaml", "docker/compose.source.yaml", "docker/compose.runtime.test.yaml", "docker/runtime-slot.example.yaml", "docker/compose.runtime.yaml"):
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
            "flow mapping mount": "services:\n  x:\n    volumes:\n      - { type: bind, source: /var/run, target: /host-run }\n",
            "flow sequence mounts": 'services:\n  x:\n    volumes: ["/var/run:/host-run"]\n',
            "folded scalar mount": "services:\n  x:\n    volumes:\n      - >-\n        /var/run:/host-run\n",
            "indentless flow mapping mount": "services:\n  x:\n    volumes:\n    - { type: bind, source: /var/run, target: /host-run }\n",
            "indentless folded scalar mount": "services:\n  x:\n    volumes:\n    - >-\n      /var/run:/host-run\n",
            "whole flow service": 'services:\n  x: {image: busybox, volumes: ["/var/run:/host-run"]}\n',
            "aliased mount item": 'x-m: &m "/var/run:/host-run"\nservices:\n  x:\n    volumes:\n      - *m\n',
            "aliased volume list": 'x-m: &m ["/var/run:/host-run"]\nservices:\n  x:\n    volumes: *m\n',
            "anchored mount item": 'services:\n  x:\n    volumes:\n      - &m "/var/run:/host-run"\n',
            "tagged mount item": 'services:\n  x:\n    volumes:\n      - !!str "/var/run:/host-run"\n',
            "escaped quoted mount": 'services:\n  x:\n    volumes:\n      - "../app/\\u002e\\u002e/\\u002e\\u002e/\\u002e\\u002e/var/run:/host-run"\n',
            "aliased whole service": 'x-m: &m {volumes: ["/var/run:/host-run"]}\nservices:\n  x: *m\n',
            "aliased named-volume options": 'x-m: &m {type: none, o: bind, device: /var/run}\nvolumes:\n  host:\n    driver_opts: *m\n',
            "quoted host device key": 'volumes:\n  host:\n    driver_opts:\n      "device": "/var/run"\n',
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.assertTrue(bind_problems(compose, text), f"accepted: {label}")

    def test_repository_check_refuses_unparsed_compose_mounts(self) -> None:
        cases = {
            "D": "services:\n  x:\n    image: busybox\n    volumes:\n    - {type: bind, source: /var/run, target: /host-run}\n",
            "E": "services:\n  x:\n    image: busybox\n    volumes:\n    - >-\n      /var/run:/host-run\n",
            "F": 'services:\n  x: {image: busybox, volumes: ["/var/run:/host-run"]}\n',
            "G": 'x-m: &m "/var/run:/host-run"\nservices:\n  x:\n    image: busybox\n    volumes:\n      - *m\n',
            "escaped service volume key": 'services:\n  x:\n    image: busybox\n    "volu\\u006des": ["/var/run:/host-run"]\n',
            "escaped root and volume keys": '"serv\\u0069ces":\n  x:\n    image: busybox\n    "volu\\u006des": ["/var/run:/host-run"]\n',
            "escaped extension key merged into service": 'x-m: &m {image: busybox, "volu\\u006des": ["/var/run:/host-run"]}\nservices:\n  x:\n    <<: *m\n',
        }
        self.test_bind_mounts_come_only_from_the_checkout()
        with tempfile.TemporaryDirectory(prefix="mount-guard-", dir=ROOT / "docker") as temporary:
            probe = Path(temporary) / "compose.probe.yaml"
            for label, text in cases.items():
                with self.subTest(label):
                    probe.write_text(text, encoding="utf-8")
                    with self.assertRaises(AssertionError) as refused:
                        self.test_bind_mounts_come_only_from_the_checkout()
                    self.assertIn(probe.relative_to(ROOT).as_posix(), str(refused.exception))

    def test_indentless_mounts_and_empty_named_volumes_are_supported(self) -> None:
        compose = ROOT / "docker" / "compose.yaml"
        text = 'services:\n  x:\n    volumes:\n    - "files:/data/files:z"\n    - ../app/tooling/migrate.ts:/app/tooling/migrate.ts:ro,z\n' \
               '    command: ["echo", "volumes: are mounted"]\nvolumes:\n  files: {}\n  pgdata:\n'
        self.assertEqual(bind_problems(compose, text), [])
        with tempfile.TemporaryDirectory(prefix="mount-guard-", dir=ROOT / "docker") as temporary:
            probe = Path(temporary) / "compose.probe.yaml"
            probe.write_text(text, encoding="utf-8")
            self.test_bind_mounts_come_only_from_the_checkout()

    def test_escaped_values_and_supported_mapping_merges_remain_supported(self) -> None:
        compose = ROOT / "docker" / "compose.yaml"
        text = 'x-service: &service\n  image: busybox\nx-env: &env\n  NOTE: "volu\\u006des: text"\n' \
               'services:\n  x:\n    <<: *service\n    environment:\n      <<: *env\n' \
               '    command: ["echo", "\\\"volu\\\\u006des\\\": value"]\n' \
               '    volumes:\n      - files:/state\n  y:\n    image: busybox\n    command: >-\n' \
               '      echo \'"volu\\u006des": value\'\nvolumes:\n  files: {}\n' \
               '# "volu\\u006des": documentation example\n'
        self.assertEqual(bind_problems(compose, text), [])

    def test_the_bind_guard_keeps_the_legitimate_mounts(self) -> None:
        compose = ROOT / "docker" / "compose.yaml"
        text = "services:\n  x:\n    volumes:\n      - files:/data/files:z\n      - ../app/tooling/migrate.ts:/app/tooling/migrate.ts:ro,z\n" \
               "      - ${FLUX_BACKGROUND_KEY_HOST_FILE:-./background-key-unavailable}:/run/secrets/flux_background_key:ro,z\n" \
               "      - ${MOBILE_STATE:?}:/state:ro,z\n      - ../scripts/mobile-push:/fixture:ro,z  # fixture\n"
        self.assertEqual(bind_problems(compose, text), [])

    def test_volume_style_restrictions_do_not_apply_to_commands(self) -> None:
        compose = ROOT / "docker" / "compose.yaml"
        text = 'services:\n  x:\n    volumes:\n      - files:/data/files:z\n    command: ["sh", "-c"]\n' \
               '  y:\n    command: >-\n      echo test\n'
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

    def test_the_release_runtime_overlay_is_off_pull_only_and_isolated_like_the_source_stack(self) -> None:
        overlay = (ROOT / "docker" / "compose.runtime.yaml").read_text(encoding="utf-8")
        code = "\n".join(line for line in overlay.splitlines() if not line.lstrip().startswith("#"))
        self.assertNotRegex(code, r"(?m)^\s*build\s*:")
        self.assertRegex(code, r"x-runtime-hardening: &runtime-hardening\n  profiles: \[\"runtime\"\]")
        for service in ("runtime-install", "runtime-manager", "runtime-egress", "runtime-1", "runtime-2", "runtime-3", "runtime-4"):
            block = re.search(rf"^  {service}:\n((?:    .*\n|\n)+)", code, re.M)
            self.assertIsNotNone(block, service)
            self.assertRegex(block.group(1), r"<<: \*runtime-(hardening|slot)", service)
        networks = "\n" + code.split("\nnetworks:\n", 1)[1] + "\n"
        for name in ("runtime-control", "runtime-api", "runtime-install", "runtime-1", "runtime-2", "runtime-3", "runtime-4"):
            self.assertRegex(networks, rf"\n  {name}:\n    internal: true\n    driver_opts: \*runtime-network-opts\n", name)
        self.assertIn('inhibit_ipv4: "true"', code)
        # The slot settings are the source stack's (docker compose config is compared by scripts/release/compare_runtime_overlay.py).
        source = (ROOT / "docker" / "compose.source.yaml").read_text(encoding="utf-8")
        for setting in ("mem_limit: 2g", "memswap_limit: 2g", "cpus: 1", "pids_limit: 256", "restart: always",
                        'user: "1000:1000"', "read_only: true", "cap_drop: [ALL]"):
            self.assertIn(setting, source)
            self.assertIn(setting, code)
        # Off by default: the release's runtime switch is empty unless the operator sets it; it is never defaulted on.
        self.assertNotRegex(code, r"FLUX_AGENT_RUNTIME: \$\{FLUX_AGENT_RUNTIME:-[^}]")

    def test_runtime_services_are_only_in_the_runtime_profile(self) -> None:
        text = (ROOT / "docker" / "compose.source.yaml").read_text(encoding="utf-8")
        self.assertRegex(text, r"x-runtime-hardening: &runtime-hardening\n  profiles: \[\"runtime\"\]")
        for service in ("runtime-install", "runtime-manager", "runtime-egress", "runtime-1", "runtime-2", "runtime-3", "runtime-4"):
            block = re.search(rf"^  {service}:\n((?:    .*\n|\n)+)", text, re.M)
            self.assertIsNotNone(block, service)
            self.assertRegex(block.group(1), r"<<: \*runtime-(hardening|slot)", service)

    def test_without_the_runtime_api_and_worker_take_two_networks_like_the_release(self) -> None:
        # #744: every network takes one of Docker's address pools; the runtime's two join only with the runtime on.
        for name in ("compose.source.yaml", "compose.yaml"):
            text = (ROOT / "docker" / name).read_text(encoding="utf-8")
            for service in ("api", "worker"):
                block = re.search(rf"^  {service}:\n((?:    .*\n|\n)+)", text, re.M).group(1)
                self.assertEqual(re.findall(r"^    networks: (.*)$", block, re.M), ["[default, keyring]"], f"{name} {service}")
        overlay = (ROOT / "docker" / "compose.source.runtime.yaml").read_text(encoding="utf-8")
        code = "\n".join(line for line in overlay.splitlines() if not line.lstrip().startswith("#")) + "\n"
        self.assertEqual(code, "services:\n  api:\n    networks: [default, runtime-control, runtime-api, keyring]\n"
                               "  worker:\n    networks: [default, runtime-control, keyring]\n")
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        self.assertIn('COMPOSE_RUNTIME="$FLUX_ROOT/docker/compose.source.runtime.yaml"', launcher)
        self.assertIn('if runtime_on; then set -- -f "$COMPOSE_RUNTIME" "$@"; fi', launcher)
        self.assertIn("-f docker/compose.source.yaml -f docker/compose.source.runtime.yaml -f docker/compose.override.yaml",
                      (ROOT / "scripts" / "check_agent_runtime.sh").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
