#!/bin/sh
# Browser tests for the web app: builds the image (which runs build, lint and typecheck),
# starts the Compose app on its own project and loopback port, and runs tests/ui in the
# pinned Playwright container. Screenshots go to FLUX_UI_SCREENSHOT_DIR when it is set
# (an absolute path), e.g. FLUX_UI_SCREENSHOT_DIR="$PWD/docs/design/app-shell".
# Arguments name test modules (or Module.Class.test) to run only those, e.g.
# ./scripts/check_ui.sh test_docs test_people; without arguments every module runs.
set -eu

cd "$(dirname "$0")/.."
project="flux-ui-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-ui-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-ui-$$-$(date +%s)"
export FLUX_PORT="${FLUX_UI_PORT:-18591}"
export FLUX_MAILPIT_PORT="${FLUX_UI_MAILPIT_PORT:-18592}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-ui-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
# The journey signs in several times from one address; rate limiting is covered by the API suite.
export FLUX_AUTH_RATE_LIMIT=false
# TEST ONLY (#68): personal runs use fixture key connections and the real Anthropic adapter
# against the Compose mock provider (tests/ui/anthropic_mock.py). Never set in production.
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_TEST_PERSONAL_RUNS=anthropic-mock
export FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
if [ -n "${FLUX_UI_SCREENSHOT_DIR:-}" ]; then mkdir -p "$FLUX_UI_SCREENSHOT_DIR"; fi
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml --profile ui"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color db migrate files-init api || true
  fi
  $compose down -v || true
  remove_project_images
}
trap cleanup EXIT HUP INT TERM

$compose build migrate ui-test
$compose up -d db migrate
# The API writes uploaded files to the shared volume; give it to the runtime user first.
$compose --profile setup run --rm files-init
if [ "$#" -gt 0 ]; then
  $compose run --rm -w /work/tests/ui ui-test python3 -m unittest -v "$@"
else
  $compose run --rm ui-test
fi
