#!/bin/sh
set -eu
cd "${FLUX_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-flux155taskpagesrepro}"
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD=typing-browser-isolated-155
export FLUX_FIXTURE_TOKEN=typing-browser-fixture-155
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_TEST_PERSONAL_RUNS=anthropic-mock
export FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
export FLUX_PORT="${FLUX_TEST_PORT:-23581}" FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-23585}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET=typing-browser-isolated-cookie-signing-secret-155
export FLUX_AUTH_RATE_LIMIT=false FLUX_STREAM_HEARTBEAT_MS=1000
export FLUX_SMTP_URL=smtp://mailpit:1025
export FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_UI_SCREENSHOT_DIR="${FLUX_UI_SCREENSHOT_DIR:-/tmp/flux155-task-pages-repro}"
mkdir -p "$FLUX_UI_SCREENSHOT_DIR"
case "$1" in
 prepare)
 docker compose -f docker/compose.source.yaml --profile ui --profile test build migrate ui-test test
 docker compose -f docker/compose.source.yaml --profile ui up -d db migrate mailpit
 docker compose -f docker/compose.source.yaml --profile setup run --rm files-init
 docker compose -f docker/compose.source.yaml --profile ui up -d --wait api worker anthropic-mock
 ;;
 ui)
 docker compose -f docker/compose.source.yaml --profile ui run --rm ui-test python3 -m unittest discover -s tests/ui -p test_typing.py -v
 ;;
 task-pages)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_pagination test_project_surface
 ;;
 read-client)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/work-read-client.test.ts tests/app/architecture.test.ts
 ;;
 read-native)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/work-read-query.test.ts tests/app/work-read-service.test.ts tests/app/work-read-keys.test.ts tests/app/work-read-native.test.ts tests/app/architecture.test.ts
 ;;
 read-bounded)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/work-read-query.test.ts tests/app/work-read-service.test.ts tests/app/work-read-keys.test.ts tests/app/architecture.test.ts
 ;;
 read-core)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/work-read-query.test.ts tests/app/work-read-service.test.ts tests/app/architecture.test.ts
 ;;
 api)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/typing-core.test.ts tests/app/typing-connection.test.ts tests/app/typing-access.test.ts tests/app/typing-socket.test.ts tests/app/typing-admission.test.ts tests/app/architecture.test.ts
 ;;
 account)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_typing.TypingJourney.test_07_reconnect_acknowledges_cookie_account_before_any_new_pulse
 ;;
 regression)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_direct_messages test_project_surface test_personal_assistant
 ;;
 draft-home)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_app_shell.AppShellJourney.test_02_register test_app_shell.AppShellJourney.test_03_sign_in_and_reload_keep_the_session test_app_shell.AppShellJourney.test_04a_draft_survives_view_switch_and_reload test_app_shell.AppShellJourney.test_04b_reading_position_is_kept_per_view
 ;;
 rebuild-ui)
 docker compose -f docker/compose.source.yaml --profile ui build ui-test
 ;;
 cleanup)
 docker compose -f docker/compose.source.yaml --profile ui --profile test down -v
 docker image rm "flux-foundation:${COMPOSE_PROJECT_NAME}" "flux-test-tools:${COMPOSE_PROJECT_NAME}" "flux-ui-tests:${COMPOSE_PROJECT_NAME}"
 ;;
 *) exit 2;;
esac
