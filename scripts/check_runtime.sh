#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
project="flux-runtime-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-runtime-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-runtime-$$-$(date +%s)"
export FLUX_PORT="${FLUX_RUNTIME_TEST_PORT:-18090}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-runtime-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_TEST_FAILURE_INJECTION=false
. scripts/test_images.sh
compose="docker compose -p $project -f infra/compose.yaml"
response="$(mktemp)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color db migrate files-init api worker || true
  fi
  $compose down -v || true
  remove_project_images
  rm -f "$response"
}
trap cleanup EXIT HUP INT TERM

$compose up -d --build db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker

# The failure header cannot trigger rollback in a normal API deployment.
status=$(curl -sS -o "$response" -w '%{http_code}' \
  -H "Authorization: Bearer $FLUX_FIXTURE_TOKEN" \
  -H 'Content-Type: application/json' -H 'X-Flux-Test-Failure: after-insert' \
  -d '{"title":"normal deployment sample"}' \
  "http://127.0.0.1:${FLUX_PORT}/api/v1/integration/sample")
[ "$status" = 201 ] || { cat "$response"; echo "Expected fixture success, got $status" >&2; exit 1; }
status=$(curl -sS -o "$response" -w '%{http_code}' \
  -H "Authorization: Bearer $FLUX_FIXTURE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"rejected command flag","failAfterInsert":true}' \
  "http://127.0.0.1:${FLUX_PORT}/api/v1/integration/sample")
[ "$status" = 400 ] || { cat "$response"; echo "Expected public command rejection, got $status" >&2; exit 1; }

attempt=0
while :; do
  result=$($compose exec -T db psql -U flux -d flux -tA -c \
    "SELECT count(*) FROM samples s JOIN sample_results r ON r.sample_id=s.id WHERE s.title='normal deployment sample'")
  [ "$result" = 1 ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo 'Worker did not process the sample' >&2; exit 1; }
  sleep 1
done

$compose stop api worker
$compose run --rm migrate
$compose up -d --wait api worker
result=$($compose exec -T db psql -U flux -d flux -tA -c \
  "SELECT count(*) FROM samples s JOIN sample_results r ON r.sample_id=s.id WHERE s.title='normal deployment sample'")
[ "$result" = 1 ] || { echo 'Sample/result lost across stop, migration and restart' >&2; exit 1; }

echo 'Runtime check passed: normal failure flag forbidden, worker result, migration and stop/start persistence.'
