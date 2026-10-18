#!/bin/sh
# Keep one real client alive while recreating both isolated API processes (#228/#231).
set -eu
cd "$(dirname "$0")/.."
evidence="${1:-}"
case "$evidence" in /*) ;; *) echo "Usage: $0 /absolute/fresh/evidence/directory" >&2; exit 2 ;; esac
[ "$#" -eq 1 ] || exit 2
if [ -e "$evidence" ] && [ -n "$(ls -A "$evidence")" ]; then echo "The evidence directory must be new or empty" >&2; exit 2; fi
if [ -n "$(git status --porcelain)" ]; then echo "The restart run needs a clean, pinned checkout" >&2; exit 2; fi
mkdir -p "$evidence"
chmod 0700 "$evidence"
private=$(mktemp -d)
project="flux-live-restart-$(date +%s)-$$"
fixture="$project-client"
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-live-restart-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-live-restart-$$-$(date +%s)"
export FLUX_PORT="${FLUX_LIVE_EDITING_PORT:-18691}"
export FLUX_MAILPIT_PORT="${FLUX_LIVE_EDITING_MAILPIT_PORT:-18692}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:$FLUX_PORT"
export FLUX_AUTH_SECRET="auth-live-restart-$$-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_AUTH_RATE_LIMIT=false FLUX_SMTP_URL=smtp://mailpit:1025 FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
export FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY= FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE=
export FLUX_LIVE_SOURCE_SHA="$(git rev-parse HEAD)"
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.live-editing.test.yaml --profile test --profile two-api"
. scripts/test_images.sh
cleanup() {
  result=$?
  trap - EXIT
  docker logs "$fixture" > "$evidence/client.log" 2>&1 || true
  docker rm -f "$fixture" > "$evidence/cleanup.log" 2>&1 || true
  $compose down -v >> "$evidence/cleanup.log" 2>&1 || true
  remove_project_images >> "$evidence/cleanup.log" 2>&1 || true
  rm -rf "$private"
  printf '%s\n' "$result" > "$evidence/exit-code.txt"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
inventory() {
  python3 - "$evidence/$1.json" "$FLUX_LIVE_SOURCE_SHA" "$($compose ps -q api)" "$($compose ps -q api-two)" <<'PY'
import json, os, subprocess, sys
path, source, *ids = sys.argv[1:]
apis = []
for name, host, cid in [('api-one', 'api', ids[0]), ('api-two', 'api-two', ids[1])]:
    row = json.loads(subprocess.check_output(['docker', 'inspect', cid], timeout=10))[0]
    assert row['State']['Running'] and row['State']['Pid'] > 0
    assert 'FLUX_DEVELOPMENT_LIVE_EDITING=true' in row['Config']['Env']
    apis.append({'apiInstance': name, 'apiUrl': f'http://{host}:8080', 'containerId': row['Id'], 'imageId': row['Image']})
assert apis[0]['containerId'] != apis[1]['containerId']
assert apis[0]['imageId'] == apis[1]['imageId']
with open(path + '.tmp', 'x') as out:
    json.dump({'schema': 1, 'sourceSha': source, 'apis': apis}, out, indent=2)
    out.flush()
    os.fsync(out.fileno())
os.replace(path + '.tmp', path)
PY
}
sha256sum app/tests/app/live/restart.ts scripts/check_live_editing_restart.sh docker/compose.source.yaml docker/compose.live-editing.test.yaml app/pnpm-lock.yaml > "$evidence/source-sha256.txt"
$compose build migrate test > "$evidence/build.log" 2>&1
$compose up -d db migrate > "$evidence/startup.log" 2>&1
$compose --profile setup run --rm files-init >> "$evidence/startup.log" 2>&1
$compose up -d --wait api api-two >> "$evidence/startup.log" 2>&1
inventory before
$compose run -d --no-deps --name "$fixture" --user "$(id -u):$(id -g)" \
  -v "$evidence:/evidence:z,ro" -v "$private:/restart-state:z" \
  -e FLUX_LIVE_RESTART_TEST=1 -e FLUX_LIVE_SOURCE_SHA \
  -e FLUX_LIVE_RESTART_INVENTORY=/evidence/before.json \
  -e FLUX_LIVE_RESTART_AFTER_INVENTORY=/evidence/after.json \
  -e FLUX_LIVE_RESTART_STATE_DIR=/restart-state \
  test node_modules/.bin/tsx tests/app/live/restart.ts exercise > "$evidence/client-start.log" 2>&1
waited=0
until [ -f "$private/ready" ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$fixture")" != true ] || [ "$waited" -ge 40 ]; then
    echo "The surviving-client restart fixture did not become ready" >&2; exit 1
  fi
  sleep 1; waited=$((waited + 1))
done
$compose up -d --no-deps --force-recreate --wait api api-two > "$evidence/recreate.log" 2>&1
inventory after
docker wait "$fixture" > "$evidence/client-exit-code.txt"
docker inspect -f '{{json .State}}' "$fixture" > "$evidence/client-state.json"
[ "$(cat "$evidence/client-exit-code.txt")" -eq 0 ]
[ "$(git rev-parse HEAD)" = "$FLUX_LIVE_SOURCE_SHA" ]
[ -z "$(git status --porcelain)" ]
date -u +%Y-%m-%dT%H:%M:%SZ > "$evidence/finished.txt"
echo "Both APIs recreated; surviving replica renewal and unseen admission passed. Evidence: $evidence"
