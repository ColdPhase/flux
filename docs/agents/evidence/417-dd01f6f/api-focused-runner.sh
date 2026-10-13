#!/bin/sh
set -eu
cd /home/hubert/Develop/flux-347-agents-tab-fixes
project="flux417-api-$$"
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux417-$$"
export FLUX_FIXTURE_TOKEN="fixture417-$$"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_PORT=18717 FLUX_MAILPIT_PORT=18718
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth417-$$-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
export FLUX_SMTP_URL= FLUX_MAIL_FROM=
export FLUX_BACKGROUND_KEY_HOST_FILE="$(mktemp -d)/background_key"
mkdir -p "$(dirname "$FLUX_BACKGROUND_KEY_HOST_FILE")"
head -c 32 /dev/urandom > "$FLUX_BACKGROUND_KEY_HOST_FILE"
chmod 0444 "$FLUX_BACKGROUND_KEY_HOST_FILE"
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test"
. scripts/test_images.sh
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then $compose logs --no-color db migrate api test || true; fi
  $compose down -v || true
  if [ "${FLUX_KEEP_TEST_IMAGES:-}" != 1 ]; then remove_project_images; fi
  chmod 0600 "$FLUX_BACKGROUND_KEY_HOST_FILE" || true
  rm -f "$FLUX_BACKGROUND_KEY_HOST_FILE"
  rmdir "$(dirname "$FLUX_BACKGROUND_KEY_HOST_FILE")" || true
}
trap cleanup EXIT HUP INT TERM
$compose build migrate api test
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api
$compose run --rm --no-deps test node_modules/.bin/tsx --test --test-concurrency=1 tests/app/cowork-request-responses.test.ts
