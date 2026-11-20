"""#862: the base stack is light at idle and its default limits fit a 4 GB host.

Cheap health checks (a probe is an `exec` into the container, so a Node process every few seconds was most of an idle
instance's CPU), a long interval with a fast first start, and default memory limits that add up to under 3 GiB.
#1540 and #1558: every long-running service of every release Compose file runs under an init process and has a memory
limit equal to its memory+swap limit; the ones that can use a whole core have a CPU limit of their own.
Standard library only (no YAML parser), like the other Compose tests.
"""

from __future__ import annotations

import re
import subprocess
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


# Everything an owner can run (docker/compose.yaml and the overlays the launcher layers on it), and the source stack's two files
# that tests/test_release_compose_parity.py and scripts/release/compare_runtime_overlay.py keep in step with them.
RELEASE_FILES = ("compose.yaml", "compose.runtime.yaml", "compose.https.yaml", "compose.live.yaml", "compose.embeddings.yaml")
SOURCE_FILES = ("compose.source.yaml", "compose.source.runtime.yaml")
# Services that can use a core for as long as they run (media, embeddings, agents): a CPU limit of their own, so a busy one
# cannot take the host from the database and the keyring. `cpus` above the host's CPU count makes Docker refuse to start, so the
# default is one for all three. The rest (db, api, worker, keyring, the proxy, the runtime's manager and egress) have none.
CPU_LIMITED = {"livekit": "FLUX_LIVEKIT_CPUS", "embeddings": "FLUX_EMBEDDINGS_CPUS", "runtime-1": "FLUX_RUNTIME_CPUS"}
KEY = re.compile(r"(<<|[A-Za-z_][\w.-]*):(?:[ \t]+(.*))?")


def compose_services(text: str) -> dict[str, dict[str, str]]:
    """Service -> its own settings (key -> the text after the colon), with `<<: *anchor` merges resolved.

    Reads the line structure only: every `key:` line is a node under the nearest shallower one, `x-name: &anchor` blocks are
    kept to resolve merges, lists and block scalars are skipped. Enough for the scalar settings checked here.
    """
    top: dict[str, dict] = {}
    anchors: dict[str, dict] = {}
    stack: list[tuple[int, dict]] = [(-1, top)]
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = KEY.fullmatch(stripped)
        if not match:
            continue
        indent = len(raw) - len(raw.lstrip())
        while stack[-1][0] >= indent:
            stack.pop()
        value = (match.group(2) or "").split(" #")[0].strip()
        node: dict = {"": value}
        stack[-1][1][match.group(1)] = node
        stack.append((indent, node))
        anchor = re.match(r"&(\S+)", value)
        if anchor:
            anchors[anchor.group(1)] = node

    def resolve(node: dict) -> dict[str, str]:
        merged: dict[str, str] = {}
        merge = node.get("<<", {}).get("", "")
        if merge.startswith("*"):
            merged.update(resolve(anchors[merge[1:]]))
        merged.update({key: child[""] for key, child in node.items() if key not in ("", "<<")})
        return merged

    return {name: resolve(node) for name, node in top.get("services", {}).items() if name}


# What does not run for long: tasks that exit (`restart: "no"`), and the development mail catcher. A new service is a long-running one
# until it is listed here, so it must have the settings below or be named on purpose.
NOT_LONG_RUNNING = {"migrate", "files-init", "files-archive", "runtime-install", "mailpit"}


def long_running(files: tuple[str, ...], only: set[str] | None = None) -> dict[tuple[str, str], dict[str, str]]:
    """The services these files define (an overlay's `api:` that only adds settings has no image) that run for long."""
    found: dict[tuple[str, str], dict[str, str]] = {}
    for name in files:
        for service, settings in compose_services((DOCKER / name).read_text(encoding="utf-8")).items():
            if "image" in settings and service not in NOT_LONG_RUNNING and (only is None or service in only):
                found[(name, service)] = settings
    return found


