"""old_tree_apk_pins.py (the upgrade matrix's source-checkout leg): which apk pins of an old tree it finds, on which Alpine image each stage
is built, and that a rewrite touches only the exact pins it names. Docker is not needed: the index queries are not exercised here."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from old_tree_apk_pins import Pin, pins, rewrite  # noqa: E402

NODE = "node@sha256:" + "a" * 64
DOCKERFILE = f"""# syntax=docker/dockerfile:1.7
ARG TARGETARCH
FROM {NODE} AS files
RUN apk add --no-cache gcc musl-dev
FROM scratch AS slim
COPY --from=files / /
FROM slim AS base
# a comment
RUN apk add --no-cache bash=5.3.9-r1 python3=3.14.10-r1 \\
    # a comment inside the instruction
    jq=1.8.2-r0 \\
  && apk add --no-cache --virtual .flux-pip py3-pip=26.1.2-r0 \\
  && printf 'python-docx==1.2.0 --hash=sha256:00\\n' > /tmp/x.txt \\
  && echo FOO=1.0-r1
FROM postgres:18@sha256:{"b" * 64} AS db
RUN apt-get install -y "postgresql-18-pgvector=0.8.7-1.pgdg13+1"
FROM base AS runtime
RUN apk add --no-cache gnupg=2.4.9-r0
"""


class PinsTest(unittest.TestCase):
    def test_every_exact_apk_pin_is_found_with_the_image_its_stage_is_built_on(self) -> None:
        found = pins(DOCKERFILE, "amd64")
        self.assertEqual(found, [
            Pin(NODE, "bash", "5.3.9-r1"), Pin(NODE, "python3", "3.14.10-r1"), Pin(NODE, "jq", "1.8.2-r0"),
            Pin(NODE, "py3-pip", "26.1.2-r0"), Pin(NODE, "gnupg", "2.4.9-r0")])

    def test_pins_outside_apk_add_are_not_pins(self) -> None:
        names = {pin.name for pin in pins(DOCKERFILE, "amd64")}
        self.assertNotIn("python-docx", names)
        self.assertNotIn("FOO", names)
        self.assertNotIn("postgresql-18-pgvector", names)

    def test_a_stage_named_by_an_arg_resolves_through_it(self) -> None:
        text = f"FROM {NODE} AS codex-amd64\nFROM codex-${{TARGETARCH}} AS codex\nRUN apk add ripgrep=15.1.0-r0\n"
        self.assertEqual(pins(text, "amd64"), [Pin(NODE, "ripgrep", "15.1.0-r0")])

    def test_the_rewrite_changes_only_the_named_pins(self) -> None:
        text = "RUN apk add py3-pip=26.1.2-r0 py3-pip-extra=26.1.2-r0 jq=1.8.2-r0 \\\n  && echo py3-pip=26.1.2-r0x\n"
        self.assertEqual(rewrite(text, {("py3-pip", "26.1.2-r0"): "26.1.2-r1"}),
                         "RUN apk add py3-pip=26.1.2-r1 py3-pip-extra=26.1.2-r0 jq=1.8.2-r0 \\\n  && echo py3-pip=26.1.2-r0x\n")

    def test_the_runtime_toolbox_pins_of_this_tree_are_found(self) -> None:
        dockerfile = ROOT / "docker" / "Dockerfile"
        found = {(pin.name, pin.version) for pin in pins(dockerfile.read_text(encoding="utf-8"), "amd64")}
        self.assertIn("py3-pip", {name for name, _ in found}, "the runtime toolbox's pins are no longer found in docker/Dockerfile")


if __name__ == "__main__":
    unittest.main()
