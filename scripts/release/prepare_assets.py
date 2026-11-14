#!/usr/bin/env python3
"""Package one Flux release: the owner's flux.tar.gz, bound to one set of image digests, with its evidence.

One install path (#1471, founder decision 5; F-043): every owner installs the `flux` launcher of a release and runs `./flux up`, which
pulls that release's images instead of building them. The release's assets are:

  flux.tar.gz        the install folder `flux/`: the launcher, docker/compose.yaml with its overlays (agent runtime, built-in HTTPS,
                     calls, local embeddings), the Caddyfile, docker/.env.example, docker/env-changes.txt, the demo seed, LICENSE and
                     docker/release.env, the one file that names the version, its source commit, its schema and the three images
                     pinned by digest
  release.json       the same identity, machine-readable, plus the third-party images the overlays pin
  sbom*.spdx.json, THIRD_PARTY_NOTICES*.json, LICENSE
  SHA256SUMS         the checksum of every asset above; the release workflow signs it (SHA256SUMS.sigstore.json, not listed in it)

The archive is reproducible: sorted members, owner root, mode 0755 or 0644, and the time of the source commit (--mtime).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path

REGISTRY = "ghcr.io/coldphase"
VERSION = re.compile(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.[1-9][0-9]*)?\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
ASSET_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\Z")
SUPPORTED_PLATFORMS = ("linux/amd64", "linux/arm64")
DEFAULT_PLATFORMS = "linux/amd64"
# Third-party images (Caddy, the LiveKit SFU, the embedding server) are pinned by digest in the repository files and ship as they are.
PINNED_IMAGE = re.compile(r"[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}\Z")
BUNDLE = "flux.tar.gz"
TOP = "flux"
RELEASE_ENV = "docker/release.env"
# The image variables of the release Compose files, exported by the launcher from docker/release.env.
APP_VARIABLE = "FLUX_RELEASE_IMAGE"
DATABASE_VARIABLE = "FLUX_RELEASE_DATABASE_IMAGE"
RUNTIME_VARIABLE = "FLUX_RELEASE_RUNTIME_IMAGE"
# Repository file -> path in the install folder. Executable files keep 0755.
BUNDLE_FILES = {
    "flux": "flux",
    "LICENSE": "LICENSE",
    "docker/compose.yaml": "docker/compose.yaml",
    "docker/compose.runtime.yaml": "docker/compose.runtime.yaml",
    "docker/compose.https.yaml": "docker/compose.https.yaml",
    "docker/compose.live.yaml": "docker/compose.live.yaml",
    "docker/compose.embeddings.yaml": "docker/compose.embeddings.yaml",
    "docker/caddy/Caddyfile": "docker/caddy/Caddyfile",
    "docker/.env.example": "docker/.env.example",
    "docker/env-changes.txt": "docker/env-changes.txt",
    "docker/background-key-unavailable": "docker/background-key-unavailable",
    "docker/oidc-client-secret-unavailable": "docker/oidc-client-secret-unavailable",
    "scripts/flux-demo.mjs": "scripts/flux-demo.mjs",
}
EXECUTABLE = {"flux"}
# The overlays that run third-party images only, and how many each pins.
THIRD_PARTY = {"docker/compose.https.yaml": 1, "docker/compose.live.yaml": 1, "docker/compose.embeddings.yaml": 1}
MIGRATION = re.compile(r"([0-9]{4})_[a-z0-9_]*\.sql\Z")


def images(text: str) -> list[str]:
    return re.findall(r"^\s*image:\s*(\S.*?)\s*$", text, re.MULTILINE)


def service_images(text: str) -> dict[str, str]:
    """Image per service (or per top-level x-* anchor) of a Compose file."""
    found: dict[str, str] = {}
    section = context = ""
    for line in text.splitlines():
        top = re.match(r"([A-Za-z0-9_.-]+):", line)
        if top:
            section = context = top.group(1)
            continue
        if section == "services":
            header = re.fullmatch(r"  ([a-z][a-z0-9-]*):\s*", line)
            if header:
                context = header.group(1)
        image = re.fullmatch(r"\s+image:\s*(\S.*?)\s*", line)
        if image:
            if context in found:
                raise ValueError(f"{context} names two images")
            found[context] = image.group(1)
    return found


def variable(name: str) -> str:
    return "${" + name + ":?run Flux with ./flux, which names the images}"


def check_release_compose(compose: str, runtime: str) -> None:
    """The owner's Compose files take every Flux image from the launcher's variables, build nothing and mount no engine socket."""
    for name, text in (("compose.yaml", compose), ("compose.runtime.yaml", runtime)):
        if re.search(r"^\s*build\s*:", text, re.MULTILINE):
            raise ValueError(f"{name} must be pull-only")
        if "docker.sock" in text:
            raise ValueError(f"{name} must not mount a container engine socket")
    app, database, runtime_image = variable(APP_VARIABLE), variable(DATABASE_VARIABLE), variable(RUNTIME_VARIABLE)
    expected = {"db": database, "migrate": app, "files-init": app, "files-archive": database, "api": app, "worker": app, "keyring": app}
    if service_images(compose) != expected:
        raise ValueError(f"compose.yaml must run {APP_VARIABLE} on migrate, files-init, api, worker and keyring and {DATABASE_VARIABLE} "
                         "on db and files-archive, and nothing else")
    expected = {"x-runtime-slot": runtime_image, "runtime-install": runtime_image, "runtime-manager": app, "runtime-egress": app}
    if service_images(runtime) != expected:
        raise ValueError(f"compose.runtime.yaml must run {RUNTIME_VARIABLE} on its slot anchor and runtime-install and {APP_VARIABLE} on "
                         "runtime-manager and runtime-egress, and nothing else")


def third_party_images(name: str, text: str, count: int) -> list[str]:
    if re.search(r"^\s*build\s*:", text, re.MULTILINE) or "docker.sock" in text or "coldphase/flux" in text:
        raise ValueError(f"{name} must run third-party images only, with no build and no socket")
    found = images(text)
    if len(found) != count or any(not PINNED_IMAGE.fullmatch(image) or ":latest@" in image for image in found):
        raise ValueError(f"{name} must pin {count} image(s) by digest; it has {found}")
    return found


def parse_platforms(value: str) -> list[str]:
    """A comma-separated subset of SUPPORTED_PLATFORMS, returned in canonical order. final-release.yml requires linux/amd64."""
    found = [item.strip() for item in value.split(",")]
    if any(item not in SUPPORTED_PLATFORMS for item in found) or len(set(found)) != len(found):
        raise ValueError(f"platforms must be a comma-separated subset of {', '.join(SUPPORTED_PLATFORMS)}")
    return [item for item in SUPPORTED_PLATFORMS if item in found]


def codex_pin(dockerfile: str) -> str:
    """The Codex release the runtime image pins: the Dockerfile's one `ARG CODEX_TAG=rust-vX.Y.Z`, which its binaries, host and model
    catalog all download by (#1133); a download that names a tag of its own would let a bump keep an old one."""
    tags = re.findall(r"^ARG CODEX_TAG=(rust-v[0-9]+\.[0-9]+\.[0-9]+)\s*$", dockerfile, re.MULTILINE)
    if len(tags) != 1 or re.search(r"openai/codex/(?:releases/download/)?rust-v", dockerfile):
        raise ValueError("docker/Dockerfile must pin exactly one official Codex release, as its one ARG CODEX_TAG")
    return tags[0]


def schema_of(migrations: Path) -> int:
    numbers = [int(match.group(1)) for path in migrations.iterdir() if (match := MIGRATION.fullmatch(path.name))]
    if not numbers:
        raise ValueError(f"{migrations} holds no migration")
    return max(numbers)


def release_env(*, version: str, source_sha: str, schema: int, app: str, database: str, runtime: str) -> str:
    return (
        f"# Flux {version}, built from {source_sha} by the release workflow (.github/workflows/final-release.yml).\n"
        "# ./flux reads this file: the images below, pinned by digest, are the only ones it runs. Do not edit it; ./flux upgrade replaces it.\n"
        f"FLUX_RELEASE_VERSION={version}\n"
        f"FLUX_RELEASE_COMMIT={source_sha}\n"
        f"FLUX_RELEASE_SCHEMA={schema}\n"
        f"{APP_VARIABLE}={app}\n"
        f"{DATABASE_VARIABLE}={database}\n"
        f"{RUNTIME_VARIABLE}={runtime}\n"
    )


def write_bundle(path: Path, members: dict[str, bytes], mtime: int) -> None:
    """A reproducible gzip-compressed tar of `flux/<member>`: sorted, owned by root, fixed modes and times."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        directories = sorted({str(parent) for name in members for parent in Path(TOP, name).parents if str(parent) != "."})
        for directory in directories:
            info = tarfile.TarInfo(directory)
            info.type, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = tarfile.DIRTYPE, 0o755, mtime, 0, 0, "root", "root"
            archive.addfile(info)
        for name in sorted(members):
            data = members[name]
            info = tarfile.TarInfo(f"{TOP}/{name}")
            info.size, info.mtime, info.uid, info.gid, info.uname, info.gname = len(data), mtime, 0, 0, "root", "root"
            info.mode = 0o755 if name in EXECUTABLE else 0o644
            archive.addfile(info, io.BytesIO(data))
    with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=mtime, compresslevel=9) as compressed:
        compressed.write(buffer.getvalue())


def notices(spdx_file: Path, label: str) -> list[dict[str, str]]:
    spdx = json.loads(spdx_file.read_text(encoding="utf-8"))
    packages = spdx.get("packages")
    if not isinstance(packages, list) or not packages:
        raise ValueError(f"{label} SPDX SBOM must contain image packages")
    found = [
        {
            "name": package["name"],
            "version": package.get("versionInfo", ""),
            "license_declared": package.get("licenseDeclared", "NOASSERTION"),
            "license_concluded": package.get("licenseConcluded", "NOASSERTION"),
            "copyright": package.get("copyrightText", "NOASSERTION"),
        }
        for package in packages
    ]
    found.sort(key=lambda item: (item["name"], item["version"]))
    return found


def prepare(
    *, version: str, source_sha: str, digest: str, runtime_digest: str, database_digest: str, source: Path, destination: Path,
    sbom: Path, runtime_sbom: Path, database_sbom: Path, platforms: str = DEFAULT_PLATFORMS, registry: str = REGISTRY, mtime: int = 0,
) -> None:
    if not VERSION.fullmatch(version):
        raise ValueError("version must be vX.Y.Z or vX.Y.Z-rc.N")
    if not SHA.fullmatch(source_sha):
        raise ValueError("source SHA must be 40 lowercase hex characters")
    for label, value in (("image", digest), ("runtime image", runtime_digest), ("database image", database_digest)):
        if not DIGEST.fullmatch(value):
            raise ValueError(f"{label} digest must be a sha256 manifest digest")
    if len({digest, runtime_digest, database_digest}) != 3:
        raise ValueError("the application, runtime and database images must have different digests")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.:/-]*[a-z0-9]", registry):
        raise ValueError("registry must be a registry host and path, such as ghcr.io/coldphase")
    platform_list = parse_platforms(platforms)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("destination must be empty to prevent stale assets")

    files = {target: (source / name).read_bytes() for name, target in BUNDLE_FILES.items()}
    check_release_compose(files["docker/compose.yaml"].decode(), files["docker/compose.runtime.yaml"].decode())
    pinned = {name: third_party_images(name, files[name].decode(), count) for name, count in THIRD_PARTY.items()}
    env_example = files["docker/.env.example"].decode()
    if re.search(r"^(FLUX_RELEASE_[A-Z_]*)=", env_example, re.MULTILINE):
        raise ValueError("docker/.env.example must not name an image: docker/release.env does")
    app = f"{registry}/flux@{digest}"
    database = f"{registry}/flux-database@{database_digest}"
    runtime = f"{registry}/flux-agent-runtime@{runtime_digest}"
    schema = schema_of(source / "app" / "packages" / "db" / "migrations")
    files[RELEASE_ENV] = release_env(version=version, source_sha=source_sha, schema=schema, app=app, database=database,
                                     runtime=runtime).encode()
    codex = codex_pin((source / "docker" / "Dockerfile").read_text(encoding="utf-8"))

    runtime_notices = notices(runtime_sbom, "agent-runtime")
    # The official Codex binary is a vendor download, which a package scanner may not list: record it.
    if not any(item["name"].lower() in ("codex", "codex-cli") for item in runtime_notices):
        runtime_notices.append({
            "name": "codex-cli",
            "version": codex.removeprefix("rust-v"),
            "license_declared": "Apache-2.0",
            "license_concluded": "Apache-2.0",
            "copyright": "OpenAI; official release https://github.com/openai/codex/releases/tag/" + codex,
        })

    destination.mkdir(parents=True, exist_ok=True)
    write_bundle(destination / BUNDLE, files, mtime)
    (destination / "LICENSE").write_bytes(files["LICENSE"])
    for spdx, target in ((sbom, "sbom.spdx.json"), (runtime_sbom, "sbom-agent-runtime.spdx.json"), (database_sbom, "sbom-database.spdx.json")):
        (destination / target).write_bytes(spdx.read_bytes())
    for items, target in ((notices(sbom, "application"), "THIRD_PARTY_NOTICES.json"),
                          (runtime_notices, "THIRD_PARTY_NOTICES.agent-runtime.json"),
                          (notices(database_sbom, "database"), "THIRD_PARTY_NOTICES.database.json")):
        (destination / target).write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "version": version,
        "source_sha": source_sha,
        "schema": schema,
        "bundle": BUNDLE,
        "bundle_sha256": hashlib.sha256((destination / BUNDLE).read_bytes()).hexdigest(),
        "image": app,
        "platforms": platform_list,
        "runtime_image": runtime,
        "runtime_platforms": platform_list,
        "runtime_codex": codex,
        "runtime_claude_code": "not included; runtime-install installs Anthropic's signed release when the owner enables it",
        "database_image": database,
        "database_platforms": platform_list,
        "https_image": pinned["docker/compose.https.yaml"][0],
        "live_media_image": pinned["docker/compose.live.yaml"][0],
        "embeddings_image": pinned["docker/compose.embeddings.yaml"][0],
    }
    (destination / "release.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    lines = []
    for asset in sorted(destination.iterdir()):
        if not ASSET_NAME.fullmatch(asset.name):
            raise ValueError(f"asset name {asset.name!r} would be renamed by GitHub")
        lines.append(f"{hashlib.sha256(asset.read_bytes()).hexdigest()}  {asset.name}\n")
    (destination / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--runtime-digest", required=True)
    parser.add_argument("--database-digest", required=True)
    parser.add_argument("--sbom", type=Path, required=True)
    parser.add_argument("--runtime-sbom", type=Path, required=True)
    parser.add_argument("--database-sbom", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=Path("."), help="the source tree of the candidate (default: here)")
    parser.add_argument("--registry", default=REGISTRY, help=f"where the images are (default {REGISTRY}; a local registry for tests)")
    parser.add_argument("--mtime", type=int, default=0, help="the archive's file times, seconds since 1970 (the source commit's time)")
    parser.add_argument("--platforms", default=DEFAULT_PLATFORMS,
                        help="platforms the images were built for, comma-separated (default linux/amd64)")
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    prepare(
        version=args.version, source_sha=args.source_sha, digest=args.digest, runtime_digest=args.runtime_digest,
        database_digest=args.database_digest, source=args.source, destination=args.destination, sbom=args.sbom,
        runtime_sbom=args.runtime_sbom, database_sbom=args.database_sbom, platforms=args.platforms, registry=args.registry,
        mtime=args.mtime,
    )


if __name__ == "__main__":
    main()
