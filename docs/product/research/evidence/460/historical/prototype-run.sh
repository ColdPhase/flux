#!/bin/sh
# OPT-IN, never in CI or check_application.sh (#152 AC-4): the REAL pinned Codex (rust-v0.160.1, vendored by
# tag with its published checksum) and Claude Code (the version in apps/runtime/src/install/pins.ts, downloaded
# at run time from Anthropic's GPG-signed release manifest, never baked into an image) register Flux's MCP
# server with their own `mcp add`, complete Flux's OAuth for MCP in Chromium as the person, list and call Flux's
# tools from three personal connections, and stop when the owner revokes one. No vendor account or sign-in: the
# clients' model traffic goes to a scripted local endpoint (tests/app/support/client-model-mock.ts).
#
# Needs internet access to github.com (image build) and downloads.claude.ai (run time). Run it alone under the
# shared Docker lock; set FLUX_TEST_PORT / FLUX_TEST_MAILPIT_PORT for concurrent runs. Record the dated result
# (client versions and output) on the PR.
set -eu

cd /home/hubert/Develop/flux/.worktrees/460-protocol-compatibility
project="flux-mcpclients-$(date +%s)-$$"
printf "%s\n" "$project" > /tmp/flux-460-prototype/project
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18090}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18026}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
background_secret_dir=$(mktemp -d)
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_AUTH_RATE_LIMIT=false
# The dev stack's VAPID keys must not leak into this run (docs/development/containers.md).
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml -f /tmp/flux-460-prototype/compose.yaml --profile test --profile mcp-clients"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail 80 db migrate api worker || true
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

$compose build migrate mcp-clients
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose run --rm mcp-clients
