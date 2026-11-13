#!/usr/bin/env python3
"""Fail unless a release asset directory is complete, checksummed and pinned to ONE set of image digests.

Used on the freshly prepared assets, on the draft's downloaded assets before publication and on the
public downloads after it. It reads only files: the registry check of the digests is separate
(`docker buildx imagetools inspect`). With --version/--source-sha/--digest it also binds the assets
to the identity the independent reviewer accepted. The install folder in flux.tar.gz must name exactly
the images of release.json in its docker/release.env (#1471 decision 5).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path

from prepare_assets import (
    APP_VARIABLE, BUNDLE, BUNDLE_FILES, DATABASE_VARIABLE, DIGEST, PINNED_IMAGE, REGISTRY, RELEASE_ENV, RUNTIME_VARIABLE, SHA, THIRD_PARTY,
    TOP, VERSION, check_release_compose, images, parse_platforms,
)
from check_asset_set import verify as verify_asset_set

EXPECTED = {
    BUNDLE, "release.json", "sbom.spdx.json", "sbom-agent-runtime.spdx.json", "sbom-database.spdx.json", "THIRD_PARTY_NOTICES.json",
    "THIRD_PARTY_NOTICES.agent-runtime.json", "THIRD_PARTY_NOTICES.database.json", "LICENSE", "SHA256SUMS",
}
# Added by the `sign` job after SHA256SUMS exists, so it cannot be listed in it.
SIGNATURE = "SHA256SUMS.sigstore.json"


def bundle_members(path: Path) -> dict[str, bytes]:
    """The install folder's files, by path below `flux/`. Refuses links, absolute paths and anything outside `flux/`."""
    members: dict[str, bytes] = {}
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            name = member.name
            if name.startswith("/") or ".." in Path(name).parts or not (name == TOP or name.startswith(TOP + "/")):
                raise ValueError(f"{BUNDLE} holds {name!r} outside {TOP}/")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"{BUNDLE} holds {name!r}, which is not a regular file")
            data = archive.extractfile(member)
            members[name.removeprefix(TOP + "/")] = data.read() if data else b""
            if name == f"{TOP}/flux" and not member.mode & 0o100:
                raise ValueError(f"{BUNDLE}: the launcher is not executable")
    return members


def release_env_values(text: str) -> dict[str, str]:
    return dict(line.split("=", 1) for line in text.splitlines() if line and not line.startswith("#") and "=" in line)


