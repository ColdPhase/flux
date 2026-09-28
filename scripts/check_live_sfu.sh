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
export FLUX_LIVEKIT_API_URL="http://livekit:7880"
export FLUX_LIVEKIT_WS_URL="ws://livekit:7880"
# The test overlay replaces LiveKit's public ICE configuration. These satisfy
# the operator profile's required-variable interpolation before Compose merges.
export FLUX_LIVEKIT_PUBLIC_IP="127.0.0.1"
export FLUX_LIVEKIT_DOMAIN="localhost"
export FLUX_LIVEKIT_SIGNAL_PORT="${FLUX_LIVE_TEST_SIGNAL_PORT:-18762}"
export FLUX_LIVEKIT_ICE_TCP_PORT="${FLUX_LIVE_TEST_ICE_TCP_PORT:-18763}"
export FLUX_LIVEKIT_ICE_UDP_PORT="${FLUX_LIVE_TEST_ICE_UDP_PORT:-18764}"
export FLUX_LIVEKIT_TURN_UDP_PORT="${FLUX_LIVE_TEST_TURN_UDP_PORT:-18765}"

compose="docker compose -p $project -f infra/compose.yaml -f infra/compose.live.yaml -f infra/compose.live.test.yaml --profile live-test"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail=80 db migrate api livekit live-sfu-test || true
  fi
  $compose down -v || true
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
