#!/usr/bin/env bash
# Resolve the release's live-media overlays on its compose.yaml with `docker compose config` (no container starts)
# and check the result: the SFU runs release.json's digest-pinned live_media_image, nothing builds from source, the
# API joins the internal signaling network next to its keyring network, and only the media ports are published.
#
#   scripts/release/check_live_overlay.sh <release asset directory>
#
# Used by final-release.yml's package job and by dry_run.sh. Placeholder values only; nothing is pulled.
set -euo pipefail

assets=${1:?release asset directory required}
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-live-overlay.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/certs"

export POSTGRES_PASSWORD=x FLUX_PUBLIC_ORIGIN=https://flux.example.org FLUX_AUTH_SECRET=x FLUX_PROJECT=fluxlivecheck \
  FLUX_LIVEKIT_API_KEY=key FLUX_LIVEKIT_API_SECRET=secret FLUX_LIVEKIT_PUBLIC_IP=203.0.113.20 \
  FLUX_LIVEKIT_DOMAIN=media.example.org FLUX_LIVEKIT_TURN_DOMAIN=turn.example.org \
  FLUX_LIVEKIT_TURN_CERT_DIR="$work/certs"
docker compose --project-directory "$assets" -f "$assets/compose.yaml" -f "$assets/compose.live.yaml" \
  config --format json > "$work/live.json"
docker compose --project-directory "$assets" -f "$assets/compose.yaml" -f "$assets/compose.live.yaml" \
  -f "$assets/compose.live.turn.yaml" config --format json > "$work/turn.json"

python3 - "$assets/release.json" "$work/live.json" "$work/turn.json" "$work/certs" <<'PY'
import json, sys
release = json.load(open(sys.argv[1], encoding="utf-8"))
media = release["live_media_image"]
app = release["image"]


def published(service):
    return sorted(f"{p.get('published')}:{p['target']}/{p.get('protocol', 'tcp')}" for p in service.get("ports", []))


for label, path, extra in (("compose.live.yaml", sys.argv[2], []), ("+ compose.live.turn.yaml", sys.argv[3], ["443:443/tcp"])):
    config = json.load(open(path, encoding="utf-8"))
    services = config["services"]
    built = sorted(name for name, service in services.items() if "build" in service)
    assert not built, f"{label}: services build from source: {built}"
    livekit = services["livekit"]
    assert livekit["image"] == media, (label, livekit["image"], media)
    for name in ("api", "worker", "migrate", "keyring"):
        assert services[name]["image"] == app, (label, name, services[name]["image"])
    api = services["api"]
    assert api["environment"]["FLUX_LIVEKIT_API_URL"] == "http://livekit:7880", label
    assert {"default", "keyring", "livekit-signal"} <= set(api["networks"]), (label, api["networks"])
    assert set(livekit["networks"]) == {"livekit-media", "livekit-signal"}, (label, livekit["networks"])
    assert config["networks"]["livekit-signal"].get("internal") is True, label
    wanted = sorted(["7881:7881/tcp", "7882:7882/udp", "3478:3478/udp"] + extra)
    assert published(livekit) == wanted, (label, published(livekit), wanted)
    assert "7880" not in json.dumps(livekit.get("ports", [])), label
    if extra:
        mounts = [v for v in livekit.get("volumes", []) if v.get("target") == "/run/livekit-turn-certs"]
        assert mounts and mounts[0]["source"] == sys.argv[4] and mounts[0].get("read_only"), (label, mounts)
    print(f"{label}: resolves; livekit {media}; ports {', '.join(published(livekit))}; no source build")
PY
