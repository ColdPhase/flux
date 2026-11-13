#!/bin/sh
# Did Flux get slower? Two refs measured back to back on one host (#1191, v0.2.1 "faster on 2 vCPU"):
#
#   scripts/perf_compare.sh <base-ref> <head-ref>        e.g. scripts/perf_compare.sh v0.2.0 origin/main
#
# Each ref is checked out into its own worktree and built into its own production-mode stack (its own compose.source.yaml with
# the measurement overlay compose.perf.yaml, as scripts/check_performance.sh runs it), seeded once by scripts/perf-seed.mjs. Then
# FLUX_PERF_COMPARE_ROUNDS rounds (default 3) measure base, head, base, head... so whatever the host does meanwhile falls on both.
# The measuring scripts are this checkout's (perf-measure.mjs, perf-compare-extra.mjs, perf-compare-browser.py), the same for both.
#
# CPU (a 2 vCPU host): the database, the API and the worker of both stacks share CPUs 0 and 1 (cpuset); the measuring clients and
# the browser run on CPUs 2 and 3, so they never take the server's CPU. The `1.0 cpu` phases also hold the API and the database
# to 1.0 CPU each (docker update --cpus), the CPU-limited phase of check_performance.sh (#850 AC-3, #862). A host with fewer than
# 4 CPUs still runs, without the separation (the summary says so).
#
# Per round and ref:
#   idle       60 s with the worker running and nobody signed in: statements, CPU of api/worker/db, memory (worker stopped after)
#   count      statements each distinct request sends (pg_stat_statements), owner
#   2vcpu      warm (owner) and two concurrent clients, FLUX_PERF_RUNS passes each (default 20), memory sampled meanwhile
#   1cpu       warm (owner), warm (member) and concurrent with the API and the database at 1.0 CPU each
#   search     people's search over several queries, and the agents' flux_search where the ref has it, at 2 vCPU and at 1.0 CPU
#   browser    cold first visits in Chromium (JS/CSS bytes, time to a usable Home) and the move into a space's Conversation
#              (requests, statements, time until its messages show), FLUX_PERF_BROWSER_LOADS times (default 3)
# Once per ref: the first-screen bundle (perf-bundle.mjs) and the worker's memory while the seed's notifications are generated.
#
# Environment: FLUX_PERF_COMPARE_OUT (absolute output directory, default ./perf-results/compare-<UTC time>), FLUX_PERF_COMPARE_WORK
# (worktrees and the browser's venv, removed afterwards), FLUX_PERF_COMPARE_PORT (base's API port, head's is the next), FLUX_PERF_COMPARE_ROUNDS,
# FLUX_PERF_RUNS, FLUX_PERF_BROWSER_LOADS, FLUX_PERF_SEARCH_RUNS (default 15), FLUX_PERF_BROWSER_PYTHON (a Python with Playwright
# and Chromium on the host; default: the head's Playwright image, docker/ui-tests.Dockerfile).
# The report: <out>/compare.md (also printed, its lines start with "PERF "), and <out>/compare.json.
# Run it alone: on a shared host the numbers include whatever else the machine does. On GitHub: test-modules.yml, suite `perf`.
set -eu

