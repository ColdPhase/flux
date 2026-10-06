#!/bin/sh
# Server performance measurement (#298): a production-mode stack (compose.source.yaml with the
# measurement-only compose.perf.yaml overlay), seeded through the public API by
# scripts/perf-seed.mjs, then measured by scripts/perf-measure.mjs and summarised by
# scripts/perf_report.py. See docs/development/performance-2026-10.md for the method and results.
#
# Environment:
#   FLUX_PERF_PORT       published API port (default 18298)
#   FLUX_PERF_OUT        absolute output directory (default ./perf-results/<UTC time>)
#   FLUX_PERF_RUNS       warm and concurrent runs per view (default 20)
#   FLUX_PERF_COLD       cold passes, each after restarting PostgreSQL and the API (default 20)
#   FLUX_PERF_IMAGE_TAG  reuse an already built flux-foundation:<tag> image instead of building
#   FLUX_PERF_KEEP=1     leave the stack and its volumes running afterwards (remove them yourself)
# Runs at most two clients at a time; keep it to one run at a time on a shared host.
set -eu

cd "$(dirname "$0")/.."
root=$(pwd -P)
project="flux-perf-$(date +%s)-$$"
port="${FLUX_PERF_PORT:-18298}"
out="${FLUX_PERF_OUT:-$root/perf-results/$(date -u +%Y%m%dT%H%M%SZ)}"
case "$out" in /*) ;; *) echo "FLUX_PERF_OUT must be absolute" >&2; exit 1 ;; esac
runs="${FLUX_PERF_RUNS:-20}"
cold="${FLUX_PERF_COLD:-20}"
mkdir -p "$out"

export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-perf-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-perf-$$-$(date +%s)"
export FLUX_PORT="$port"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:$port"
export FLUX_AUTH_SECRET="auth-perf-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
# The seed and the measurement sign in several times from one address.
export FLUX_AUTH_RATE_LIMIT=false
# No push, mail, live media or background comparisons: the request paths only.
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT= FLUX_SMTP_URL= FLUX_MAIL_FROM=
perf_password="perf-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
if [ -n "${FLUX_PERF_IMAGE_TAG:-}" ]; then export FLUX_IMAGE_TAG="$FLUX_PERF_IMAGE_TAG"; fi
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.perf.yaml"
. scripts/test_images.sh

cleanup() {
  status=$?
  [ -s "$out/api.log" ] || $compose logs --no-color --no-log-prefix api > "$out/api.log" 2>/dev/null || true
  if [ "${FLUX_PERF_KEEP:-}" = 1 ]; then
    echo "FLUX_PERF_KEEP=1: stack $project is still running" >&2
  else
    $compose down -v >/dev/null 2>&1 || true
    if [ -z "${FLUX_PERF_IMAGE_TAG:-}" ]; then remove_project_images; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

psql() { $compose exec -T db psql -U flux -d flux -v ON_ERROR_STOP=1 -tA "$@"; }
measure() {
  $compose exec -T -e NODE_OPTIONS= -e FLUX_PERF_PASSWORD="$perf_password" -e FLUX_PERF_RUNS="$runs" -e FLUX_PERF_STATE="${perf_state:-}" "$@" \
    api node --input-type=module - < scripts/perf-measure.mjs >> "$out/measure.jsonl"
}

if [ -z "${FLUX_PERF_IMAGE_TAG:-}" ]; then $compose build migrate; fi
$compose up -d db migrate
$compose --profile setup run --rm files-init >/dev/null
$compose up -d --wait api worker
git rev-parse HEAD > "$out/commit.txt" 2>/dev/null || true

echo "Seeding through the public API (a few minutes)..."
$compose exec -T -e FLUX_PERF_PASSWORD="$perf_password" api node --input-type=module - < scripts/perf-seed.mjs | tee "$out/seed.log"

# The worker turns committed events into notifications; wait until the count stops changing.
previous=-1
stable=0
while [ "$stable" -lt 3 ]; do
  sleep 3
  current=$(psql -c 'SELECT count(*) FROM notifications')
  if [ "$current" = "$previous" ]; then stable=$((stable + 1)); else stable=0; fi
  previous=$current
done
psql -c "SELECT 'messages', count(*) FROM project_messages UNION ALL SELECT 'conversations', count(*) FROM project_conversations
  UNION ALL SELECT 'tasks', count(*) FROM project_work_items UNION ALL SELECT 'thoughts', count(*) FROM sketch_thoughts
  UNION ALL SELECT 'docs', count(*) FROM project_materials WHERE kind = 'doc'
  UNION ALL SELECT 'doc versions', count(*) FROM project_material_versions v JOIN project_materials m ON m.id = v.material_id WHERE m.kind = 'doc'
  UNION ALL SELECT 'notifications ' || u.name, count(*) FROM notifications n JOIN auth_users u ON u.id = n.user_id GROUP BY u.name
  UNION ALL SELECT 'events', count(*) FROM events UNION ALL SELECT 'event audience rows', count(*) FROM event_audience
  UNION ALL SELECT 'search documents', count(*) FROM search_documents" | tee "$out/volume.txt"

# What the worker runs while idle (queue polling), before it is stopped for the request numbers.
psql -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null
psql -c 'SELECT pg_stat_statements_reset()' >/dev/null
sleep 30
psql -c "SELECT calls, round(total_exec_time::numeric, 1), left(regexp_replace(query, '\s+', ' ', 'g'), 160)
  FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 15" > "$out/idle-30s.txt"
$compose stop worker

# Sign in and read the views' ids once; every later run reuses those sessions and ids.
$compose exec -T -e FLUX_PERF_PASSWORD="$perf_password" -e FLUX_PERF_MODE=prepare api node --input-type=module - \
  < scripts/perf-measure.mjs > "$out/state.jsonl"
perf_state=$(sed -n 's/^{"type":"state",/{/p' "$out/state.jsonl")
[ -n "$perf_state" ] || { echo "The measurement could not sign in or find the seeded views" >&2; exit 1; }
echo "Statement counts and isolated times (owner, then member)..."
measure -e FLUX_PERF_MODE=count -e FLUX_PERF_PERSON=0
measure -e FLUX_PERF_MODE=count -e FLUX_PERF_PERSON=1
echo "Warm runs ($runs per view, owner, then member)..."
measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=0
measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=1
echo "Two clients at once ($runs runs each)..."
# Pool use: API connections to PostgreSQL by state, sampled while both clients run.
( while [ ! -f "$out/.concurrent-done" ]; do
    psql -c "SELECT count(*), count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state LIKE 'idle in transaction%')
      FROM pg_stat_activity WHERE datname = 'flux' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
      AND application_name NOT IN ('psql', 'pgboss') AND query NOT LIKE 'LISTEN%'" 2>/dev/null || true
  done > "$out/pool-samples.txt" ) &
sampler=$!
measure -e FLUX_PERF_MODE=concurrent -e FLUX_PERF_CLIENTS=2
touch "$out/.concurrent-done"
wait "$sampler" || true
rm -f "$out/.concurrent-done"

# Plans: auto_explain logs every statement of one pass per person that runs 2 ms or longer.
psql -c "ALTER SYSTEM SET auto_explain.log_min_duration = '2ms'" -c "ALTER SYSTEM SET auto_explain.log_analyze = on" \
  -c "ALTER SYSTEM SET auto_explain.log_buffers = on" -c "SELECT pg_reload_conf()" >/dev/null
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
measure -e FLUX_PERF_MODE=once
psql -c "ALTER SYSTEM RESET auto_explain.log_min_duration" -c "ALTER SYSTEM RESET auto_explain.log_analyze" \
  -c "ALTER SYSTEM RESET auto_explain.log_buffers" -c "SELECT pg_reload_conf()" >/dev/null
$compose logs --no-color --no-log-prefix --since "$since" db > "$out/plans.log"

echo "Cold passes ($cold per person, each after restarting PostgreSQL and the API)..."
i=0
while [ "$i" -lt $((cold * 2)) ]; do
  $compose restart db >/dev/null
  $compose up -d --wait db >/dev/null
  $compose restart api >/dev/null
  $compose up -d --wait api >/dev/null
  measure -e FLUX_PERF_MODE=pass -e FLUX_PERF_FIRST=$((i / 2)) -e FLUX_PERF_PERSON=$((i % 2))
  i=$((i + 1))
done
$compose logs --no-color --no-log-prefix api > "$out/api.log"

# CPU profile of the API over two warm passes per person (sampling adds overhead, so it is not timed).
if [ "${FLUX_PERF_PROFILE:-1}" = 1 ]; then
  echo "CPU profile..."
  FLUX_PERF_NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/flux-prof --import=data:text/javascript,process.on(%22SIGTERM%22,()=%3Eprocess.exit(0))" \
    $compose up -d --wait api >/dev/null
  measure -e FLUX_PERF_MODE=once
  measure -e FLUX_PERF_MODE=once
  $compose stop api >/dev/null
  $compose cp api:/tmp/flux-prof "$out/profile" >/dev/null 2>&1 || echo "No CPU profile was written" >&2
fi

python3 scripts/perf_report.py "$out/measure.jsonl" "$out/api.log" --json "$out/report.json" | tee "$out/report.md"
awk -F'|' 'NF >= 3 { if ($1 + 0 > max) max = $1 + 0 } END { print "Most API connections seen at once: " max + 0 " (pool max 10)" }' "$out/pool-samples.txt" | tee -a "$out/report.md"
echo "Results: $out"
