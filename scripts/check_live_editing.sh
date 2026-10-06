#!/bin/sh
# TEST ONLY (#228): the enabled live map/wiki candidate in its own Compose project.
#
#   ./scripts/check_live_editing.sh [module ...]
#       Live-mode browser modules (default: test_live_editing test_live_map_projection
#       test_live_map_selection) against an API with the development switch on.
#   ./scripts/check_live_editing.sh --latency /absolute/fresh/evidence/dir
#       The Gate 4 latency driver (app/tests/ui/live_editing_latency.py, nine cohorts) with the
#       bounded queue collector, inventory, runtime metadata, producer stop and seal described in
#       docs/development/live-editing-verification.md. Needs a clean checkout: the source SHA
#       pins the evidence.
#
# Live editing is off in every other stack. Ports: FLUX_LIVE_EDITING_PORT (default 18691) and
# FLUX_LIVE_EDITING_MAILPIT_PORT (default 18692). Run it alone, like the other Docker checks.
set -eu

cd "$(dirname "$0")/.."
latency=""
if [ "${1:-}" = "--latency" ]; then
  latency="${2:-}"
  case "$latency" in /*) ;; *) echo "--latency needs an absolute evidence directory" >&2; exit 2 ;; esac
  if [ -e "$latency" ] && [ -n "$(ls -A "$latency")" ]; then echo "The evidence directory must be new or empty" >&2; exit 2; fi
  if [ -n "$(git status --porcelain)" ]; then echo "The latency run needs a clean checkout: its source SHA pins the evidence" >&2; exit 2; fi
  shift 2
fi
project="flux-live-editing-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-live-editing-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-live-editing-$$-$(date +%s)"
export FLUX_PORT="${FLUX_LIVE_EDITING_PORT:-18691}"
export FLUX_MAILPIT_PORT="${FLUX_LIVE_EDITING_MAILPIT_PORT:-18692}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-live-editing-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_AUTH_RATE_LIMIT=false
# Push is not part of this check; never inherit a developer's docker/.env keys.
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
if [ -n "$latency" ]; then
  export FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY=1 FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE=api-one
else
  export FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY= FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE=
fi
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.live-editing.test.yaml --profile ui"
collector=""

cleanup() {
  status=$?
  if [ -n "$collector" ] && kill -0 "$collector" 2>/dev/null; then kill "$collector" 2>/dev/null || true; wait "$collector" 2>/dev/null || true; fi
  if [ "$status" -ne 0 ] && [ -z "$latency" ]; then $compose logs --no-color --tail 300 api || true; fi
  if [ -n "$latency" ]; then $compose logs --no-color --timestamps api > "$latency/api.log" 2>&1 || true; fi
  $compose down -v >/dev/null 2>&1 || true
  remove_project_images
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

$compose build migrate ui-test
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api

if [ -z "$latency" ]; then
  [ "$#" -gt 0 ] || set -- test_live_editing test_live_map_projection test_live_map_selection
  $compose run --rm --no-deps -e FLUX_LIVE_EDITING_TEST=1 -w /work/tests/ui ui-test python3 -m unittest -v "$@"
  exit 0
fi

mkdir -p "$latency"
chmod 0700 "$latency"
source_sha=$(git rev-parse HEAD)
python3 scripts/prepare_live_editing_latency.py "$latency" --source-sha "$source_sha" \
  --api "$($compose ps -q api)" --db "$($compose ps -q db)" --db-user "$POSTGRES_USER" --db-name "$POSTGRES_DB"
python3 scripts/collect_live_editing_queue.py "$latency" "$latency/queue-inventory.json" --timeout 1500 > "$latency/collector.log" 2>&1 &
collector=$!
waited=0
until [ -f "$latency/collector-ready.json" ]; do
  if ! kill -0 "$collector" 2>/dev/null || [ "$waited" -ge 30 ]; then echo "The queue collector did not become ready" >&2; exit 1; fi
  sleep 1; waited=$((waited + 1))
done
# The driver runs as this user so the collector can read its 0600 handoffs, and the reverse.
driver=0
$compose run --rm --no-deps --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$latency:/evidence:z" \
  -e FLUX_LIVE_EDITING_TEST=1 -e FLUX_LIVE_SOURCE_SHA="$source_sha" -e FLUX_LIVE_EVIDENCE=/evidence \
  -e FLUX_LIVE_RUNTIME_METADATA=/evidence/runtime.json -w /work/tests/ui ui-test python3 live_editing_latency.py \
  > "$latency/driver.log" 2>&1 || driver=$?
collected=0
wait "$collector" || collected=$?
collector=""
echo "driver exit $driver, collector exit $collected; evidence in $latency"
[ "$driver" -eq 0 ] && [ "$collected" -eq 0 ]
