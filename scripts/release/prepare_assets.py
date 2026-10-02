#!/usr/bin/env python3
"""Bind the operator templates and evidence to one immutable OCI manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

IMAGE = "ghcr.io/coldphase/flux"
MARKER = f"{IMAGE}@sha256:RELEASE_DIGEST"
VERSION = re.compile(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.[1-9][0-9]*)?\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
# GitHub stores a release asset whose name begins with a period under another name (".env.example"
# becomes "default.env.example"), and upload-artifact skips hidden files. The repository's
# docker/.env.example is therefore published as env.example, and every asset name must survive.
ENV_ASSET = "env.example"
ASSET_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\Z")


def release_header(version: str, source_sha: str) -> str:
    """The repository copy's header explains the marker; the release copy says what it is."""
    return (
        f"# Flux {version} operator Compose, built from source commit {source_sha}.\n"
        "# Runs the published release: no source checkout, no build.\n"
        "#\n"
        "# api, worker and migrate run one image at one revision, pinned by the digest that\n"
        "# release.json records. Use this file with the env.example, INSTALL.md and SHA256SUMS of the\n"
        "# SAME GitHub Release: their image digest, migrations and variables match.\n"
        "#\n"
        "#   cp env.example .env && chmod 600 .env   # then fill in the REQUIRED values, see env.example\n"
        "#   docker compose --env-file .env -f compose.yaml config --quiet\n"
        "#   docker compose --env-file .env -f compose.yaml up -d --wait\n"
        "# Install, upgrade, backup and restore: INSTALL.md.\n"
        "#\n"
        "# PostgreSQL is pinned by digest. Only the API is published, on loopback: put a TLS reverse\n"
        "# proxy in front of it.\n"
    )


def render_compose(template: str, *, version: str, source_sha: str, digest: str) -> str:
    lines = template.splitlines(keepends=True)
    body = next((i for i, line in enumerate(lines) if not line.startswith("#")), len(lines))
    pinned = f"{IMAGE}@{digest}"
    rendered = (release_header(version, source_sha) + "".join(lines[body:])).replace(MARKER, pinned)
    if "RELEASE_DIGEST" in rendered:
        raise ValueError("release digest marker is left in the rendered Compose file")
    if re.findall(r"^\s*image:\s*(\S+)\s*$", rendered, re.MULTILINE).count(pinned) != 3:
        raise ValueError("rendered Compose must pin the release digest on exactly three services")
    return rendered


def prepare(
    *, version: str, source_sha: str, digest: str, compose: Path,
    env: Path, instructions: Path, license_file: Path,
    sbom: Path, destination: Path,
) -> None:
    if not VERSION.fullmatch(version):
        raise ValueError("version must be vX.Y.Z or vX.Y.Z-rc.N")
    if not SHA.fullmatch(source_sha):
        raise ValueError("source SHA must be 40 lowercase hex characters")
    if not DIGEST.fullmatch(digest):
        raise ValueError("image digest must be a sha256 manifest digest")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("destination must be empty to prevent stale assets")

    template = compose.read_text(encoding="utf-8")
    images = re.findall(r"^\s*image:\s*(\S+)\s*$", template, re.MULTILINE)
    service_images: dict[str, str] = {}
    service = ""
    for line in template.splitlines():
        header = re.fullmatch(r"  ([a-z][a-z0-9-]*):\s*", line)
        if header:
            service = header.group(1)
        image = re.fullmatch(r"    image:\s*(\S+)\s*", line)
        if image:
            service_images[service] = image.group(1)
    if images.count(MARKER) != 3 or any(
        service_images.get(name) != MARKER for name in ("api", "worker", "migrate")
    ):
        raise ValueError("operator Compose must use the image marker for api, worker and migrate")
    if re.search(r"^\s*build\s*:", template, re.MULTILINE):
        raise ValueError("operator Compose must be pull-only")
    if any("latest" in image.lower() for image in images):
        raise ValueError("operator Compose cannot use a floating latest image")
    if MARKER in env.read_text(encoding="utf-8"):
        raise ValueError("environment template must not override the image identity")
    rendered = render_compose(template, version=version, source_sha=source_sha, digest=digest)

    spdx = json.loads(sbom.read_text(encoding="utf-8"))
    packages = spdx.get("packages")
    if not isinstance(packages, list) or not packages:
        raise ValueError("SPDX SBOM must contain image packages")
    dependency_notices = [
        {
            "name": package["name"],
            "version": package.get("versionInfo", ""),
            "license_declared": package.get("licenseDeclared", "NOASSERTION"),
            "license_concluded": package.get("licenseConcluded", "NOASSERTION"),
            "copyright": package.get("copyrightText", "NOASSERTION"),
        }
        for package in packages
    ]
    dependency_notices.sort(key=lambda item: (item["name"], item["version"]))

    destination.mkdir(parents=True, exist_ok=True)
    (destination / "compose.yaml").write_text(rendered, encoding="utf-8")
    for source, target in (
        (env, ENV_ASSET),
        (instructions, "INSTALL.md"),
        (license_file, "LICENSE"),
        (sbom, "sbom.spdx.json"),
    ):
        shutil.copyfile(source, destination / target)
    (destination / "THIRD_PARTY_NOTICES.json").write_text(
        json.dumps(dependency_notices, indent=2) + "\n", encoding="utf-8"
    )
    manifest = {
        "version": version,
        "source_sha": source_sha,
        "image": f"{IMAGE}@{digest}",
        "platforms": ["linux/amd64", "linux/arm64"],
    }
    (destination / "release.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    lines = []
    for asset in sorted(destination.iterdir()):
        if not ASSET_NAME.fullmatch(asset.name):
            raise ValueError(f"asset name {asset.name!r} would be renamed by GitHub")
        lines.append(f"{hashlib.sha256(asset.read_bytes()).hexdigest()}  {asset.name}\n")
    (destination / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--compose", type=Path, default=Path("docker/compose.yaml"))
    parser.add_argument("--env", type=Path, default=Path("docker/.env.example"))
    parser.add_argument("--instructions", type=Path, default=Path("docs/operations/release-guide.md"))
    parser.add_argument("--license", type=Path, default=Path("LICENSE"))
    parser.add_argument("--sbom", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    prepare(
        version=args.version, source_sha=args.source_sha, digest=args.digest,
        compose=args.compose, env=args.env, instructions=args.instructions,
        license_file=args.license, sbom=args.sbom,
        destination=args.destination,
    )


if __name__ == "__main__":
    main()