def verify(
    directory: Path, version: str | None, source_sha: str | None, digest: str | None, platforms: str | None = None,
    registry: str = REGISTRY,
) -> dict[str, str]:
    verify_asset_set(directory)
    names = {path.name for path in directory.iterdir()} - {SIGNATURE}
    if names != EXPECTED:
        raise ValueError(f"release assets must be exactly {sorted(EXPECTED)}; found {sorted(names ^ EXPECTED)} differing")
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        checksum, _, name = line.partition("  ")
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != checksum:
            raise ValueError(f"{name} does not match SHA256SUMS")
    release = json.loads((directory / "release.json").read_text(encoding="utf-8"))
    if not VERSION.fullmatch(release["version"]) or not SHA.fullmatch(release["source_sha"]):
        raise ValueError("release.json carries an invalid version or source SHA")
    app, runtime, database = release["image"], release["runtime_image"], release["database_image"]
    for key, value, repository in (("image", app, "flux"), ("runtime_image", runtime, "flux-agent-runtime"),
                                   ("database_image", database, "flux-database")):
        if not value.startswith(f"{registry}/{repository}@") or not DIGEST.fullmatch(value.split("@", 1)[1]):
            raise ValueError(f"release.json {key} is not a digest of {registry}/{repository}")
    if len({app.split("@")[1], runtime.split("@")[1], database.split("@")[1]}) != 3:
        raise ValueError("the application, agent-runtime and database images must have different digests")
    for key, expected in (("version", version), ("source_sha", source_sha)):
        if expected is not None and release[key] != expected:
            raise ValueError(f"release.json {key} is {release[key]!r}, expected {expected!r}")
    if digest is not None and app != f"{registry}/flux@{digest}":
        raise ValueError("release.json image is not the accepted digest")
    named = release["platforms"]
    if (not isinstance(named, list) or named != parse_platforms(",".join(named)) or release["runtime_platforms"] != named
            or release["database_platforms"] != named):
        raise ValueError("release.json must name the same supported platforms, in canonical order, for every image")
    if platforms is not None and named != parse_platforms(platforms):
        raise ValueError(f"release.json platforms are {named}, expected {platforms}")
    if release.get("bundle") != BUNDLE or release.get("bundle_sha256") != hashlib.sha256((directory / BUNDLE).read_bytes()).hexdigest():
        raise ValueError(f"release.json does not name {BUNDLE} with its checksum")

    members = bundle_members(directory / BUNDLE)
    wanted = set(BUNDLE_FILES.values()) | {RELEASE_ENV}
    if set(members) != wanted:
        raise ValueError(f"{BUNDLE} must hold exactly {sorted(wanted)}; found {sorted(set(members) ^ wanted)} differing")
    check_release_compose(members["docker/compose.yaml"].decode(), members["docker/compose.runtime.yaml"].decode())
    values = release_env_values(members[RELEASE_ENV].decode())
    expected_env = {"FLUX_RELEASE_VERSION": release["version"], "FLUX_RELEASE_COMMIT": release["source_sha"],
                    "FLUX_RELEASE_SCHEMA": str(release["schema"]), APP_VARIABLE: app, DATABASE_VARIABLE: database, RUNTIME_VARIABLE: runtime}
    if values != expected_env:
        raise ValueError(f"{RELEASE_ENV} does not name exactly release.json's version, commit, schema and images")
    for name, key in (("docker/compose.https.yaml", "https_image"), ("docker/compose.live.yaml", "live_media_image"),
                      ("docker/compose.embeddings.yaml", "embeddings_image")):
        found = images(members[name].decode())
        if len(found) != THIRD_PARTY[name] or found[0] != release.get(key) or not PINNED_IMAGE.fullmatch(found[0]):
            raise ValueError(f"{name} must pin release.json's {key}")
    if re.search(r"^FLUX_FIXTURE_TOKEN=.", members["docker/.env.example"].decode(), re.MULTILINE):
        raise ValueError("docker/.env.example must leave the fixture token empty")
    if release["runtime_claude_code"].split(";")[0] != "not included":
        raise ValueError("release.json must state that Claude Code is not included")
    for sbom in ("sbom.spdx.json", "sbom-agent-runtime.spdx.json", "sbom-database.spdx.json"):
        if not json.loads((directory / sbom).read_text(encoding="utf-8")).get("packages"):
            raise ValueError(f"{sbom} lists no packages")
    notices = json.loads((directory / "THIRD_PARTY_NOTICES.agent-runtime.json").read_text(encoding="utf-8"))
    if not any(item["name"].lower() in ("codex", "codex-cli") for item in notices):
        raise ValueError("the agent-runtime notices must record the pinned Codex")
    return {"app": app, "runtime": runtime, "database": database, "bundle_sha256": release["bundle_sha256"],
            "https": release["https_image"], "live_media": release["live_media_image"], "embeddings": release["embeddings_image"],
            "platforms": ",".join(named)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--source-sha")
    parser.add_argument("--digest", help="accepted application image digest, sha256:...")
    parser.add_argument("--platforms", help="the platforms the images were built for, for example linux/amd64")
    parser.add_argument("--registry", default=REGISTRY)
    args = parser.parse_args()
    try:
        result = verify(args.directory, args.version, args.source_sha, args.digest, args.platforms, args.registry)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        raise SystemExit(f"verify_assets: {error}") from error
    print(json.dumps(result))


if __name__ == "__main__":
    main()
