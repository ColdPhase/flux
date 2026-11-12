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
#   FLUX_PERF_PHASES     which phases to run (default: count warm concurrent limited bundle plans cold profile; `restart` alone times
#                        the API's restarts)
#   FLUX_PERF_CPUS       the CPU-limited phase's cap for the API and the database each (default 1.0, so the pair stands for a
#                        2 vCPU host; #850 AC-3, #862). The phase repeats the warm and concurrent runs under it, and the report holds
#                        them to the targets (p95 at most 50 ms).
#   FLUX_PERF_ENFORCE=1  exit 1 when a CPU-limited phase misses the p95 target (it is printed as FAIL either way; #1023). Only 1 or true
#                        turns it on: 0, false or empty leave it off.
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
phases=" ${FLUX_PERF_PHASES:-count warm concurrent limited bundle plans cold profile} "
phase() { case "$phases" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
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
compose="docker compose --env-file /dev/null -p $project -f docker/compose.source.yaml -f docker/compose.perf.yaml"
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
# What was measured: the scripts' commit, and the image (built here from it, or given).
{ echo "scripts $(git rev-parse HEAD 2>/dev/null || echo unknown)$(git diff --quiet HEAD 2>/dev/null || echo ' (with uncommitted changes)')"
  echo "image flux-foundation:${FLUX_IMAGE_TAG:-$project}$( [ -n "${FLUX_PERF_IMAGE_TAG:-}" ] && echo ' (prebuilt, see FLUX_PERF_IMAGE_TAG)' || echo ' (built from the scripts commit)')"
} > "$out/commit.txt"

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

# pg-boss sweeps each queue's old jobs once a day (about 20 statements a queue), first on the worker's first pass 60 s after it starts on a
# new database. That daily pass is not what an idle minute costs, but a seed that ends before it put it in the minute below (#1178: 315
# statements, 97 without it). Wait until it has claimed every queue, then for it to finish.
waited=0
while [ "$(psql -c 'SELECT count(*) FROM pgboss.queue WHERE maintain_on IS NULL')" != 0 ] && [ "$waited" -lt 150 ]; do sleep 2; waited=$((waited + 2)); done
sleep 5
# What the worker runs while idle (queue polling), before it is stopped for the request numbers.
psql -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null
psql -c 'SELECT pg_stat_statements_reset()' >/dev/null
# CPU the three services use while idle, from each container's cgroup (microseconds of CPU time, summed over its threads).
cpu_usec() { $compose exec -T "$1" sh -c 'cat /sys/fs/cgroup/cpu.stat' 2>/dev/null | awk '/^usage_usec/ { print $2 }'; }
cpu_before="$(cpu_usec api) $(cpu_usec worker) $(cpu_usec db)"
sleep 60
cpu_after="$(cpu_usec api) $(cpu_usec worker) $(cpu_usec db)"
psql -c "SELECT calls, round(total_exec_time::numeric, 1), left(regexp_replace(query, '\s+', ' ', 'g'), 160)
  FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY calls DESC, total_exec_time DESC LIMIT 40" > "$out/idle-60s.txt"
# #862: at most 100 statements a minute at idle (the worker running, nobody signed in): the minute above, so every 30 s poll is counted twice.
psql -c "SELECT 'Idle database: ' || coalesce(sum(calls), 0) || ' statements a minute over 60 s with the worker running (target at most 100)'
  FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'" | tee "$out/idle.txt"
# #862: at most 2% of one core at idle, all three together (nobody signed in; the worker's queue polling and the API's heartbeat).
echo "$cpu_before $cpu_after" | awk '{ if (NF == 6 && $1 != "") { api = ($4 - $1) / 60000000 * 100; worker = ($5 - $2) / 60000000 * 100; db = ($6 - $3) / 60000000 * 100;
  printf "Idle CPU over 60 s: api %.2f%%, worker %.2f%%, database %.2f%% of one core, %.2f%% together (target at most 2%%)\n", api, worker, db, api + worker + db } else print "Idle CPU: the cgroup counters could not be read" }' | tee -a "$out/idle.txt"
