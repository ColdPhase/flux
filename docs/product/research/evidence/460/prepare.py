#!/usr/bin/env python3
"""Materialize exactly the historical server pin in an owned disposable directory."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

PIN = "975747426a778cc4471bd4c9eabb8910eb187671"
repository, stage, evidence, mode = map(Path, sys.argv[1:])
# The repository may be on another branch: git archive reads only this explicit object.
actual = subprocess.check_output(["git", "-C", str(repository), "rev-parse", PIN + "^{commit}"], text=True).strip()
if actual != PIN:
    raise SystemExit("Exact historical source object is unavailable")
source = stage / "source"
source.mkdir()
archive = stage / "source.tar"
with archive.open("wb") as stream:
    subprocess.run(["git", "-C", str(repository), "archive", PIN], stdout=stream, check=True)
subprocess.run(["tar", "-xf", str(archive), "-C", str(source)], check=True)
archive.unlink()
if str(mode) == "prototype":
    record = json.loads((evidence / "prototype-patch.json").read_text())
    patch = record["patch"].encode("utf-8")
    if record["encoding"] != "JSON string; decode patch to UTF-8 unchanged before applying" or hashlib.sha256(patch).hexdigest() != record["sha256"]:
        raise SystemExit("Archived patch hash/encoding mismatch")
    patch_source = stage / "patch-source"
    paths = ["app/apps/server/src/agent-connection/mcp-route.ts", "app/apps/server/src/agent-connection/mcp-tools.ts"]
    for relative in paths:
        destination = patch_source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, destination)
    subprocess.run(["git", "apply", "--check", "-"], input=patch, cwd=patch_source, check=True)
    subprocess.run(["git", "apply", "-"], input=patch, cwd=patch_source, check=True)
    context = stage / "research-patch"
    context.mkdir()
    for relative in paths:
        shutil.copy2(patch_source / relative, context / Path(relative).name)
