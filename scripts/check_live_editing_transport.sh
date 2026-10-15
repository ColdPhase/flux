#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${FLUX_LIVE_TRANSPORT_GRANTED:-}" != 228 ]; then
  echo 'This finite application transport check needs the serial #228 slot.' >&2
  exit 1
fi
transport_head="${FLUX_LIVE_TRANSPORT_HEAD:-}"
if [ -z "$transport_head" ] || [ "$(git rev-parse HEAD)" != "$transport_head" ] || [ -n "$(git status --porcelain)" ]; then
  echo 'Run transport calibration only from its pinned clean source checkpoint.' >&2
  exit 1
fi
image="flux-228-transport:calibration-$$"
container="flux-228-transport-$$"
evidence="${FLUX_LIVE_TRANSPORT_EVIDENCE:-/tmp/flux-228-transport}"
mkdir -p "$evidence"
cleanup() {
  status=$?
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git rev-parse HEAD > "$evidence/source-head.txt"
git diff --binary > "$evidence/tracked-source.diff"
sha256sum app/apps/server/src/index.ts app/apps/server/src/http/upgrades.ts \
  app/apps/server/src/editing/gate.ts app/tests/app/editing-transport.test.ts \
  app/pnpm-lock.yaml docker/Dockerfile scripts/check_live_editing_transport.sh \
  > "$evidence/source-sha256.txt"
timeout --signal=TERM --kill-after=10s 300s docker build --progress=plain \
  --target test -f "$PWD/docker/Dockerfile" -t "$image" "$PWD/app" \
  > "$evidence/build.txt" 2>&1
docker image inspect "$image" --format '{{.Id}}' > "$evidence/image-id.txt"
timeout --signal=TERM --kill-after=10s 15s docker run --rm --name "$container" \
  --init --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=512m --memory-swap=512m --cpus=2 --pids-limit=64 "$image" node -e '
const fs = require("node:fs"); const os = require("node:os");
const packages = ["fastify", "@fastify/websocket", "ws", "livekit-server-sdk"];
const dependencies = Object.fromEntries(packages.map((name) => [name,
  JSON.parse(fs.readFileSync("apps/server/node_modules/" + name + "/package.json", "utf8")).version]));
console.log(JSON.stringify({ node: process.version, versions: process.versions,
  platform: process.platform, architecture: process.arch, os: os.release(), cpu: os.cpus()[0]?.model,
  dependencies }, null, 2));' > "$evidence/inventory.json"
timeout --signal=TERM --kill-after=10s 30s docker run --rm --name "$container" \
  --init --network=none --read-only --tmpfs /tmp:rw,nosuid,noexec,size=32m \
  --cap-drop=ALL --security-opt=no-new-privileges --memory=512m --memory-swap=512m \
  --cpus=2 --pids-limit=64 "$image" node_modules/.bin/tsx --test \
  --test-concurrency=1 --test-timeout=20000 tests/app/editing-transport.test.ts \
  > "$evidence/transport.tap" 2>&1
cat "$evidence/transport.tap"
if [ "$(git rev-parse HEAD)" != "$transport_head" ] || [ -n "$(git status --porcelain)" ]; then
  echo 'Source changed during transport calibration; this run is not pinned evidence.' >&2
  exit 1
fi