if [ "$waited" -lt 150 ]; then echo "Idle minute taken after pg-boss's daily queue sweep (waited ${waited} s for it)"; else echo "Idle minute taken with pg-boss's daily queue sweep still due after 150 s"; fi | tee -a "$out/idle.txt"
$compose stop worker

# Sign in and read the views' ids once; every later run reuses those sessions and ids.
$compose exec -T -e FLUX_PERF_PASSWORD="$perf_password" -e FLUX_PERF_MODE=prepare api node --input-type=module - \
  < scripts/perf-measure.mjs > "$out/state.jsonl"
perf_state=$(sed -n 's/^{"type":"state",/{/p' "$out/state.jsonl")
[ -n "$perf_state" ] || { echo "The measurement could not sign in or find the seeded views" >&2; exit 1; }
if phase count; then
  echo "Statement counts and isolated times (owner, then member)..."
  measure -e FLUX_PERF_MODE=count -e FLUX_PERF_PERSON=0
  measure -e FLUX_PERF_MODE=count -e FLUX_PERF_PERSON=1
fi
if phase warm; then
  echo "Warm runs ($runs per view, owner, then member)..."
  measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=0
  measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=1
fi
if phase concurrent; then
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
fi

# The same runs again with the API and the database each held to FLUX_PERF_CPUS (docker update, live), so a 2 vCPU host's
# queueing shows (#850 AC-3): the numbers the targets are judged on.
if phase limited; then
  cpus="${FLUX_PERF_CPUS:-1.0}"
  echo "CPU-limited runs (API and database at $cpus CPU each)..."
  limited_ids=$($compose ps -q api db)
  docker update --cpus "$cpus" $limited_ids >/dev/null
  for who in 0 1; do measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=$who -e "FLUX_PERF_SUFFIX= @$cpus cpu"; done
  measure -e FLUX_PERF_MODE=concurrent -e FLUX_PERF_CLIENTS=2 -e "FLUX_PERF_SUFFIX= @$cpus cpu"
  docker update --cpus 0 $limited_ids >/dev/null
fi

# What the first screen downloads and the service worker precaches (#850 AC-4): the built app's files, from inside the API image.
if phase bundle; then
  echo "First-screen code..."
  $compose exec -T api node --input-type=module - < scripts/perf-bundle.mjs | tee "$out/bundle.txt"
fi

# Plans: auto_explain logs every statement (EXPLAIN ANALYZE, BUFFERS) of one pass per person.
if phase plans; then
  echo "Plans..."
  psql -c "ALTER SYSTEM SET auto_explain.log_min_duration = 0" -c "ALTER SYSTEM SET auto_explain.log_analyze = on" \
    -c "ALTER SYSTEM SET auto_explain.log_buffers = on" -c "SELECT pg_reload_conf()" >/dev/null
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  measure -e FLUX_PERF_MODE=once
  psql -c "ALTER SYSTEM RESET auto_explain.log_min_duration" -c "ALTER SYSTEM RESET auto_explain.log_analyze" \
    -c "ALTER SYSTEM RESET auto_explain.log_buffers" -c "SELECT pg_reload_conf()" >/dev/null
  $compose logs --no-color --no-log-prefix --since "$since" db > "$out/plans.log"
fi

# Only the restart times, without the passes between them (about 3 minutes with the seeding): `FLUX_PERF_PHASES=restart`.
if phase restart; then
  echo "API restarts (${FLUX_PERF_RESTARTS:-8})..."
  : > "$out/restart-api-ms.txt"
  i=0
  while [ "$i" -lt "${FLUX_PERF_RESTARTS:-8}" ]; do
    api_started=$(date +%s%N)
    $compose restart api >/dev/null
    $compose up -d --wait api >/dev/null
    echo $((($(date +%s%N) - api_started) / 1000000)) >> "$out/restart-api-ms.txt"
    i=$((i + 1))
  done
  sort -n "$out/restart-api-ms.txt" | awk '{ v[NR] = $1 } END { if (NR) printf "Restart of the API to healthy: median %d ms, slowest %d ms over %d restarts (target at most 5000 ms)\n", v[int((NR + 1) / 2)], v[NR], NR }' | tee "$out/restart.txt"
