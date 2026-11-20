"""Native code in the images is never made beneath a directory of the build context (docker/Dockerfile, stage `native`).

On a host with SELinux, `COPY . .` carries the checkout's labels into the image (a checkout in a home directory: user_home_t), and a file
created beneath such a directory inherits that label. A container (container_t) may read and map such a file, but SELinux refuses to
`mprotect` it, so musl's loader cannot make an addon's relocations read-only: `Error relocating …/sandbox.node: RELRO protection failed`,
the worker's file reader fails closed and no file is read (seen on a Fedora host, 2026-11-17 and 2026-11-20). BuildKit's cache key leaves
labels out, so one build from such a checkout handed the label to later builds of the same code from correctly labelled checkouts too.

So: a compiler runs only in stages that never copy the build context, writing beneath /native; an addon assembled in a stage that did
copy it (node-pty's pty.node) is copied into a directory made outside /app and moved into place whole (a rename keeps the label); and the
worker's sandbox.node reaches the workspace by `COPY --from=native`. Standard library only.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "docker" / "Dockerfile"

FROM = re.compile(r"^FROM\s+(?P<base>\S+)(?:\s+AS\s+(?P<name>\S+))?\s*$", re.I)
CONTEXT_COPY = re.compile(r"^COPY\s+(?:--\S+\s+)*\.\s+\S+\s*$")
COMPILER = re.compile(r"(?:^|[\s;&|(])(?:cc|gcc|g\+\+|c\+\+|clang|clang\+\+)\s")
OUTPUT = re.compile(r"\s-o\s+(?P<out>\S+)")
NODE_COPY = re.compile(r"\bcp\s+(?:-\S+\s+)*\"?(?P<src>[^\s\"]+\.node)\"?\s+\"?(?P<dest>[^\s\";]+)\"?")
ASSIGN = re.compile(r"(?:^|[\s;])(?P<var>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>[^\s;]+)")


def instructions(text: str) -> list[str]:
    """The Dockerfile's instructions, continuation lines joined and comments dropped."""
    out: list[str] = []
    current = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not current and (not stripped or stripped.startswith("#")):
            continue
        if current and stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            current += stripped[:-1] + " "
            continue
        out.append(current + stripped)
        current = ""
    if current:
        out.append(current)
    return out


def stages(text: str) -> list[tuple[str, str, list[str]]]:
    """(name, base, instructions) of each stage, in order."""
    found: list[tuple[str, str, list[str]]] = []
    for instruction in instructions(text):
        match = FROM.match(instruction)
        if match:
            found.append((match["name"] or f"#{len(found)}", match["base"], []))
        elif found:
            found[-1][2].append(instruction)
    return found


def context_stages(found: list[tuple[str, str, list[str]]]) -> dict[str, int]:
    """The stages that hold the build context (`COPY . <dest>` there or in a stage they are built on): name -> index of the first
    instruction after which the context is there (0 for a stage built on one)."""
    held: dict[str, int] = {}
    for name, base, body in found:
        if base in held:
            held[name] = 0
            continue
        for index, instruction in enumerate(body):
            if CONTEXT_COPY.match(instruction):
                held[name] = index
                break
    return held


def resolve(path: str, run: str) -> str:
    """`$n/x` or `"${n}/x"` with `n=/abs` assigned in the same RUN."""
    values = {m["var"]: m["value"].strip("\"'") for m in ASSIGN.finditer(run)}
    return re.sub(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", lambda m: values.get(m[1], m[0]), path.strip("\"'"))


class NativeAddonLabels(unittest.TestCase):
    def setUp(self) -> None:
        self.found = stages(DOCKERFILE.read_text(encoding="utf-8"))
        self.held = context_stages(self.found)

    def test_the_parser_sees_the_stages(self) -> None:
        names = [name for name, _, _ in self.found]
        for stage in ("native", "toolchain", "build", "production-dependencies", "runtime", "agent-runtime-base"):
            self.assertIn(stage, names)
        for stage in ("build", "verify", "test", "production-dependencies"):
            self.assertIn(stage, self.held, f"{stage} holds the build context")
        self.assertNotIn("native", self.held)

    def test_compilers_run_only_where_the_build_context_is_not(self) -> None:
        compiled = 0
        for name, _, body in self.found:
            for index, instruction in enumerate(body):
                if not instruction.startswith("RUN ") or not COMPILER.search(instruction):
                    continue
                compiled += 1
                self.assertFalse(name in self.held and index >= self.held[name],
                                 f"stage {name} compiles beneath the build context: {instruction[:160]}")
                for match in OUTPUT.finditer(instruction):
                    self.assertTrue(match["out"].startswith("/native/"), f"stage {name} writes {match['out']} outside /native")
        self.assertGreaterEqual(compiled, 3, "protect.node, flux-sandbox and the worker's sandbox.node are compiled")

    def test_the_worker_sandbox_comes_from_native(self) -> None:
        build = next(body for name, _, body in self.found if name == "build")
        self.assertIn("COPY --from=native /native/worker/sandbox.node apps/worker/native/sandbox.node", build)
        self.assertFalse(any("sandbox.c" in instruction and instruction.startswith("RUN ") for instruction in build))

    def test_an_addon_copied_where_the_context_is_lands_in_a_directory_made_outside_it(self) -> None:
        copies = 0
        for name, _, body in self.found:
            for index, instruction in enumerate(body):
                if name not in self.held or index < self.held[name] or not instruction.startswith("RUN "):
                    continue
                for match in NODE_COPY.finditer(instruction):
                    copies += 1
                    dest = resolve(match["dest"], instruction)
                    self.assertTrue(dest.startswith("/") and not dest.startswith("/app"),
                                    f"stage {name} copies {match['src']} to {dest}, beneath the build context")
                    root = "/" + dest.strip("/").split("/")[0]
                    self.assertRegex(instruction, rf"\bmv\s+\"?(?:{re.escape(root)}|\$\{{?\w+\}}?)\"?\s",
                                     f"stage {name} moves {root} into place whole")
        self.assertGreaterEqual(copies, 1, "node-pty's pty.node is copied")


if __name__ == "__main__":
    unittest.main()
