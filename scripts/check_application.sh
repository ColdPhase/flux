#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
project="flux-test-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18089}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18025}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
# The suite signs in many times from one address; rate limiting is covered separately.
export FLUX_AUTH_RATE_LIMIT=false
compose="docker compose -p $project -f infra/compose.yaml --profile test"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color db migrate api mailpit test || true
  fi
  $compose down -v
}
trap cleanup EXIT HUP INT TERM

$compose up -d --build db migrate
$compose --profile setup run --rm files-init
$compose run --build --rm test

# A session created before an API container restart must still be valid afterwards.
$compose run --rm test pnpm exec tsx tests/app/session-restart.ts prepare
$compose restart api
$compose up -d --wait api
$compose run --rm test pnpm exec tsx tests/app/session-restart.ts verify
