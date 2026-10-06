#!/bin/sh
set -eu
cd /Users/maurycyzamojski/Dev/Projekty/flux/.worktrees/155-truthful-typing
project=flux155-reference-rows-v1
export COMPOSE_PROJECT_NAME=$project FLUX_IMAGE_TAG=$project
export POSTGRES_USER=flux POSTGRES_DB=flux POSTGRES_PASSWORD=reference-rows-disposable-db
export FLUX_FIXTURE_TOKEN=reference-rows-disposable-fixture
export FLUX_PORT=18631 FLUX_MAILPIT_PORT=18632 FLUX_PUBLIC_ORIGIN=http://127.0.0.1:18631
export FLUX_AUTH_SECRET=reference-rows-disposable-auth-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
export FLUX_SMTP_URL=smtp://mailpit:1025 FLUX_MAIL_FROM='Flux <flux@example.test>' FLUX_AUTH_RATE_LIMIT=false
export FLUX_TEST_FAILURE_INJECTION=true FLUX_TEST_PERSONAL_RUNS=anthropic-mock FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
export FLUX_GIT_COMMIT=$(git rev-parse HEAD)
compose() { docker compose -p "$project" -f docker/compose.source.yaml --profile test --profile ui "$@"; }
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then compose logs --no-color api worker migrate > /tmp/flux155-reference-rows-failure-services.log 2>&1 || true; fi
  compose down -v
  exit "$result"
}
trap cleanup EXIT
compose build migrate test
compose up -d db migrate
compose --profile setup run --rm files-init
compose run --rm test pnpm exec tsx --test --test-concurrency=1 tests/app/work-read-query.test.ts tests/app/work-read-service.test.ts tests/app/work-read-native.test.ts tests/app/work-reference-rows-native.test.ts tests/app/architecture.test.ts
