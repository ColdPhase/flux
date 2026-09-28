#!/bin/sh
# Live-session interface journeys (#62) in real Chromium against the full Flux application and
# the pinned self-hosted LiveKit SFU of the live test profile. Browsers use Chromium's fake
# camera, microphone and screen, so this is local evidence of the interface and the media path,
# not of physical devices, networks or TURN (those belong to #63). Heavy: run it locally, not
# in PR Actions. Screenshots go to FLUX_UI_SCREENSHOT_DIR when it is set (an absolute path).
set -eu

cd "$(dirname "$0")/.."
project="flux-live-ui-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-live-ui-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="flux-live-ui-fixture-$$-$(date +%s)"
export FLUX_PORT="${FLUX_LIVE_UI_PORT:-18781}"
export FLUX_MAILPIT_PORT="${FLUX_LIVE_UI_MAILPIT_PORT:-18782}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-live-ui-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_IMAGE_TAG="$project"
export FLUX_LIVEKIT_API_KEY="fluxliveuitestkey"
export FLUX_LIVEKIT_API_SECRET="fluxliveuitestsecretwithatleast32characters"
export FLUX_LIVEKIT_API_URL="http://livekit:7880"
export FLUX_LIVEKIT_WS_URL="ws://livekit:7880"
export FLUX_LIVEKIT_PUBLIC_IP="127.0.0.1"
export FLUX_LIVEKIT_DOMAIN="localhost"
export FLUX_LIVEKIT_SIGNAL_PORT="${FLUX_LIVE_UI_SIGNAL_PORT:-18783}"
export FLUX_LIVEKIT_ICE_TCP_PORT="${FLUX_LIVE_UI_ICE_TCP_PORT:-18784}"
export FLUX_LIVEKIT_ICE_UDP_PORT="${FLUX_LIVE_UI_ICE_UDP_PORT:-18785}"
export FLUX_LIVEKIT_TURN_UDP_PORT="${FLUX_LIVE_UI_TURN_UDP_PORT:-18786}"
if [ -n "${FLUX_UI_SCREENSHOT_DIR:-}" ]; then mkdir -p "$FLUX_UI_SCREENSHOT_DIR"; fi

compose="docker compose -p $project -f infra/compose.yaml -f infra/compose.live.yaml -f infra/compose.live.test.yaml --profile ui"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail=120 migrate api worker livekit || true
  fi
  $compose down -v || true
  if [ "${FLUX_KEEP_TEST_IMAGES:-0}" != "1" ]; then
    docker image rm "flux-foundation:$project" "flux-ui-tests:$project" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

$compose build migrate ui-test
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker livekit mailpit
$compose run --rm -e FLUX_UI_LIVE=1 ui-test python3 -m unittest discover -s tests/ui -p "${FLUX_LIVE_UI_PATTERN:-test_live_sessions.py}" -v
