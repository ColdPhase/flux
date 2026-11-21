#!/usr/bin/env python3
"""The exact Alpine package pins of an OLD release's tree that Alpine no longer serves, moved to the version it serves now.

The upgrade matrix's source-checkout leg (scripts/check_upgrade_matrix.sh, step b) starts a published release from its own tree with
`./flux up`, which builds that tree's images. An owner who installed that checkout back then built them while the pins existed, and
`./flux upgrade` builds only the new tree; a fresh host has no such images and no BuildKit cache holding them (`./flux up` always runs
`docker compose build`, so images loaded under its tags would be rebuilt, and no release exported a build cache). Alpine keeps one
revision of each package per branch, so an old `apk add name=version-rN` stops resolving once Alpine rebuilds or updates that package
(v0.2.1's `py3-pip=26.1.2-r0`, replaced by -r1 on 2026-11-21, #1626).

One rule: every `name=version` pin in an `apk add` of the tree's Dockerfiles is checked against the APKINDEX of the Alpine image its stage
is built on; a pin that index no longer has is rewritten in the tree to the version the index has now, and each rewrite is printed on a line
of its own. A pinned package the index does not have at all fails. Nothing else in the tree changes.

    old_tree_apk_pins.py <tree>         rewrites in place; prints every change, or that none was needed; exit 1 on a package that is gone
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# name=version-rN: Alpine's exact pin (pip's `name==version` and `name~version` are not matched).
PIN = re.compile(r"(?<![\w.+=~<>-])([a-z0-9][a-z0-9_.+-]*)=(\d[\w.+~]*-r\d+)(?=$|[\s;&|)\\])")
FROM = re.compile(r"^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$", re.IGNORECASE)
COPY_FROM = re.compile(r"^COPY\s+(?:--\S+\s+)*?--from=(\S+)", re.IGNORECASE)
ARG = re.compile(r"^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class Pin:
    image: str  # the external image the stage is built on
    name: str
    version: str


def instructions(text: str) -> list[str]:
    """Dockerfile instructions with their continuation lines joined (comment lines inside one are skipped, as Docker does)."""
    joined: list[str] = []
    current = ""
    for line in text.splitlines():
        stripped = line.strip()
        if current and stripped.startswith("#"):
            continue
        if not current and (not stripped or stripped.startswith("#")):
            continue
        if stripped.endswith("\\"):
            current += stripped[:-1] + " "
            continue
        joined.append(current + stripped)
        current = ""
    if current:
        joined.append(current)
    return joined


def substitute(value: str, args: dict[str, str]) -> str:
    return re.sub(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", lambda m: args.get(m.group(1), m.group(0)), value)


def pins(text: str, arch: str) -> list[Pin]:
    """Every exact apk pin of the Dockerfile `text`, with the external image its stage resolves to (through stage names, and through a
    `FROM scratch` stage's first `COPY --from=`)."""
    args = {"TARGETARCH": arch}
    roots: dict[str, str | None] = {}
    stage_root: str | None = None
    scratch_pending = False
    current_name: str | None = None
    found: list[Pin] = []
    for instruction in instructions(text):
        if m := ARG.match(instruction):
            args.setdefault(m.group(1), m.group(2))
            continue
        if m := FROM.match(instruction):
            image = substitute(m.group(1), args)
            scratch_pending = image == "scratch"
            stage_root = None if scratch_pending else roots.get(image, image)
            if m.group(2):
                roots[m.group(2)] = stage_root
            current_name = m.group(2)
            continue
        if scratch_pending and (m := COPY_FROM.match(instruction)):
            source = substitute(m.group(1), args)
            stage_root = roots.get(source, source)
            scratch_pending = False
            if current_name:
                roots[current_name] = stage_root
            continue
        if instruction.upper().startswith("RUN ") and "apk add" in instruction:
            if stage_root is None:
                raise ValueError(f"an apk pin in a stage whose base image is not known: {instruction[:120]}")
            for segment in instruction.split("apk add")[1:]:
                segment = re.split(r"&&|;|\|\|", segment)[0]
                found += [Pin(stage_root, n, v) for n, v in PIN.findall(segment)]
    return found


def rewrite(text: str, changes: dict[tuple[str, str], str]) -> str:
    """`name=old` becomes `name=new` for each change, only where it is a whole pin."""
    def repl(m: re.Match[str]) -> str:
        new = changes.get((m.group(1), m.group(2)))
        return m.group(0) if new is None else f"{m.group(1)}={new}"
    return PIN.sub(repl, text)


def served(image: str, names: list[str]) -> dict[str, tuple[set[str], str | None]]:
    """For each package: every version the image's Alpine repositories serve now, and the newest (None when there is no such package)."""
    script = 'apk update -q >/dev/null || exit 3; for p in "$@"; do echo "PKG $p"; apk policy "$p" | sed -n "s/^  \\([^ ].*\\):\\$/V \\1/p"; ' \
             'apk search -x "$p" | sed -n "s/^$p-/NEWEST /p"; done'
    result = subprocess.run(["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", script, "sh", *names],
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"could not read the Alpine package index of {image} (exit {result.returncode}): {result.stderr.strip()}")
    out: dict[str, tuple[set[str], str | None]] = {}
    name = ""
    for line in result.stdout.splitlines():
        kind, _, value = line.partition(" ")
        if kind == "PKG":
            name = value
            out[name] = (set(), None)
        elif kind == "V":
            out[name][0].add(value)
        elif kind == "NEWEST":
            out[name] = (out[name][0], value)
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not Path(argv[1], "docker").is_dir():
        print("usage: old_tree_apk_pins.py <tree with docker/>", file=sys.stderr)
        return 2
    tree = Path(argv[1])
    arch = subprocess.run(["docker", "version", "--format", "{{.Server.Arch}}"], capture_output=True, text=True, check=True).stdout.strip()
    files = sorted(p for p in (tree / "docker").rglob("*") if p.is_file() and (p.name == "Dockerfile" or p.name.endswith(".Dockerfile")))
    by_file = {f: pins(f.read_text(encoding="utf-8"), arch) for f in files}
    by_image: dict[str, set[str]] = {}
    for found in by_file.values():
        for pin in found:
            by_image.setdefault(pin.image, set()).add(pin.name)
    index = {image: served(image, sorted(names)) for image, names in sorted(by_image.items())}
    changed = 0
    gone: list[str] = []
    for path, found in by_file.items():
        changes: dict[tuple[str, str], str] = {}
        for pin in found:
            versions, newest = index[pin.image][pin.name]
            if pin.version in versions:
                continue
            if newest is None:
                gone.append(f"{path.relative_to(tree)}: {pin.name}={pin.version} (Alpine has no package {pin.name} any more)")
                continue
            changes[(pin.name, pin.version)] = newest
        if changes:
            path.write_text(rewrite(path.read_text(encoding="utf-8"), changes), encoding="utf-8")
            for (name, old), new in sorted(changes.items()):
                same = old.rsplit("-r", 1)[0] == new.rsplit("-r", 1)[0]
                print(f"OLD TREE EDITED: {path.relative_to(tree)}: {name}={old} -> {name}={new} (Alpine no longer serves {old}; "
                      f"{'a rebuild of the same version' if same else 'a different version'})")
                changed += 1
    if gone:
        print("\n".join(f"old_tree_apk_pins: a pinned package is gone: {line}" for line in gone), file=sys.stderr)
        return 1
    total = sum(len(found) for found in by_file.values())
    print(f"apk pins of the old tree: {total} checked, {changed} no longer served and moved to the current version"
          + ("" if changed else " (the tree is unchanged)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
