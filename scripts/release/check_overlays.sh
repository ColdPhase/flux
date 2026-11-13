#!/usr/bin/env bash
# Resolve the optional overlays of a release's install folder on its docker/compose.yaml with `docker compose config` (no container
# starts), exactly as ./flux layers them (#1471): built-in HTTPS (compose.https.yaml), calls (compose.live.yaml) and local embeddings
# (compose.embeddings.yaml). Each third-party service runs the image release.json names, pinned by digest; nothing builds; every Flux
# service runs an image of docker/release.env; only the media ports and 80/443 are published, and the API stays on loopback.
#
#   scripts/release/check_overlays.sh <release asset directory>
#
# Used by final-release.yml's package job and by dry_run.sh. Placeholder values only; nothing is pulled.
set -euo pipefail

assets=$(cd "${1:?release asset directory required}" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-overlays.XXXXXX")
trap 'rm -rf "$work"' EXIT
folder=$(sh "$(dirname "$0")/unpack_release.sh" "$assets" "$work/owner")
docker_dir="$folder/docker"

set -a
# shellcheck disable=SC1091
. "$docker_dir/release.env"
set +a
export POSTGRES_PASSWORD=x FLUX_PUBLIC_ORIGIN=https://flux.example.org FLUX_AUTH_SECRET=x FLUX_PROJECT=fluxoverlaycheck \
  FLUX_HTTPS_HOST=flux.example.org FLUX_HTTPS_PORT=443 FLUX_LIVEKIT_API_KEY=key FLUX_LIVEKIT_API_SECRET=secret \
  FLUX_LIVEKIT_PUBLIC_IP=203.0.113.20 FLUX_LIVEKIT_DOMAIN=flux.example.org
docker compose --project-directory "$docker_dir" --env-file /dev/null -f "$docker_dir/compose.yaml" -f "$docker_dir/compose.https.yaml" \
  -f "$docker_dir/compose.live.yaml" -f "$docker_dir/compose.embeddings.yaml" config --format json > "$work/all.json"

python3 - "$assets/release.json" "$work/all.json" <<'PY'
import json, sys
release = json.load(open(sys.argv[1], encoding="utf-8"))
services = json.load(open(sys.argv[2], encoding="utf-8"))["services"]


def published(service):
    return sorted(f"{p.get('host_ip', '')}{':' if p.get('host_ip') else ''}{p.get('published')}:{p['target']}/{p.get('protocol', 'tcp')}"
                  for p in service.get("ports", []))


built = sorted(name for name, service in services.items() if "build" in service)
assert not built, f"services build from source: {built}"
for name in ("api", "worker", "migrate", "keyring"):
    assert services[name]["image"] == release["image"], (name, services[name]["image"])
assert services["db"]["image"] == release["database_image"], services["db"]["image"]
for name, key in (("proxy", "https_image"), ("livekit", "live_media_image"), ("embeddings", "embeddings_image")):
    assert services[name]["image"] == release[key], (name, services[name]["image"], release[key])
api = services["api"]
assert published(api) == ["127.0.0.1:8081:8080/tcp"], published(api)
assert {"default", "keyring", "edge", "livekit-signal"} <= set(api["networks"]), api["networks"]
assert api["environment"]["FLUX_LIVEKIT_API_URL"] == "http://livekit:7880"
assert api["environment"]["FLUX_EMBEDDINGS_URL"] == "http://embeddings:8080"
assert published(services["proxy"]) == ["443:443/tcp", "443:443/udp", "80:80/tcp"], published(services["proxy"])
assert published(services["livekit"]) == ["3478:3478/udp", "7881:7881/tcp", "7882:7882/udp"], published(services["livekit"])
assert not services["embeddings"].get("ports"), "the embedding server publishes a port"
print("overlays resolve on the release's compose.yaml: proxy", release["https_image"], "; livekit", release["live_media_image"],
      "; embeddings", release["embeddings_image"], "; no source build")
PY
