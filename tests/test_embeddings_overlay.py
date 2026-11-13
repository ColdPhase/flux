"""The optional local embeddings overlay (F-042, #1294) must stay optional, pinned and internal.

Standard library only. The overlay adds one third-party container, pinned by digest, and points `api` and `worker` at it; no base
Compose file sets the variable, so a stack without the overlay runs no container and no embeddings.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "docker" / "compose.embeddings.yaml"
BASE_FILES = ("compose.yaml", "compose.source.yaml", "compose.dev.yaml", "compose.runtime.yaml", "compose.source.runtime.yaml")
PINNED = re.compile(r"[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}\Z")


def code(path: Path) -> str:
    """The file without its comment lines."""
    return "\n".join(line for line in path.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#"))


class EmbeddingsOverlay(unittest.TestCase):
    def test_one_image_pinned_by_digest_never_built_or_latest(self) -> None:
        text = code(OVERLAY)
        images = re.findall(r"^\s+image:\s*(\S+)\s*$", text, re.MULTILINE)
        self.assertEqual(len(images), 1, images)
        self.assertRegex(images[0], PINNED)
        self.assertNotIn("latest", images[0])
        self.assertIn("text-embeddings-inference", images[0])
        self.assertNotRegex(text, r"^\s+build\s*:", "pull-only")

    def test_internal_only_bounded_and_without_capabilities(self) -> None:
        text = code(OVERLAY)
        self.assertNotRegex(text, r"^\s+ports\s*:", "no port is published")
        self.assertNotIn("docker.sock", text)
        self.assertRegex(text, r"mem_limit:\s*\$\{FLUX_EMBEDDINGS_MEMORY:-6g\}")
        self.assertRegex(text, r"memswap_limit:\s*\$\{FLUX_EMBEDDINGS_MEMORY:-6g\}")
        # One CPU by default: on a 2-core server a backfill leaves the other core to Flux (audit of #1270).
        self.assertRegex(text, r"cpus:\s*\$\{FLUX_EMBEDDINGS_CPUS:-1\}")
        self.assertRegex(text, r"cap_drop:\s*\[ALL\]")
        self.assertIn("BAAI/bge-m3", text)
        # The server listens on the port the URL names, not the privileged port 80.
        self.assertIn('"--port", "8080"', text)
        # One tokenization worker per CPU is the default; on a big host that alone passes the memory limit.
        self.assertIn('"--tokenization-workers", "2"', text)
        self.assertEqual(re.findall(r"FLUX_EMBEDDINGS_URL:\s*(\S+)", text), ["http://embeddings:8080"] * 2)

    def test_api_and_worker_get_the_address_and_nothing_else_is_added(self) -> None:
        text = code(OVERLAY)
        services = re.findall(r"^  ([a-z][a-z0-9-]*):\s*$", text, re.MULTILINE)
        self.assertEqual(services, ["embeddings", "api", "worker"])

    def test_off_by_default_no_base_file_sets_the_address_or_starts_the_container(self) -> None:
        for name in BASE_FILES:
            text = code(ROOT / "docker" / name)
            self.assertNotIn("FLUX_EMBEDDINGS_URL", text, name)
            self.assertNotIn("text-embeddings-inference", text, name)
        env = (ROOT / "docker" / ".env.example").read_text(encoding="utf-8")
        self.assertRegex(env, r"(?m)^FLUX_EMBEDDINGS=off$")

    def test_the_launcher_layers_the_overlay_only_on_request(self) -> None:
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        self.assertIn("embeddings_on() { [ \"$(env_value FLUX_EMBEDDINGS)\" = on ]; }", launcher)
        self.assertIn('if embeddings_on; then set -- -f "$COMPOSE_EMBEDDINGS" "$@"; fi', launcher)

    def test_turning_it_off_removes_the_running_container(self) -> None:
        # Without the overlay Compose no longer knows the service, so `up` alone would leave it running as an orphan.
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        start = launcher[launcher.index("start_main() {"):]
        self.assertIn("  remove_embeddings_when_off\n}", start[:start.index("\n}\n") + 3])
        self.assertIn('--filter "label=com.docker.compose.service=embeddings"', launcher)
        # clean and reset know the overlay whatever the switch says, so the model volume goes with the rest.
        self.assertEqual(launcher.count("compose_main_all --profile dev --profile test --profile ui --profile runtime down -v --remove-orphans"), 2)
        self.assertIn('embeddings_on || set -- -f "$COMPOSE_EMBEDDINGS" "$@"', launcher)


if __name__ == "__main__":
    unittest.main()
