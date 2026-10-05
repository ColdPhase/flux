#!/bin/sh
set -eu
cd /Users/maurycyzamojski/Dev/Projekty/flux/.worktrees/155-truthful-typing
export COMPOSE_PROJECT_NAME=flux155browser
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD=typing-browser-isolated-155
export FLUX_FIXTURE_TOKEN=typing-browser-fixture-155
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_TEST_PERSONAL_RUNS=anthropic-mock
export FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
export FLUX_PORT=18581 FLUX_MAILPIT_PORT=18585
export FLUX_PUBLIC_ORIGIN=http://127.0.0.1:18581
export FLUX_AUTH_SECRET=typing-browser-isolated-cookie-signing-secret-155
export FLUX_AUTH_RATE_LIMIT=false FLUX_STREAM_HEARTBEAT_MS=1000
export FLUX_SMTP_URL=smtp://mailpit:1025
export FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_UI_SCREENSHOT_DIR=/tmp/flux155-browser-evidence
mkdir -p "$FLUX_UI_SCREENSHOT_DIR"
case "$1" in
 details-correction)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_details test_work_decisions
 ;;
 details-focused)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_details
 ;;
 details-all)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_details test_work_overview test_project_surface test_work_associations test_work_decisions test_personal_assistant test_docs
 ;;
 overview-refresh)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_overview.OverviewWorkJourney.test_05_refresh_preserves_native_row_reading_focus_and_private_selection_then_failure_clears_rows
 ;;
 overview-focused)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_overview
 ;;
 overview-all)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_overview test_project_surface test_work_associations test_work_decisions test_personal_assistant
 ;;
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
 message-native-coverage)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_associations.MessageWorkJourney.test_07_restored_feed_observes_older_and_newer_native_batches test_work_associations.MessageWorkJourney.test_08_one_pagedown_gesture_keeps_scrolling_across_a_held_batch test_work_decisions.WorkDecisionsJourney.test_01_two_people_share_a_project test_work_decisions.WorkDecisionsJourney.test_07_more_than_a_hundred_records_remain_reachable_through_native_pages
 ;;
 message-lifecycle)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_associations.MessageWorkJourney.test_07_restored_feed_observes_older_and_newer_native_batches test_work_associations.MessageWorkJourney.test_08_one_pagedown_gesture_keeps_scrolling_across_a_held_batch
 ;;
 message-focused)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_associations
 ;;
 message-work)
 docker compose -f docker/compose.source.yaml --profile ui run --rm -e PYTHONPATH=tests/ui ui-test python3 -m unittest -v test_work_associations test_project_surface test_work_decisions test_personal_assistant
 ;;
 message-client)
 docker compose -f docker/compose.source.yaml --profile test run --rm test pnpm exec tsx --test tests/app/work-read-client.test.ts tests/app/message-associations.test.ts tests/app/architecture.test.ts
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
 docker image rm flux-foundation:flux155browser flux-test-tools:flux155browser flux-ui-tests:flux155browser
 ;;
 *) exit 2;;
esac
