#!/usr/bin/env bash
set -euo pipefail
cd /home/hubert/Develop/flux/.worktrees/402-assistant-identity
expected=b6451de1eeb2362a7be3efdb3bec5e083cad2ba9
actual=$(git rev-parse HEAD)
[ "$actual" = "$expected" ] || { echo "wrong source pin: $actual" >&2; exit 2; }
project=flux-test-457-b6451-focused
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-457-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-457-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT=19457 FLUX_MAILPIT_PORT=19458
export FLUX_PUBLIC_ORIGIN=http://127.0.0.1:$FLUX_PORT
export FLUX_AUTH_SECRET="auth-457-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
export FLUX_SMTP_URL=smtp://mailpit:1025 FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_AUTH_RATE_LIMIT=false FLUX_STREAM_HEARTBEAT_MS=1000
export FLUX_UI_SCREENSHOT_DIR=/home/hubert/Develop/flux-evidence-archive/flux457-b6451-focused/ui
export FLUX_E2E_EVIDENCE_DIR=/home/hubert/Develop/flux-evidence-archive/flux457-b6451-focused/e2e
export FLUX_KEEP_TEST_IMAGES=0
mkdir -p "$FLUX_UI_SCREENSHOT_DIR" "$FLUX_E2E_EVIDENCE_DIR"
secret_dir=$(mktemp -d)
export FLUX_BACKGROUND_KEY_HOST_FILE="$secret_dir/background_key"
head -c 32 /dev/urandom > "$FLUX_BACKGROUND_KEY_HOST_FILE"
chmod 0444 "$FLUX_BACKGROUND_KEY_HOST_FILE"
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test --profile ui"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then $compose logs --no-color db migrate api worker mailpit pushmock test e2e ui-test || true; fi
  $compose down -v || true
  remove_project_images
  chmod 0600 "$FLUX_BACKGROUND_KEY_HOST_FILE" 2>/dev/null || true
  unlink "$FLUX_BACKGROUND_KEY_HOST_FILE" 2>/dev/null || true
  rmdir "$secret_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
$compose build
$compose up -d db migrate
$compose --profile setup run --rm files-init
for engine in chromium webkit; do
  echo "=== AgentsTabStates fixture + test_04: $engine ==="
  $compose run --rm -e FLUX_UI_BROWSER="$engine" -w /work/tests/ui ui-test python3 -m unittest -v \
    test_agents_tab_states.AgentsTabStates.test_00_a_project_with_agents_connections_and_tasks \
    test_agents_tab_states.AgentsTabStates.test_04_requests_shows_what_waits_for_you
 done
keys=$($compose run --rm --no-deps -T migrate apps/worker/node_modules/.bin/web-push generate-vapid-keys --json)
export FLUX_VAPID_PUBLIC_KEY=$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^" ]*\)".*/\1/p')
export FLUX_VAPID_PRIVATE_KEY=$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^" ]*\)".*/\1/p')
export FLUX_VAPID_SUBJECT=mailto:push-test@example.test
[ -n "$FLUX_VAPID_PUBLIC_KEY" ] && [ -n "$FLUX_VAPID_PRIVATE_KEY" ] || { echo 'VAPID key generation failed (values suppressed)' >&2; exit 1; }
$compose run --rm -v "$FLUX_E2E_EVIDENCE_DIR:/evidence:Z" -e FLUX_E2E_EVIDENCE_DIR=/evidence \
  -e FLUX_E2E_SOURCE_SHA="$expected" e2e node_modules/.bin/tsx --test tests/app/e2e/assistant-join.e2e.ts
