"""The release Compose must pass every documented operator setting the source Compose passes (#249, #77).

An operator installs docker/compose.yaml (and, optionally, docker/compose.runtime.yaml), never the
source file. A setting that only the source file passes is documented but cannot be turned on in a
release install: FLUX_PERSONAL_RUNS, which enables the assistant, was one. This compares the
`environment:` keys of api and worker between docker/compose.source.yaml and the release files, and
keeps the test-only switches out of the release files.

Standard library only (no YAML parser), so it runs in the repository check.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("config_reference", ROOT / "scripts" / "config_reference.py")
reference = importlib.util.module_from_spec(SPEC)
sys.modules["config_reference"] = reference
SPEC.loader.exec_module(reference)

SOURCE = ROOT / "docker" / "compose.source.yaml"
# What a release operator runs: compose.yaml, plus the optional agent-runtime overlay that adds the
# runtime settings to api and worker (an asset of every release, see scripts/release/prepare_assets.py).
RELEASE = [ROOT / "docker" / "compose.yaml", ROOT / "docker" / "compose.runtime.yaml"]
APPLICATION_SERVICES = ("api", "worker")
# Settings in these groups are read by the launcher, the dev profile or the checks, not by api and worker.
NOT_APPLICATION_GROUPS = {"launcher"}


def environment_keys(text: str) -> dict[str, set[str]]:
    """Service name -> the keys of its `environment:` mapping (two-space services, six-space keys)."""
    keys: dict[str, set[str]] = {}
    in_services = False
    service = None
    in_environment = False
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if re.fullmatch(r"[A-Za-z][\w.-]*:.*", line):
            in_services = line.startswith("services:")
            service = None
            in_environment = False
            continue
        header = re.fullmatch(r"  ([a-z][a-z0-9-]*):\s*", line)
        if in_services and header:
            service = header.group(1)
            keys.setdefault(service, set())
            in_environment = False
        elif service and re.fullmatch(r"    environment:\s*", line):
            in_environment = True
        elif re.fullmatch(r"    \S.*", line):
            in_environment = False
        elif service and in_environment:
            entry = re.match(r"      ([A-Za-z_][A-Za-z0-9_]*):", line)
            if entry:
                keys[service].add(entry.group(1))
    return keys


def operator_settings() -> set[str]:
    """Documented settings the application reads from its environment."""
    return {name for name, var in reference.VARIABLES.items()
            if not var.override and var.group not in NOT_APPLICATION_GROUPS}


def testing_switches() -> set[str]:
    return {name for name, why in reference.INTERNAL.items()
            if name.startswith("FLUX_TEST_") or re.search(r"\btests?\b", why, re.IGNORECASE)}


def missing_in_release(source: str, release: list[str]) -> dict[str, list[str]]:
    """Per service, the documented operator settings the source passes and the release files do not."""
    wanted = operator_settings()
    source_keys = environment_keys(source)
    release_keys: dict[str, set[str]] = {}
    for text in release:
        for service, names in environment_keys(text).items():
            release_keys.setdefault(service, set()).update(names)
    return {service: sorted((source_keys[service] & wanted) - release_keys.get(service, set()))
            for service in APPLICATION_SERVICES
            if (source_keys[service] & wanted) - release_keys.get(service, set())}


class ReleaseComposeParityTest(unittest.TestCase):
    def test_every_documented_setting_of_api_and_worker_reaches_a_release_install(self) -> None:
        missing = missing_in_release(SOURCE.read_text(encoding="utf-8"),
                                     [path.read_text(encoding="utf-8") for path in RELEASE])
        self.assertEqual(missing, {}, "documented in the configuration reference and passed by "
                                      "docker/compose.source.yaml, but not by docker/compose.yaml or compose.runtime.yaml")

    def test_the_personal_run_settings_are_passed_by_the_release_compose_itself(self) -> None:
        # The overlay is optional; the assistant on the owner's own API key needs none of it.
        keys = environment_keys(RELEASE[0].read_text(encoding="utf-8"))
        for service in APPLICATION_SERVICES:
            for name in ("FLUX_PERSONAL_RUNS", "FLUX_BACKGROUND_COMPARISONS", "FLUX_AI_PRIVATE_TARGETS"):
                self.assertIn(name, keys[service], f"{service} does not receive {name}")

    def test_the_runtime_settings_come_from_the_overlay_that_every_release_ships(self) -> None:
        overlay = environment_keys(RELEASE[1].read_text(encoding="utf-8"))
        for service in APPLICATION_SERVICES:
            for name in ("FLUX_AGENT_RUNTIME", "FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS", "FLUX_AGENT_RUNTIME_IDLE_DAYS",
                         "FLUX_RUNTIME_MANAGER_SECRET"):
                self.assertIn(name, overlay[service], f"compose.runtime.yaml does not pass {name} to {service}")
        assets = (ROOT / "scripts" / "release" / "prepare_assets.py").read_text(encoding="utf-8")
        self.assertIn('"compose.runtime.yaml"', assets)

    def test_no_test_only_switch_is_in_the_release_files(self) -> None:
        names = testing_switches()
        self.assertIn("FLUX_TEST_FAILURE_INJECTION", names)
        self.assertIn("FLUX_KEYRING_REVEAL_BOOT_KEY", names)
        for path in RELEASE:
            for service, keys in environment_keys(path.read_text(encoding="utf-8")).items():
                self.assertEqual(sorted(keys & names), [], f"{path.name}: {service} passes a test-only switch")

    def test_the_comparison_fails_on_a_missing_setting(self) -> None:
        source = ("services:\n  api:\n    environment:\n      FLUX_PERSONAL_RUNS: ${FLUX_PERSONAL_RUNS:-}\n"
                  "      FLUX_TEST_FAILURE_INJECTION: ${FLUX_TEST_FAILURE_INJECTION:-false}\n"
                  "    mem_limit: 1g\n  worker:\n    environment:\n      FLUX_PERSONAL_RUNS: ${FLUX_PERSONAL_RUNS:-}\n")
        release = ("services:\n  api:\n    environment:\n      FLUX_SIGNUP: ${FLUX_SIGNUP:-open}\n"
                   "  worker:\n    environment:\n      FLUX_PERSONAL_RUNS: ${FLUX_PERSONAL_RUNS:-}\n")
        overlay = "services:\n  api:\n    environment:\n      FLUX_PERSONAL_RUNS: ${FLUX_PERSONAL_RUNS:-}\n"
        self.assertEqual(missing_in_release(source, [release]), {"api": ["FLUX_PERSONAL_RUNS"]})
        self.assertEqual(missing_in_release(source, [release, overlay]), {})

    def test_environment_keys_reads_only_the_environment_mapping(self) -> None:
        text = ("services:\n  api:\n    image: x\n    environment:\n      A: 1\n      # B: 2\n      C: ${C:-}\n"
                "    networks: [default]\n    ports:\n      - 127.0.0.1:1:2\n  worker:\n    environment:\n      D: 1\n"
                "volumes:\n  files:\n")
        self.assertEqual(environment_keys(text), {"api": {"A", "C"}, "worker": {"D"}})


if __name__ == "__main__":
    unittest.main()
