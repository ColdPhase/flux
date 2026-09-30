#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
project="flux-live-test-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-live-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="flux-live-fixture-$$-$(date +%s)"
export FLUX_PORT="${FLUX_LIVE_TEST_PORT:-18761}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-live-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_IMAGE_TAG="$project"
export FLUX_LIVEKIT_API_KEY="fluxlivetestingkey"
export FLUX_LIVEKIT_API_SECRET="fluxlivetestingsecretwithatleast32characters"
# The test overlay replaces LiveKit's public ICE configuration. These satisfy
# the operator profile's required-variable interpolation before Compose merges.
export FLUX_LIVEKIT_PUBLIC_IP="127.0.0.1"
export FLUX_LIVEKIT_DOMAIN="localhost"
export FLUX_LIVEKIT_ICE_TCP_PORT="${FLUX_LIVE_TEST_ICE_TCP_PORT:-18763}"
export FLUX_LIVEKIT_ICE_UDP_PORT="${FLUX_LIVE_TEST_ICE_UDP_PORT:-18764}"
export FLUX_LIVEKIT_TURN_UDP_PORT="${FLUX_LIVE_TEST_TURN_UDP_PORT:-18765}"

compose="docker compose -p $project -f infra/compose.yaml -f infra/compose.live.yaml -f infra/compose.live.test.yaml --profile live-test"
marker_dir=$(mktemp -d)
chmod 1777 "$marker_dir"
restart_pid=""
cleanup() {
  status=$?
  if [ -n "$restart_pid" ]; then kill "$restart_pid" 2>/dev/null || true; fi
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail=80 db migrate api livekit live-sfu-test live-sfu-legacy-test || true
  fi
  $compose down -v || true
  rm -rf "$marker_dir"
  if [ "${FLUX_KEEP_TEST_IMAGES:-0}" != "1" ]; then
    docker image rm "flux-foundation:$project" "flux-e2e:$project" "flux-live-sfu-test:$project" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

# Build the exact application and Chromium base image used by the proof.
docker build -f infra/Dockerfile --target e2e -t "flux-e2e:$project" .
$compose build migrate live-sfu-test
$compose up -d --wait api livekit
$compose run --rm live-sfu-test
# API cutover (#128): with the API stopped, a client joins the SFU with a pre-#128 grant and
# publishes audio; after the new API starts, reconciliation must retire it.
cutover_dir="$marker_dir/cutover"
mkdir -p "$cutover_dir" && chmod 1777 "$cutover_dir"
await_marker() {
  for _ in $(seq 1 90); do
    if [ -f "$cutover_dir/$1" ]; then return 0; fi
    if ! kill -0 "$restart_pid" 2>/dev/null; then break; fi
    sleep 1
  done
  cat "$cutover_dir/test.log" >&2
  echo "Real SFU cutover test did not reach $1" >&2
  exit 1
}
$compose run --rm -v "$cutover_dir:/cutover:Z" -e FLUX_CUTOVER_MARKER_DIR=/cutover live-sfu-legacy-test \
  > "$cutover_dir/test.log" 2>&1 &
restart_pid=$!
await_marker ready
$compose stop api
printf 'ok\n' > "$cutover_dir/api-stopped"
await_marker legacy-connected
$compose up -d --wait api
printf 'ok\n' > "$cutover_dir/api-started"
if ! wait "$restart_pid"; then
  cat "$cutover_dir/test.log" >&2
  exit 1
fi
restart_pid=""
cat "$cutover_dir/test.log"

# The browser test signals only after a real client has joined and received an
# SFU-refreshed token. Restart the pinned SFU, then release its assertions.
$compose run --rm -v "$marker_dir:/restart:Z" -e FLUX_RESTART_MARKER_DIR=/restart \
  live-sfu-test node_modules/.bin/tsx --test tests/app/e2e/live-sfu-restart.e2e.ts \
  > "$marker_dir/test.log" 2>&1 &
restart_pid=$!
ready=0
for _ in $(seq 1 60); do
  if [ -f "$marker_dir/ready" ]; then ready=1; break; fi
  if ! kill -0 "$restart_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  cat "$marker_dir/test.log" >&2
  echo 'Real SFU restart test did not reach a connected client' >&2
  exit 1
fi
$compose restart livekit
$compose up -d --wait livekit
printf 'ok\n' > "$marker_dir/restarted"
if ! wait "$restart_pid"; then
  cat "$marker_dir/test.log" >&2
  exit 1
fi
restart_pid=""
cat "$marker_dir/test.log"