fi

if phase cold; then
  echo "Cold passes ($cold per person, each after restarting PostgreSQL and the API)..."
  i=0
  : > "$out/restart-ms.txt"
  : > "$out/restart-api-ms.txt"
  while [ "$i" -lt $((cold * 2)) ]; do
    restart_started=$(date +%s%N)
    $compose restart db >/dev/null
    $compose up -d --wait db >/dev/null
    api_started=$(date +%s%N)
    $compose restart api >/dev/null
    $compose up -d --wait api >/dev/null
    now=$(date +%s%N)
    echo $(((now - restart_started) / 1000000)) >> "$out/restart-ms.txt"
    echo $(((now - api_started) / 1000000)) >> "$out/restart-api-ms.txt"
    measure -e FLUX_PERF_MODE=pass -e FLUX_PERF_FIRST=$((i / 2)) -e FLUX_PERF_PERSON=$((i % 2))
    i=$((i + 1))
  done
  # #862: restart to healthy at most 5 s: the API alone, and the database and then the API as an upgrade does.
  sort -n "$out/restart-api-ms.txt" | awk '{ v[NR] = $1 } END { if (NR) printf "Restart of the API to healthy: median %d ms, slowest %d ms over %d restarts (target at most 5000 ms)\n", v[int((NR + 1) / 2)], v[NR], NR }' | tee "$out/restart.txt"
  sort -n "$out/restart-ms.txt" | awk '{ v[NR] = $1 } END { if (NR) printf "Restart of the database and then the API to healthy, as an upgrade does: median %d ms, slowest %d ms\n", v[int((NR + 1) / 2)], v[NR] }' | tee -a "$out/restart.txt"
fi
$compose logs --no-color --no-log-prefix api > "$out/api.log"

# CPU profile of the API over two warm passes per person (sampling adds overhead, so it is not timed).
if phase profile; then
  echo "CPU profile..."
  FLUX_PERF_NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/flux-prof --import=data:text/javascript,process.on(%22SIGTERM%22,()=%3Eprocess.exit(0))" \
    $compose up -d --wait api >/dev/null
  measure -e FLUX_PERF_MODE=once
  measure -e FLUX_PERF_MODE=once
  $compose stop api >/dev/null
  $compose cp api:/tmp/flux-prof "$out/profile" >/dev/null 2>&1 || echo "No CPU profile was written" >&2
fi

report_status=0
case "${FLUX_PERF_ENFORCE:-}" in 1|true) enforce=--fail-on-targets ;; *) enforce= ;; esac
if [ -s "$out/measure.jsonl" ]; then
  python3 scripts/perf_report.py "$out/measure.jsonl" "$out/api.log" --json "$out/report.json" --targets $enforce > "$out/report.md" || report_status=$?
  cat "$out/report.md"
else : > "$out/report.md"; fi
for extra in idle.txt bundle.txt restart.txt; do
  if [ -f "$out/$extra" ]; then printf '\n' >> "$out/report.md"; cat "$out/$extra" >> "$out/report.md"; fi
done
if [ -f "$out/pool-samples.txt" ]; then
  awk -F'|' 'NF >= 3 { if ($1 + 0 > max) max = $1 + 0 } END { print "Most API connections seen at once: " max + 0 " (pool max 10)" }' "$out/pool-samples.txt" | tee -a "$out/report.md"
fi
echo "Results: $out"
if [ "$report_status" != 0 ]; then echo "A CPU-limited phase missed the p95 target of 50 ms (FLUX_PERF_ENFORCE=1)" >&2; exit "$report_status"; fi
