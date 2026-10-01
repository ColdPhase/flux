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
# Short stream heartbeat so the suite observes pings and periodic session revalidation.
export FLUX_STREAM_HEARTBEAT_MS=1000
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color db migrate api worker mailpit pushmock test || true
  fi
  $compose down -v || true
  remove_project_images
}
trap cleanup EXIT HUP INT TERM

run_browser() {
  if [ -n "${FLUX_E2E_EVIDENCE_DIR:-}" ]; then
    case "$FLUX_E2E_EVIDENCE_DIR" in /*) ;; *) echo "FLUX_E2E_EVIDENCE_DIR must be absolute" >&2; exit 1 ;; esac
    mkdir -p "$FLUX_E2E_EVIDENCE_DIR"
    $compose run --rm -v "$FLUX_E2E_EVIDENCE_DIR:/evidence:Z" -e FLUX_E2E_EVIDENCE_DIR=/evidence "$@"
  else
    $compose run --rm "$@"
  fi
}

$compose build
$compose up -d db migrate
$compose --profile setup run --rm files-init

# Fresh VAPID keys per run, created with the same command operators use (docs/development/containers.md).
keys=$($compose run --rm --no-deps -T migrate apps/worker/node_modules/.bin/web-push generate-vapid-keys --json)
FLUX_VAPID_PUBLIC_KEY=$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')
FLUX_VAPID_PRIVATE_KEY=$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')
export FLUX_VAPID_PUBLIC_KEY FLUX_VAPID_PRIVATE_KEY
export FLUX_VAPID_SUBJECT="mailto:push-test@example.test"
if [ -z "$FLUX_VAPID_PUBLIC_KEY" ] || [ -z "$FLUX_VAPID_PRIVATE_KEY" ]; then
  echo "VAPID key generation failed: $keys" >&2
  exit 1
fi

$compose run --rm test

# Service worker registration, offline fallback and the update prompt in Chromium over HTTPS.
run_browser e2e

# Login, sharing, denied access and stream revocation in Chromium sessions (issue #29, AC-4).
run_browser e2e node_modules/.bin/tsx --test tests/app/e2e/access-stream.e2e.ts

# Genuine human/agent task history in Chromium; trusted core writes use this isolated DB.
run_browser -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB" e2e node_modules/.bin/tsx --test tests/app/e2e/task-discussion-actors.e2e.ts

# Project GitHub settings use real Flux sessions/SQL and an injected external transport fixture.
# This is browser integration coverage, not the required real GitHub App installation evidence.
$compose run --rm e2e node_modules/.bin/tsx --test tests/app/e2e/github.e2e.ts

# Named, request-bound agent connection consent, including signed-out setup (#152).
$compose run --rm e2e node_modules/.bin/tsx --test tests/app/e2e/agent-connections.e2e.ts

# A session created before an API container restart must still be valid afterwards.
$compose run --rm test pnpm exec tsx tests/app/session-restart.ts prepare
$compose restart api
$compose up -d --wait api
$compose run --rm test pnpm exec tsx tests/app/session-restart.ts verify

# Without VAPID keys the API must report push unavailable rather than fail silently.
FLUX_VAPID_PUBLIC_KEY= $compose up -d --wait api
$compose run --rm --no-deps test pnpm exec tsx --test tests/app/push-unavailable.check.ts

# Without SMTP, notification email is reported unavailable and the inbox keeps working (#116, #113).
FLUX_SMTP_URL= FLUX_MAIL_FROM= $compose up -d --wait api worker
$compose run --rm --no-deps test pnpm exec tsx --test tests/app/email-unavailable.check.ts
