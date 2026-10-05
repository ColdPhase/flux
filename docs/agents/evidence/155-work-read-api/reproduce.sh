#!/bin/sh
set -eu
cd "${FLUX_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-flux155apirepro}"
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD=typing-browser-isolated-155
export FLUX_FIXTURE_TOKEN=typing-browser-fixture-155
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_TEST_PERSONAL_RUNS=anthropic-mock
export FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
export FLUX_PORT="${FLUX_TEST_PORT:-21581}" FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-21585}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET=typing-browser-isolated-cookie-signing-secret-155
export FLUX_AUTH_RATE_LIMIT=false FLUX_STREAM_HEARTBEAT_MS=1000
export FLUX_SMTP_URL=smtp://mailpit:1025
export FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_UI_SCREENSHOT_DIR="${FLUX_UI_SCREENSHOT_DIR:-/tmp/flux155-api-repro}"
mkdir -p "$FLUX_UI_SCREENSHOT_DIR"
case "$1" in
 prepare)
 docker compose -f docker/compose.source.yaml --profile ui --profile test build migrate ui-test test
 docker compose -f docker/compose.source.yaml --profile ui up -d db migrate mailpit
 docker compose -f docker/compose.source.yaml --profile setup run --rm files-init
 docker compose -f docker/compose.source.yaml --profile ui up -d --wait api worker anthropic-mock
 ;;
 bounded)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/work-read-query.test.ts tests/app/work-read-service.test.ts tests/app/work-read-keys.test.ts tests/app/work-read-native.test.ts tests/app/architecture.test.ts
 ;;
 cleanup)
 docker compose -f docker/compose.source.yaml --profile ui --profile test down -v
 docker image rm "flux-foundation:${COMPOSE_PROJECT_NAME}" "flux-test-tools:${COMPOSE_PROJECT_NAME}" "flux-ui-tests:${COMPOSE_PROJECT_NAME}"
 ;;
 *) exit 2;;
esac