def checked() -> dict[tuple[str, str], dict[str, str]]:
    """The release files' long-running services, and the same services in the source stack that keeps step with them."""
    release = long_running(RELEASE_FILES)
    return {**release, **long_running(SOURCE_FILES, {service for _, service in release})}


class EveryLongRunningServiceTest(unittest.TestCase):
    def test_the_reader_resolves_merges(self) -> None:
        text = ("x-base: &base\n  init: true\n  mem_limit: 1g\nservices:\n  a:\n    <<: *base\n    mem_limit: 2g\n    restart: always\n"
                "    command:\n      - |\n        port: 1\n  b:\n    restart: \"no\"\n")
        self.assertEqual(compose_services(text), {"a": {"init": "true", "mem_limit": "2g", "restart": "always", "command": ""}, "b": {"restart": '"no"'}})

    def test_every_service_the_checks_below_are_about_is_found(self) -> None:
        names = {service for _, service in long_running(RELEASE_FILES)}
        self.assertEqual(names, {"db", "api", "worker", "keyring", "runtime-manager", "runtime-egress", "runtime-1", "proxy", "livekit", "embeddings"})
        self.assertEqual({service for name, service in checked() if name.startswith("compose.source")},
                         {"db", "api", "worker", "keyring", "runtime-manager", "runtime-egress", "runtime-1"})

    def test_every_long_running_service_has_an_init_process(self) -> None:
        # #1540: PostgreSQL as PID 1 took an orphaned `pg_isready` (killed by its health check's timeout) for a crashed child of its own
        # and reset every backend; `wget` probes leave zombies on the others.
        for (name, service), settings in checked().items():
            with self.subTest(file=name, service=service):
                self.assertEqual(settings.get("init"), "true", f"{name}: {service} has no `init: true`")

    def test_every_long_running_service_has_a_memory_limit_without_swap(self) -> None:
        # #1558, F-030: memory equal to memory+swap, so a container cannot swap and the host plan adds up from these limits.
        for (name, service), settings in checked().items():
            with self.subTest(file=name, service=service):
                self.assertIn("mem_limit", settings, f"{name}: {service} has no memory limit")
                self.assertEqual(settings.get("memswap_limit"), settings["mem_limit"], f"{name}: {service}'s memswap_limit must equal its mem_limit")

    def test_the_services_that_can_use_a_core_have_a_cpu_limit(self) -> None:
        for (name, service), settings in checked().items():
            if service in CPU_LIMITED:
                with self.subTest(file=name, service=service):
                    self.assertRegex(settings.get("cpus", ""), rf"\$\{{{CPU_LIMITED[service]}:-\d+(\.\d+)?\}}", f"{name}: {service} has no CPU limit")

    def test_livekit_is_limited_and_hardened_like_the_other_services(self) -> None:
        # #1558: its own memory and CPU, and what the other release services drop: capabilities, new privileges, a writable root.
        livekit = long_running(("compose.live.yaml",))[("compose.live.yaml", "livekit")]
        self.assertEqual(livekit["mem_limit"], "${FLUX_LIVEKIT_MEMORY:-512m}")
        self.assertEqual(livekit["memswap_limit"], livekit["mem_limit"])
        self.assertEqual(livekit["cpus"], "${FLUX_LIVEKIT_CPUS:-1}")
        self.assertRegex(livekit["pids_limit"], r"\d+")
        self.assertEqual(livekit["cap_drop"], "[ALL]")
        self.assertEqual(livekit["security_opt"], '["no-new-privileges:true"]')
        self.assertEqual(livekit["read_only"], "true")
        # TURN/TLS listens on 443 inside the container, which needs the one capability back.
        turn = compose_services((DOCKER / "compose.live.turn.yaml").read_text(encoding="utf-8"))["livekit"]
        self.assertEqual(turn["cap_add"], "[NET_BIND_SERVICE]")


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



