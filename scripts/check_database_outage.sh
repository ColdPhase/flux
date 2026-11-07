#!/bin/sh
# A short database outage must not crash the API or the worker (#889). Builds the source stack in its own Compose project, stops
# and starts the database, and checks that nothing restarted and that the API recovers (scripts/database_outage.sh).
# Set FLUX_TEST_PORT and FLUX_TEST_MAILPIT_PORT for concurrent runs.
set -eu

cd "$(dirname "$0")/.."
project="flux-outage-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
# compose.test.yaml points the API at test-only hosts, which it accepts only on a test deployment (fixture token and failure injection).
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_PORT="${FLUX_TEST_PORT:-18089}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18025}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
background_secret_dir=$(mktemp -d)
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"
# The keyring token makes the worker start the key rotation, whose own small pool was the first one found without a listener.
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
# A blank VAPID pair keeps a developer's docker/.env out of the run.
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color db migrate api worker keyring || true
  fi
  $compose down -v || true
  remove_project_images
  chmod 0600 "$background_secret_dir/background_key"
  unlink "$background_secret_dir/background_key"
  rmdir "$background_secret_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

. scripts/database_outage.sh
$compose build
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker keyring
check_database_outage
