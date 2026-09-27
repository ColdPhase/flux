#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
project="flux-test-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_PORT=18089

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose -p "$project" -f infra/compose.yaml --profile test logs --no-color db migrate test || true
  fi
  docker compose -p "$project" -f infra/compose.yaml --profile test down -v
}
trap cleanup EXIT HUP INT TERM

docker compose -p "$project" -f infra/compose.yaml --profile test run --build --rm test