def launcher_function(name: str) -> str:
    text = (ROOT / "flux").read_text(encoding="utf-8")
    start = text.index(f"\n{name}() {{") + 1
    line = text[start:text.index("\n", start)]
    return line if line.endswith("}") else text[start:text.index("\n}\n", start) + 3]


class OcrWorkerMemoryTest(unittest.TestCase):
    """C-70 security review P3: an OCR child may hold 384 MiB beside the worker, so with FLUX_FILE_OCR=on `./flux` gives the worker 1 GiB."""

    def worker_memory(self, ocr: str, memory: str | None) -> str:
        functions = "\n".join(launcher_function(name) for name in ("env_file_value", "env_value", "ocr_worker_memory"))
        env = {"PATH": "/usr/bin:/bin", "FLUX_FILE_OCR": ocr, "ENV_FILE": "/nonexistent"}
        if memory is not None:
            env["FLUX_WORKER_MEMORY"] = memory
        script = f"set -eu\n{functions}\nocr_worker_memory\nprintf '%s' \"${{FLUX_WORKER_MEMORY-}}\"\n"
        return subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True, check=True).stdout

    def test_ocr_on_raises_a_smaller_worker_to_1g_and_keeps_a_larger_one(self) -> None:
        for memory, expected in ((None, "1g"), ("", "1g"), ("512m", "1g"), ("768MB", "1g"), ("1023m", "1g"), ("1024m", "1024m"), ("1g", "1g"),
                                 ("2G", "2G"), ("1536m", "1536m"), ("1.5g", "1.5g")):
            with self.subTest(memory=memory):
                self.assertEqual(self.worker_memory("on", memory), expected)

    def test_ocr_off_leaves_the_worker_as_set(self) -> None:
        for memory, expected in ((None, ""), ("512m", "512m")):
            with self.subTest(memory=memory):
                self.assertEqual(self.worker_memory("off", memory), expected)

    def notice(self, ocr: str, memory: str | None) -> str:
        functions = "\n".join(launcher_function(name) for name in ("say", "env_file_value", "env_value", "ocr_worker_memory", "say_ocr_worker_memory"))
        env = {"PATH": "/usr/bin:/bin", "FLUX_FILE_OCR": ocr, "ENV_FILE": "/nonexistent"}
        if memory is not None:
            env["FLUX_WORKER_MEMORY"] = memory
        # compose_main has already raised it in this shell before up or upgrade print the line: the line still names the operator's value.
        script = f"set -eu\n{functions}\nocr_worker_memory\nsay_ocr_worker_memory\n"
        return subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True, check=True).stdout

    def test_up_and_upgrade_say_in_one_line_when_they_raise_it(self) -> None:
        self.assertEqual(self.notice("on", "512m"),
                         "OCR is on: the worker gets 1g of memory instead of FLUX_WORKER_MEMORY=512m (its reader may hold 384 MiB).\n")
        self.assertIn("FLUX_WORKER_MEMORY=512m", self.notice("on", None))
        for ocr, memory in (("on", "2g"), ("off", "512m")):
            with self.subTest(ocr=ocr, memory=memory):
                self.assertEqual(self.notice(ocr, memory), "")
        text = (ROOT / "flux").read_text(encoding="utf-8")
        for function in ("start_main", "upgrade_apply"):
            body = text[text.index(f"\n{function}() {{"):]
            self.assertIn("  say_ocr_worker_memory\n", body[:body.index("\n}\n")], function)

    def test_every_compose_command_of_the_launcher_applies_it(self) -> None:
        for function in ("compose_main", "compose_dev"):
            self.assertIn("ocr_worker_memory\n", launcher_function(function), function)
        self.assertRegex((DOCKER / "compose.test.yaml").read_text(encoding="utf-8"), r'FLUX_FILE_OCR: "on"[\s\S]*?mem_limit: 1g\n    memswap_limit: 1g')


if __name__ == "__main__":
    unittest.main()
