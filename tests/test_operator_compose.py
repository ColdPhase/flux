"""The operator Compose example (#76) must stay pull-only and bound to one release image.

Standard library only (no YAML parser), so it runs in the repository check. The file is
read by its line structure, the same way the release packaging (#77) reads it: two-space
service headers under `services:` and four-space keys inside each service.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker" / "compose.yaml"
ENV_EXAMPLE = ROOT / "docker" / ".env.example"
SOURCE_ENV_EXAMPLE = ROOT / "app" / ".env.example"
MARKER = "ghcr.io/coldphase/flux@sha256:RELEASE_DIGEST"
FLUX_SERVICES = ("migrate", "api", "worker")
PINNED = re.compile(r"[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}\Z")
# ${VAR}, ${VAR:-default}, ${VAR:?message}; `$${VAR}` is a literal for the container shell.
REFERENCE = re.compile(r"(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}")
SECRET_NAME = re.compile(r"(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)\Z")
RANDOM_LOOKING = re.compile(r"[A-Za-z0-9+/_=-]{24,}")


def services(text: str) -> dict[str, list[str]]:
    blocks: dict[str, list[str]] = {}
    current = None
    inside = False
    for line in text.splitlines():
        if re.fullmatch(r"[a-z][a-z0-9_-]*:.*", line):
            inside = line.startswith("services:")
            current = None
            continue
        header = re.fullmatch(r"  ([a-z][a-z0-9-]*):\s*", line)
        if inside and header:
            current = header.group(1)
            blocks[current] = []
        elif inside and current and (line.startswith("    ") or not line.strip()):
            blocks[current].append(line)
    return blocks


def image_of(block: list[str]) -> str | None:
    for line in block:
        match = re.fullmatch(r"    image:\s*(\S+)\s*", line)
        if match:
            return match.group(1)
    return None


def env_entries(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, sep, value = line.partition("=")
            assert sep, f"{path.name}: not KEY=value: {line!r}"
            entries[key] = value
    return entries


class OperatorComposeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.text = COMPOSE.read_text(encoding="utf-8")
        self.body = "\n".join(
            line for line in self.text.splitlines() if not line.lstrip().startswith("#")
        )
        self.services = services(self.text)
        self.env = env_entries(ENV_EXAMPLE)

    def test_pull_only(self) -> None:
        self.assertNotRegex(self.body, r"(?m)^\s*build\s*:", "operator Compose must never build")
        self.assertNotIn("latest", self.body.lower())

    def test_flux_services_share_exactly_the_release_marker(self) -> None:
        for name in FLUX_SERVICES:
            self.assertIn(name, self.services)
            self.assertEqual(image_of(self.services[name]), MARKER, name)
        images = re.findall(r"(?m)^\s*image:\s*(\S+)\s*$", self.body)
        # The release step (#77) substitutes the digest and expects exactly these three.
        self.assertEqual(images.count(MARKER), len(FLUX_SERVICES))
        self.assertEqual(self.body.count("RELEASE_DIGEST"), len(FLUX_SERVICES))

    def test_every_other_image_is_pinned_by_digest(self) -> None:
        for name, block in self.services.items():
            image = image_of(block)
            self.assertIsNotNone(image, f"{name} has no image")
            if name not in FLUX_SERVICES:
                self.assertNotIn("coldphase/flux", image, name)
                self.assertRegex(image, PINNED, f"{name} image must be pinned by digest")

    def test_migration_runs_before_api_and_worker(self) -> None:
        migrate = "\n".join(self.services["migrate"])
        self.assertRegex(migrate, r"db:\n\s+condition: service_healthy")
        self.assertIn('restart: "no"', migrate)
        for name in ("api", "worker"):
            block = "\n".join(self.services[name])
            self.assertRegex(block, r"migrate:\n\s+condition: service_completed_successfully", name)
            self.assertIn("files:/data/files:z", block, name)
        self.assertIn("healthcheck:", "\n".join(self.services["api"]))
        self.assertIn("healthcheck:", "\n".join(self.services["db"]))

    def test_only_the_api_is_published_on_loopback(self) -> None:
        for name, block in self.services.items():
            joined = "\n".join(block)
            self.assertNotIn("network_mode: host", joined, name)
            if name == "api":
                self.assertRegex(joined, r"    ports:\n      - 127\.0\.0\.1:\$\{FLUX_PORT:-8081\}:8080\n    \S")
            else:
                self.assertNotIn("ports:", joined, name)

    def test_test_only_switches_are_not_exposed(self) -> None:
        self.assertNotIn("FLUX_TEST_FAILURE_INJECTION", self.text)
        self.assertNotIn("FLUX_PUSH_ALLOW_PRIVATE_NETWORK", self.text)
        self.assertNotIn("profiles:", self.body)

    def test_every_variable_is_in_the_env_example(self) -> None:
        referenced = {match.group(1) for match in REFERENCE.finditer(self.body)}
        self.assertEqual(sorted(referenced - set(self.env)), [], "missing from docker/.env.example")
        # One executable template also serves the source launcher/dev profile.
        source_only = {"FLUX_MAILPIT_PORT", "FLUX_DEV_PORT", "FLUX_DEMO_OWNER_PASSWORD", "FLUX_DEMO_PARTNER_PASSWORD",
                       "FLUX_BACKGROUND_KEY_HOST_FILE", "FLUX_OIDC_CLIENT_SECRET_HOST_FILE"}
        self.assertEqual(set(self.env) - referenced, source_only, "unexpected unconsumed template variable")
        consumers = (ROOT / "docker/compose.source.yaml").read_text() + (ROOT / "docker/compose.dev.yaml").read_text() + (ROOT / "flux").read_text()
        for name in source_only:
            self.assertIn(name, consumers, f"{name} has no source consumer")

    def test_defaults_match_the_env_example(self) -> None:
        for match in REFERENCE.finditer(self.body):
            name, kind, default = match.groups()
            if kind == ":-" and default:
                self.assertEqual(self.env[name], default, f"{name} default differs")

    def test_required_values_are_marked_and_empty_secrets_fail_closed(self) -> None:
        lines = ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
        required = {m.group(1) for m in REFERENCE.finditer(self.body) if m.group(2) == ":?"}
        self.assertEqual(required, {"POSTGRES_PASSWORD", "FLUX_AUTH_SECRET", "FLUX_PUBLIC_ORIGIN"})
        for name in required:
            index = next(i for i, line in enumerate(lines) if line.startswith(f"{name}="))
            comments = []
            for line in reversed(lines[:index]):
                if not line.startswith("#"):
                    break
                comments.append(line)
            self.assertTrue(any("REQUIRED" in line for line in comments), f"{name} not marked REQUIRED")

    def test_env_example_holds_no_secret_or_image(self) -> None:
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        self.assertNotIn("RELEASE_DIGEST", text)
        self.assertNotIn("coldphase/flux", text)
        for name, value in self.env.items():
            if SECRET_NAME.search(name):
                self.assertEqual(value, "", f"{name} must be empty in the example")
            self.assertNotRegex(value, RANDOM_LOOKING, f"{name} looks like a real secret")

    def test_names_and_defaults_match_the_source_env_example(self) -> None:
        source = env_entries(SOURCE_ENV_EXAMPLE)
        self.assertEqual(set(self.env), set(source), "application reference and executable template names differ")
        for name, value in self.env.items():
            if value and source[name] and not SECRET_NAME.search(name):
                self.assertEqual(value, source[name], f"{name} differs from .env.example")

    def test_header_states_the_release_contract(self) -> None:
        header = self.text.split("\nname:", 1)[0]
        self.assertIn("RELEASE_DIGEST", header)
        self.assertRegex(header, r"It is NOT\s+#\s+what `./flux up` runs")
        self.assertIn("./flux up", header)
        self.assertIn("--env-file docker/.env -f docker/compose.yaml", header)
        self.assertIn("docs/operations/install-release.md", header)
        self.assertTrue((ROOT / "docs" / "operations" / "install-release.md").is_file())


if __name__ == "__main__":
    unittest.main()
