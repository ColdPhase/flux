#!/usr/bin/env python3
"""Fail unless a release asset directory is complete, checksummed and pinned to ONE pair of image digests.

Used on the freshly prepared assets, on the draft's downloaded assets before publication and on the
public downloads after it. It reads only files: the registry check of the digests is separate
(`docker buildx imagetools inspect`). With --version/--source-sha/--digest it also binds the assets
to the identity the independent reviewer accepted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from prepare_assets import DIGEST, IMAGE, RUNTIME_IMAGE, SHA, VERSION
from check_asset_set import verify as verify_asset_set

EXPECTED = {
    "compose.yaml", "compose.runtime.yaml", "runtime.sh", "env.example", "INSTALL.md", "release.json",
    "sbom.spdx.json", "sbom-agent-runtime.spdx.json", "THIRD_PARTY_NOTICES.json",
    "THIRD_PARTY_NOTICES.agent-runtime.json", "LICENSE", "SHA256SUMS",
}


def images(text: str) -> list[str]:
    return re.findall(r"^\s*image:\s*(\S+)\s*$", text, re.MULTILINE)


def verify(directory: Path, version: str | None, source_sha: str | None, digest: str | None) -> dict[str, str]:
    verify_asset_set(directory)
    names = {path.name for path in directory.iterdir()}
    if names != EXPECTED:
        raise ValueError(f"release assets must be exactly {sorted(EXPECTED)}; found {sorted(names ^ EXPECTED)} differing")
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        checksum, _, name = line.partition("  ")
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != checksum:
            raise ValueError(f"{name} does not match SHA256SUMS")
    release = json.loads((directory / "release.json").read_text(encoding="utf-8"))
    if not VERSION.fullmatch(release["version"]) or not SHA.fullmatch(release["source_sha"]):
        raise ValueError("release.json carries an invalid version or source SHA")
    app = release["image"]
    runtime = release["runtime_image"]
    if not app.startswith(IMAGE + "@") or not DIGEST.fullmatch(app.split("@", 1)[1]):
        raise ValueError("release.json image is not a digest of the application image")
    if not runtime.startswith(RUNTIME_IMAGE + "@") or not DIGEST.fullmatch(runtime.split("@", 1)[1]):
        raise ValueError("release.json runtime_image is not a digest of the agent-runtime image")
    if app.split("@", 1)[1] == runtime.split("@", 1)[1]:
        raise ValueError("the application and agent-runtime images must have different digests")
    for key, expected in (("version", version), ("source_sha", source_sha)):
        if expected is not None and release[key] != expected:
            raise ValueError(f"release.json {key} is {release[key]!r}, expected {expected!r}")
    if digest is not None and app != f"{IMAGE}@{digest}":
        raise ValueError("release.json image is not the accepted digest")
    if release["platforms"] != ["linux/amd64", "linux/arm64"] or release["runtime_platforms"] != ["linux/amd64", "linux/arm64"]:
        raise ValueError("release.json must name linux/amd64 and linux/arm64 for both images")

    compose = (directory / "compose.yaml").read_text(encoding="utf-8")
    overlay = (directory / "compose.runtime.yaml").read_text(encoding="utf-8")
    for name, text in (("compose.yaml", compose), ("compose.runtime.yaml", overlay)):
        if re.search(r"RELEASE_DIGEST|RUNTIME_DIGEST|^\s*build\s*:|:latest|docker\.sock", text, re.MULTILINE):
            raise ValueError(f"{name} holds a digest marker, a source build, a floating tag or a socket")
    if images(compose).count(app) != 3:
        raise ValueError("compose.yaml must pin the application image on api, worker and migrate")
    # Slot anchor and runtime-install carry the runtime image; runtime-manager and runtime-egress the application image.
    found = images(overlay)
    if sorted(found) != sorted([app, app, runtime, runtime]):
        raise ValueError(f"compose.runtime.yaml images are {found}; expected the two release images only")
    if "docker.sock" in (directory / "runtime.sh").read_text(encoding="utf-8"):
        raise ValueError("runtime.sh must not use a container engine socket")
    if release["runtime_claude_code"].split(";")[0] != "not included":
        raise ValueError("release.json must state that Claude Code is not included")
    for sbom in ("sbom.spdx.json", "sbom-agent-runtime.spdx.json"):
        if not json.loads((directory / sbom).read_text(encoding="utf-8")).get("packages"):
            raise ValueError(f"{sbom} lists no packages")
    notices = json.loads((directory / "THIRD_PARTY_NOTICES.agent-runtime.json").read_text(encoding="utf-8"))
    if not any(item["name"].lower() in ("codex", "codex-cli") for item in notices):
        raise ValueError("the agent-runtime notices must record the pinned Codex")
    return {"app": app, "runtime": runtime}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--source-sha")
    parser.add_argument("--digest", help="accepted application image digest, sha256:...")
    args = parser.parse_args()
    try:
        result = verify(args.directory, args.version, args.source_sha, args.digest)
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"verify_assets: {error}") from error
    print(json.dumps(result))


if __name__ == "__main__":
    main()
