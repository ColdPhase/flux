#!/usr/bin/env bash
set -euo pipefail
repo=/home/hubert/Develop/flux-389
evidence=${FLUX_389_EVIDENCE_DIR:?Set FLUX_389_EVIDENCE_DIR to a fresh absolute directory}
expected_source=${FLUX_389_SOURCE_SHA:?Set FLUX_389_SOURCE_SHA to the frozen commit}
case "$evidence" in /*) ;; *) echo 'Evidence path must be absolute' >&2; exit 2 ;; esac
if [[ -e "$evidence" && -n "$(ls -A "$evidence")" ]]; then echo 'Evidence directory must be empty' >&2; exit 2; fi
mkdir -p "$evidence"
cd "$repo"
actual=$(git rev-parse HEAD)
[[ "$actual" == "$expected_source" ]] || { echo "source mismatch: expected $expected_source, found $actual" >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Source checkout must be clean' >&2; exit 2; }
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-focused-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-focused-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18089}" FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18025}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-focused-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL='smtp://mailpit:1025' FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_AUTH_RATE_LIMIT=false FLUX_STREAM_HEARTBEAT_MS=1000
keydir=$(mktemp -d)
head -c 32 /dev/urandom > "$keydir/background_key"
chmod 0444 "$keydir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$keydir/background_key"
. scripts/test_images.sh
project="flux389-api-$(date +%s)-$$"
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test"
cleanup() {
  status=$?
  if (( status != 0 )); then $compose logs --no-color db migrate api worker test > "$evidence/compose-failure.log" 2>&1 || true; fi
  $compose down -v > "$evidence/compose-down.log" 2>&1 || true
  remove_project_images > "$evidence/image-cleanup.log" 2>&1 || true
  chmod 0600 "$keydir/background_key"; unlink "$keydir/background_key"; rmdir "$keydir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'source=%s\nrunner=%s\n' "$actual" "$0" > "$evidence/run-metadata.txt"
sha256sum "$0" scripts/check_application.sh > "$evidence/harness-sha256.txt"
 $compose build > "$evidence/build.log" 2>&1
$compose up -d db migrate > "$evidence/services.log" 2>&1
$compose --profile setup run --rm files-init >> "$evidence/services.log" 2>&1
keys=$($compose run --rm --no-deps -T migrate apps/worker/node_modules/.bin/web-push generate-vapid-keys --json)
export FLUX_VAPID_PUBLIC_KEY=$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')
export FLUX_VAPID_PRIVATE_KEY=$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')
export FLUX_VAPID_SUBJECT='mailto:push-test@example.test'
[[ -n "$FLUX_VAPID_PUBLIC_KEY" && -n "$FLUX_VAPID_PRIVATE_KEY" ]] || { echo 'VAPID key generation failed' >&2; exit 1; }
set -- tests/app/editing-http-lifetime.test.ts tests/app/mcp-map-actions.test.ts tests/app/agent-stop-questions.test.ts tests/app/live-doc-native-fence.test.ts
printf 'files=%s\n' "$*" > "$evidence/selection.txt"
$compose run --rm test node_modules/.bin/tsx --test --test-concurrency=1 "$@" > "$evidence/api-tests.log" 2>&1