[ "$#" -eq 2 ] || { sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2; exit 2; }
cd "$(dirname "$0")/.."
root=$(pwd -P)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="${FLUX_PERF_COMPARE_OUT:-$root/perf-results/compare-$stamp}"
case "$out" in /*) ;; *) echo "FLUX_PERF_COMPARE_OUT must be absolute" >&2; exit 1 ;; esac
rounds="${FLUX_PERF_COMPARE_ROUNDS:-3}"
runs="${FLUX_PERF_RUNS:-20}"
loads="${FLUX_PERF_BROWSER_LOADS:-3}"
search_runs="${FLUX_PERF_SEARCH_RUNS:-15}"
work="${FLUX_PERF_COMPARE_WORK:-$root/.perf-compare-work-$$}"
mkdir -p "$out" "$work"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# --- The two refs, each in a worktree of its own -------------------------------------------------------------------------------
resolve() {
  if sha=$(git rev-parse --verify -q "$1^{commit}"); then echo "$sha"; return; fi
  git fetch -q --depth 1 origin "$1" && git rev-parse --verify "FETCH_HEAD^{commit}"
}
sha_a=$(resolve "$1")
sha_b=$(resolve "$2")
dir_a="$work/a"
dir_b="$work/b"
git worktree add -q --detach "$dir_a" "$sha_a"
git worktree add -q --detach "$dir_b" "$sha_b"

cpus=$(nproc)
if [ "$cpus" -ge 4 ]; then server_cpus=0,1; client_cpus=2,3; else server_cpus=0-$((cpus - 1)); client_cpus=; fi
python3 - "$out/meta.json" "$1" "$sha_a" "$2" "$sha_b" "$rounds" "$runs" "$loads" "$cpus" "$server_cpus" "${client_cpus:-shared}" "$(git rev-parse HEAD)" <<'PY'
import json, sys
path, base, sha_a, head, sha_b, rounds, runs, loads, cpus, server, client, scripts = sys.argv[1:]
json.dump({"base": {"ref": base, "sha": sha_a}, "head": {"ref": head, "sha": sha_b}, "rounds": int(rounds), "runs": int(runs),
           "browserLoads": int(loads), "hostCpus": int(cpus), "serverCpus": server, "clientCpus": client, "scripts": scripts},
          open(path, "w"), indent=1)
PY

# --- Two stacks: same settings, own project, port, images and volumes ------------------------------------------------------------
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-perf-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-perf-$$-$(date +%s)"
export FLUX_AUTH_SECRET="auth-perf-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT= FLUX_SMTP_URL= FLUX_MAIL_FROM= FLUX_EMBEDDINGS_URL=
perf_password="perf-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
project_a="perfcmp-a-$$"; project_b="perfcmp-b-$$"
port_a="${FLUX_PERF_COMPARE_PORT:-18311}"; port_b=$((port_a + 1))

# The overlay: CPUs of the server and of the measuring client (a service from the API's image and settings, never started by `up`).
overlay="$out/compose.compare.yaml"
{
  echo "services:"
  for service in db api worker; do printf '  %s:\n    cpuset: "%s"\n' "$service" "$server_cpus"; done
  cat <<EOF
  perfclient:
    image: flux-foundation:\${FLUX_IMAGE_TAG}
    profiles: ["perfclient"]
    environment:
      DATABASE_URL: postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@db:5432/\${POSTGRES_DB}
      FLUX_PUBLIC_ORIGIN: \${FLUX_PUBLIC_ORIGIN}
      FLUX_PERF_API: http://api:8080
      NODE_OPTIONS: ""
EOF
  [ -z "$client_cpus" ] || printf '    cpuset: "%s"\n' "$client_cpus"
} > "$overlay"

dc() {
  side=$1; shift
  eval "d=\$dir_$side p=\$project_$side port=\$port_$side"
  FLUX_PORT=$port FLUX_PUBLIC_ORIGIN="http://127.0.0.1:$port" FLUX_IMAGE_TAG=$p \
    docker compose --env-file /dev/null -p "$p" -f "$d/docker/compose.source.yaml" -f "$d/docker/compose.perf.yaml" -f "$overlay" "$@"
}
psql_on() { side=$1; shift; dc "$side" exec -T db psql -U flux -d flux -v ON_ERROR_STOP=1 -tA "$@"; }
client() { side=$1; shift; dc "$side" --profile perfclient run --rm --no-deps -T "$@"; }

cleanup() {
  status=$?
  for side in a b; do
    [ -d "$out/$side" ] || continue
    [ -f "$out/$side/api.log.gz" ] || dc "$side" logs --no-color --no-log-prefix api 2>/dev/null | gzip -6 > "$out/$side/api.log.gz" || true
    if [ "${FLUX_PERF_KEEP:-}" != 1 ]; then
      dc "$side" --profile perfclient down -v --rmi local >/dev/null 2>&1 || true
      eval "p=\$project_$side"
      docker image rm -f "flux-foundation:$p" "flux-database:$p" >/dev/null 2>&1 || true
    fi
  done
  [ -z "${browser_image:-}" ] || docker image rm -f "$browser_image" >/dev/null 2>&1 || true
  git worktree remove --force "$dir_a" >/dev/null 2>&1 || true
  git worktree remove --force "$dir_b" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Memory of a stack's db, api and worker: one `docker stats` sample (side, time, service, MiB) appended to <file>.
memory_once() {
  eval "p=\$project_$1"
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' $(docker ps -q --filter "label=com.docker.compose.project=$p") 2>/dev/null \
    | awk -v side="$1" -v now="$(date +%s)" -F'\t' '{
        split($2, m, " / "); v = m[1]; mib = v + 0
        if (v ~ /GiB/) mib *= 1024; else if (v ~ /KiB/) mib /= 1024; else if (v !~ /MiB/) mib /= 1048576
        svc = "other"; if ($1 ~ /-db-[0-9]+$/) svc = "db"; else if ($1 ~ /-api-[0-9]+$/) svc = "api"; else if ($1 ~ /-worker-[0-9]+$/) svc = "worker"
        if (svc != "other") printf "%s\t%s\t%s\t%.1f\n", side, now, svc, mib }' >> "$2" || true
}
# The same every second until <stop> exists (run it in the background).
sample_memory() { while [ ! -f "$3" ]; do memory_once "$1" "$2"; sleep 1; done; }

for side in a b; do
  mkdir -p "$out/$side"
  log "Building $side ($(eval "echo \$sha_$side"))"
  # v0.2.0 pulls a pinned PostgreSQL image; later refs build Flux's own database image (F-042) too.
  builds=$(dc "$side" config --format json | python3 -c 'import json, sys; print("db" if "build" in json.load(sys.stdin)["services"]["db"] else "")')
  dc "$side" build migrate $builds >"$out/$side/build.log" 2>&1 || { tail -n 40 "$out/$side/build.log" >&2; exit 1; }
done

# The browser: the head's pinned Playwright image (docker/ui-tests.Dockerfile), the same Chromium for both refs. It runs on the host's
# network (the stacks publish on 127.0.0.1, their FLUX_PUBLIC_ORIGIN) and reaches the database's statistics through this host's
# Docker CLI and socket. FLUX_PERF_BROWSER_PYTHON (a Python with Playwright and Chromium) runs it on the host instead.
browser_image=
if [ -z "${FLUX_PERF_BROWSER_PYTHON:-}" ]; then
  browser_image="perfcmp-browser:$$"
  if ! docker build -q -t "$browser_image" -f "$dir_b/docker/ui-tests.Dockerfile" "$dir_b/app" >"$out/browser-build.log" 2>&1; then
    log "The browser image did not build (see $out/browser-build.log); the browser phase is skipped"
    browser_image=
  fi
fi

for side in a b; do
  log "Starting and seeding $side"
  dc "$side" up -d db migrate >"$out/$side/up.log" 2>&1 || { tail -n 40 "$out/$side/up.log" >&2; exit 1; }
  dc "$side" --profile setup run --rm files-init >/dev/null
  dc "$side" up -d --wait api worker >>"$out/$side/up.log" 2>&1
  : > "$out/$side/seed-memory.tsv"
  sample_memory "$side" "$out/$side/seed-memory.tsv" "$out/$side/.seed-done" &
  sampler=$!
  dc "$side" exec -T -e FLUX_PERF_PASSWORD="$perf_password" api node --input-type=module - < scripts/perf-seed.mjs > "$out/$side/seed.log"
  previous=-1; stable=0
  while [ "$stable" -lt 3 ]; do
    sleep 3
    current=$(psql_on "$side" -c 'SELECT count(*) FROM notifications')
    if [ "$current" = "$previous" ]; then stable=$((stable + 1)); else stable=0; fi
    previous=$current
  done
  touch "$out/$side/.seed-done"; wait "$sampler" || true
  psql_on "$side" -c "SELECT 'messages', count(*) FROM project_messages UNION ALL SELECT 'tasks', count(*) FROM project_work_items
    UNION ALL SELECT 'notifications', count(*) FROM notifications UNION ALL SELECT 'search documents', count(*) FROM search_documents" > "$out/$side/volume.txt"
  dc "$side" exec -T api node --input-type=module - < scripts/perf-bundle.mjs > "$out/$side/bundle.txt"
  dc "$side" stop worker >/dev/null 2>&1
  client "$side" -e FLUX_PERF_PASSWORD="$perf_password" -e FLUX_PERF_MODE=prepare perfclient node --input-type=module - \
    < scripts/perf-measure.mjs > "$out/$side/state.jsonl"
  sed -n 's/^{"type":"state",/{/p' "$out/$side/state.jsonl" > "$out/$side/state.json"
  [ -s "$out/$side/state.json" ] || { echo "$side: the measurement could not sign in or find the seeded views" >&2; exit 1; }
done

# --- One round of one ref ---------------------------------------------------------------------------------------------------------
measure_round() {
  side=$1 round=$2
  dir="$out/$side/round-$round"
  mkdir -p "$dir"
  state=$(cat "$out/$side/state.json")
  eval "port=\$port_$side"
  measure() {
    client "$side" -e FLUX_PERF_PASSWORD="$perf_password" -e FLUX_PERF_RUNS="$runs" -e FLUX_PERF_STATE="$state" "$@" \
      perfclient node --input-type=module - < scripts/perf-measure.mjs >> "$dir/measure.jsonl"
  }
  extra() {
    client "$side" -e FLUX_PERF_PASSWORD="$perf_password" -e FLUX_PERF_RUNS="$search_runs" -e FLUX_PERF_STATE="$state" "$@" \
      perfclient node --input-type=module - < scripts/perf-compare-extra.mjs >> "$dir/extra.jsonl" || log "$side: search phase failed ($*)"
  }

  log "Round $round, $side: idle minute"
  dc "$side" start worker >/dev/null 2>&1
  waited=0
  while [ "$(psql_on "$side" -c 'SELECT count(*) FROM pgboss.queue WHERE maintain_on IS NULL')" != 0 ] && [ "$waited" -lt 150 ]; do
    sleep 2; waited=$((waited + 2))
  done
  sleep 5
  psql_on "$side" -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null
  psql_on "$side" -c 'SELECT pg_stat_statements_reset()' >/dev/null
  cpu_usec() { dc "$side" exec -T "$1" sh -c 'cat /sys/fs/cgroup/cpu.stat' 2>/dev/null | awk '/^usage_usec/ { print $2 }'; }
  before="$(cpu_usec api) $(cpu_usec worker) $(cpu_usec db)"
  sleep 60
  after="$(cpu_usec api) $(cpu_usec worker) $(cpu_usec db)"
  statements=$(psql_on "$side" -c "SELECT coalesce(sum(calls), 0) FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'")
  : > "$dir/idle-memory.tsv"
  memory_once "$side" "$dir/idle-memory.tsv"
  echo "$statements $before $after" | awk '{ printf "{\"statements\": %d, \"apiCpu\": %.3f, \"workerCpu\": %.3f, \"dbCpu\": %.3f}\n", $1,
    ($5 - $2) / 600000, ($6 - $3) / 600000, ($7 - $4) / 600000 }' > "$dir/idle.json"
  psql_on "$side" -c "SELECT calls, left(regexp_replace(query, '\s+', ' ', 'g'), 140) FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY calls DESC LIMIT 25" > "$dir/idle-top.txt"
  dc "$side" stop worker >/dev/null 2>&1

  log "Round $round, $side: statement counts, 2 vCPU phases"
  measure -e FLUX_PERF_MODE=count -e FLUX_PERF_PERSON=0
  : > "$dir/load-memory.tsv"
  sample_memory "$side" "$dir/load-memory.tsv" "$dir/.load-done" & sampler=$!
  measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=0 -e "FLUX_PERF_SUFFIX= @2 vcpu"
  measure -e FLUX_PERF_MODE=concurrent -e FLUX_PERF_CLIENTS=2 -e "FLUX_PERF_SUFFIX= @2 vcpu"
  extra -e FLUX_PERF_MODE=search -e "FLUX_PERF_SUFFIX= @2 vcpu"
  extra -e FLUX_PERF_MODE=agent -e "FLUX_PERF_SUFFIX= @2 vcpu"

  log "Round $round, $side: 1.0 CPU phases"
  ids=$(dc "$side" ps -q api db)
  docker update --cpus 1.0 $ids >/dev/null
  measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=0 -e "FLUX_PERF_SUFFIX= @1.0 cpu"
  measure -e FLUX_PERF_MODE=warm -e FLUX_PERF_PERSON=1 -e "FLUX_PERF_SUFFIX= @1.0 cpu"
  measure -e FLUX_PERF_MODE=concurrent -e FLUX_PERF_CLIENTS=2 -e "FLUX_PERF_SUFFIX= @1.0 cpu"
  extra -e FLUX_PERF_MODE=search -e "FLUX_PERF_SUFFIX= @1.0 cpu"
  extra -e FLUX_PERF_MODE=agent -e "FLUX_PERF_SUFFIX= @1.0 cpu"
  docker update --cpus 0 $ids >/dev/null
  touch "$dir/.load-done"; wait "$sampler" || true

  db_id=$(dc "$side" ps -q db)
  set -- --origin "http://127.0.0.1:$port" --password "$perf_password" --db-container "$db_id" --loads "$loads"
  if [ -n "$browser_image" ]; then
    log "Round $round, $side: browser"
    docker run --rm --network host --shm-size 1g ${client_cpus:+--cpuset-cpus "$client_cpus"} \
      -v /var/run/docker.sock:/var/run/docker.sock -v "$(command -v docker)":/usr/local/bin/docker:ro \
      -v "$root/scripts/perf-compare-browser.py":/perf/browser.py:ro -v "$dir":/out "$browser_image" \
      python3 /perf/browser.py "$@" --out /out/browser.json > "$dir/browser.log" 2>&1 || log "browser phase failed (see $dir/browser.log)"
  elif [ -n "${FLUX_PERF_BROWSER_PYTHON:-}" ]; then
    log "Round $round, $side: browser"
    ${client_cpus:+taskset -c "$client_cpus"} "$FLUX_PERF_BROWSER_PYTHON" scripts/perf-compare-browser.py "$@" --out "$dir/browser.json" \
      > "$dir/browser.log" 2>&1 || log "browser phase failed (see $dir/browser.log)"
  fi
}

r=1
while [ "$r" -le "$rounds" ]; do
  measure_round a "$r"
  measure_round b "$r"
  r=$((r + 1))
done

for side in a b; do
  dc "$side" logs --no-color --no-log-prefix api > "$out/$side/api.log" 2>/dev/null
  # The repository's own per-request report of each round, beside the comparison.
  for measured in "$out/$side"/round-*/measure.jsonl; do
    python3 scripts/perf_report.py "$measured" "$out/$side/api.log" --targets > "${measured%measure.jsonl}report.md" || true
  done
done
python3 scripts/perf_compare_report.py "$out" > "$out/compare.md"
sed 's/^/PERF /' "$out/compare.md"
for side in a b; do gzip -f "$out/$side/api.log"; done
echo "Results: $out" >&2
