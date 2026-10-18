#!/bin/sh
# OPT-IN, never in CI or check_application.sh (#152 AC-4): the REAL pinned Codex (rust-v0.160.1, vendored by
# tag with its published checksum) and Claude Code (the version in apps/runtime/src/install/pins.ts, downloaded
# at run time from Anthropic's GPG-signed release manifest, never baked into an image) register Flux's MCP
# server with their own `mcp add`, complete Flux's OAuth for MCP in Chromium as the person, list and call Flux's
# tools from five personal connections of two owners, compose addressed deferred/versioned reviews, and stop when
# an owner revokes one. Sequential fresh native processes do not prove an active adapter or idle scheduling.
# No vendor account or sign-in: the
# clients' model traffic goes to a scripted local endpoint (tests/app/support/client-model-mock.ts).
#
# Needs internet access to github.com (image build) and downloads.claude.ai (run time). Run it alone under the
# shared Docker lock; set FLUX_TEST_PORT / FLUX_TEST_MAILPIT_PORT for concurrent runs. Record the dated result
# (client versions and output) on the PR.
set -eu

if [ "${FLUX_TEST_MCP_OAUTH_COMPARE:-0}" = 1 ] && [ "${FLUX_TEST_MCP_OAUTH_ONLY:-0}" != 1 ]; then
  echo "OAuth comparison requires explicit login-only mode." >&2; exit 2
fi

if [ "${FLUX_TEST_MCP_OAUTH_CALLBACK_DEFAULT:-0}" = 1 ] && { [ "${FLUX_TEST_MCP_OAUTH_ONLY:-0}" != 1 ] || [ "${FLUX_TEST_MCP_OAUTH_COMPARE:-0}" = 1 ]; }; then
  echo "Default-callback control requires explicit inline login-only mode." >&2; exit 2
fi

if [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ] && [ "${FLUX_TEST_MCP_LIVE_CLIENT:-}" != codex ]; then
  echo "Configured-account acceptance requires the explicit Codex selector; Claude remains stopped." >&2; exit 2
fi

# Explicit local acceptance mode: no model mocks, no CI. Read-only mounts are passed only to the disposable
# native-client container; never relabel, copy into the source/image, print, refresh or overwrite the host files.
if [ "${FLUX_TEST_MCP_OAUTH_ONLY:-0}" = 1 ]; then
  [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ] && [ "${FLUX_TEST_MCP_LIVE_CLIENT:-}" = codex ] || {
    echo "Login-only diagnosis requires FLUX_TEST_MCP_LIVE_WORKFLOW=1 and FLUX_TEST_MCP_LIVE_CLIENT=codex." >&2; exit 2;
  }
elif [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ]; then
  : "${FLUX_CODEX_AUTH_FILE:?Set an explicit Codex auth.json path for the authorized local account}"
  test -f "$FLUX_CODEX_AUTH_FILE"
  if [ "${FLUX_TEST_MCP_LIVE_CLIENT:-}" != codex ]; then
    : "${FLUX_CLAUDE_CREDENTIALS_FILE:?Set an explicit Claude credentials path for the authorized local account}"
    test -f "$FLUX_CLAUDE_CREDENTIALS_FILE"
  fi
fi

cd "$(dirname "$0")/.."
project="flux-mcpclients-$(date +%s)-$$"
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
# Optional isolation override (for example vetted IPAM) for concurrent local checks.
export COMPOSE_FILE="docker/compose.source.yaml:docker/compose.test.yaml${FLUX_TEST_COMPOSE_OVERRIDE:+:$FLUX_TEST_COMPOSE_OVERRIDE}"
if [ "${FLUX_TEST_MCP_OAUTH_ONLY:-0}" = 1 ]; then
  export COMPOSE_FILE="$COMPOSE_FILE:docker/compose.mcp-oauth.test.yaml"
elif [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ] && [ "${FLUX_TEST_MCP_LIVE_CLIENT:-}" = codex ]; then
  export COMPOSE_FILE="$COMPOSE_FILE:docker/compose.mcp-codex-live.test.yaml"
elif [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ]; then
  export COMPOSE_FILE="$COMPOSE_FILE:docker/compose.mcp-live.test.yaml"
fi
compose="docker compose -p $project --profile test --profile mcp-clients"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "${FLUX_TEST_MCP_OAUTH_ONLY:-0}" != 1 ]; then
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

if [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ] && [ "${FLUX_TEST_MCP_REUSE_IMAGES:-0}" = 1 ]; then
  : "${FLUX_IMAGE_TAG:?Explicit unchanged built-image tag required for local fixture-only reuse}"
  for image in $($compose config --images); do docker image inspect "$image" >/dev/null; done
else
  $compose build migrate test mcp-clients pushmock
fi
$compose up -d db migrate
$compose --profile setup run --rm files-init
if [ "${FLUX_TEST_MCP_LIVE_WORKFLOW:-0}" = 1 ]; then
  $compose run --rm -e FLUX_TEST_MCP_LIVE_WORKFLOW=1 -e FLUX_TEST_MCP_LIVE_CLIENT="${FLUX_TEST_MCP_LIVE_CLIENT:-}" -e FLUX_TEST_MCP_OAUTH_ONLY="${FLUX_TEST_MCP_OAUTH_ONLY:-0}" -e FLUX_TEST_MCP_OAUTH_COMPARE="${FLUX_TEST_MCP_OAUTH_COMPARE:-0}" -e FLUX_TEST_MCP_OAUTH_CALLBACK_DEFAULT="${FLUX_TEST_MCP_OAUTH_CALLBACK_DEFAULT:-0}" mcp-clients sh -c \
    'if [ "$FLUX_TEST_MCP_LIVE_CLIENT" != codex ]; then node apps/runtime/dist/install/main.js && claude --version || exit; fi; codex --version && sha256sum tests/app/e2e/mcp-live-workflow.e2e.ts tests/app/support/mcp-client-harness.ts tests/app/support/oauth-diagnostics.ts tests/app/support/cowork-production-invoke.ts && exec node_modules/.bin/tsx --test tests/app/e2e/mcp-live-workflow.e2e.ts'
  exit 0
fi
# The changed authenticated boundary is exercised through every maintained MCP domain/authority contract in both eras.
for protocol in 2026-07-28 2025-06-18; do
  $compose run --rm -e FLUX_TEST_MCP_PROTOCOL="$protocol" test sh -c 'exec node_modules/.bin/tsx --test --test-concurrency=1 tests/app/mcp*.test.ts tests/app/oauth-mcp.test.ts tests/app/agent-execution.test.ts tests/app/extension-contracts.test.ts'
done
# Both native modes use fresh homes. Delivery evidence alone is not full Start/Resume/recovery acceptance.
$compose run --rm mcp-clients
$compose run --rm -e FLUX_TEST_CODEX_MODERN=1 mcp-clients
# F-022 T5 (#280): the real Claude Code with the runtime's exact run argv and a run token (system/init read-back, FLUX_RUN_TOKEN).
$compose run --rm mcp-clients sh -c 'node apps/runtime/dist/install/main.js && exec node_modules/.bin/tsx --test tests/app/e2e/runtime-run-claude.e2e.ts'
