#!/bin/sh
# #58 / #118: old protected-main image -> this committed head on one PostgreSQL/files volume.
# Baseline and candidate are immutable git archives; only Docker executes the application.
# After the upgrade, #118 faults are injected on that volume: a phantom ledger row, a recorded
# file left out of the ledger, and images with a duplicate prefix, a misnamed file, a missing
# applied file or SQL that writes another ledger version. Each must fail closed and keep the data.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
from=${FLUX_UPGRADE_FROM:-$(git -C "$here" rev-parse origin/main)}
candidate=$(git -C "$here" rev-parse HEAD)
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-proactive-upgrade.XXXXXX")
checkout="$work/flux"
mkdir "$checkout"
git -C "$here" archive "$from" | tar -xf - -C "$checkout"
export FLUX_PORT=${FLUX_PROACTIVE_UPGRADE_PORT:-22058}
export FLUX_DEV_PORT=$((FLUX_PORT + 1)) FLUX_MAILPIT_PORT=$((FLUX_PORT + 2))
export FLUX_AUTH_RATE_LIMIT=false
unset FLUX_PROJECT FLUX_PUBLIC_ORIGIN
head -c 32 /dev/urandom > "$work/background_key"
chmod 0444 "$work/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$work/background_key"
# The baseline may predate the app/ + docker/ layout (#76); the candidate always follows it.
env_path() { if [ -f "$checkout/docker/.env" ]; then printf '%s/docker/.env' "$checkout"; else printf '%s/.env' "$checkout"; fi; }
migration_dir() { if [ -d "$checkout/app/packages/db/migrations" ]; then printf '%s/app/packages/db/migrations' "$checkout"; else printf '%s/packages/db/migrations' "$checkout"; fi; }
compose() {
  if [ -f "$checkout/docker/compose.source.yaml" ]; then
    compose_dir="$checkout/docker" compose_file="$checkout/docker/compose.source.yaml"
  else
    compose_dir="$checkout/infra" compose_file="$checkout/infra/compose.yaml"
  fi
  docker compose --project-directory "$compose_dir" --env-file "$(env_path)" -p "$project" -f "$compose_file" "$@"
}
cleanup() {
  status=$?
  if [ -f "$(env_path)" ]; then
    project=$(sed -n 's/^FLUX_PROJECT=//p' "$(env_path)")
    if [ "$status" -ne 0 ]; then compose logs --no-color --tail 50 db migrate api worker || true; fi
    "$checkout/flux" clean -y >/dev/null 2>&1 || true
  fi
  chmod 0600 "$work/background_key"
  rm -rf "${work:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ledger() { compose exec -T db psql -X -tA -v ON_ERROR_STOP=1 -U flux -d flux -c "SELECT string_agg(version::text, ',' ORDER BY version) FROM flux_schema_version"; }
expected_ledger() { ls "$(migration_dir)" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)_.*\.sql$/\1/p' | sort -n | sed 's/^0*//' | paste -sd, -; }
sql() { compose exec -T db psql -X -tA -v ON_ERROR_STOP=1 -U flux -d flux -c "$1" </dev/null; }
# Rows are compared on the baseline's columns, so a later migration may add columns (0043) or
# constraints (0042) but must not change or drop a recorded value. Tables absent at the baseline are skipped.
record_columns() {
  for table in workspaces workspace_members projects project_grants drafts project_materials project_material_versions project_conversations project_messages sketches sketch_thoughts sketch_links project_work_items project_decisions project_results project_object_links agents background_compute_connections; do
    columns=$(sql "SELECT string_agg(quote_literal(column_name), ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '$table'")
    [ -z "$columns" ] || printf '%s %s\n' "$table" "$columns"
  done > "$work/columns"
}
snapshot() {
  while read -r table columns; do
    sql "SELECT '$table:' || count(*) || ':' || md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) FROM (SELECT (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(t)) WHERE key IN ($columns)) AS r FROM $table t) s"
  done < "$work/columns"
}
echo "Baseline $from -> candidate $candidate; isolated same-volume rehearsal"
"$checkout/flux" up > "$work/baseline-up.log" 2>&1 || { cat "$work/baseline-up.log"; exit 1; }
"$checkout/flux" demo > "$work/demo.log" 2>&1 || { cat "$work/demo.log"; exit 1; }
project=$(sed -n 's/^FLUX_PROJECT=//p' "$(env_path)")
origin=$(sed -n 's/^FLUX_PUBLIC_ORIGIN=//p' "$(env_path)")
owner_password=$(sed -n 's/^FLUX_DEMO_OWNER_PASSWORD=//p' "$(env_path)")
prepared=$(compose exec -T -e FLUX_UPGRADE_PHASE=prepare -e FLUX_PUBLIC_ORIGIN="$origin" -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" \
  api node --input-type=module - < "$here/scripts/proactive-upgrade-fixture.mjs")
state=$(printf '%s\n' "$prepared" | sed -n 's/^FLUX_UPGRADE_STATE //p')
[ -n "$state" ] || { echo 'Missing prepared fixture state'; exit 1; }
compose stop api worker >/dev/null
old_ledger=$(ledger)
[ "$old_ledger" = "$(expected_ledger)" ] || { echo 'Baseline ledger does not match baseline files'; exit 1; }
record_columns
snapshot > "$work/before.snapshot"
volume="${project}_pgdata"
volume_created=$(docker volume inspect -f '{{.CreatedAt}}' "$volume")
# Preserve this checkout's private env and volumes; replace only its source like an ordinary update.
# The env file returns to its own relative location (docker/.env, or a legacy root .env that the
# candidate launcher moves once), so the baseline and candidate share one project and secrets.
baseline_env=$(env_path)
env_relative=${baseline_env#"$checkout"/}
cp "$baseline_env" "$work/baseline.env"
find "$checkout" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
git -C "$here" archive "$candidate" | tar -xf - -C "$checkout"
mkdir -p "$(dirname "$checkout/$env_relative")"
cp "$work/baseline.env" "$checkout/$env_relative"
chmod 600 "$checkout/$env_relative"
new_files=$(expected_ledger)
"$checkout/flux" up > "$work/candidate-up.log" 2>&1 || { cat "$work/candidate-up.log"; exit 1; }
compose logs --no-color migrate | sed -n '/Applied migration /p'
[ "$(docker volume inspect -f '{{.CreatedAt}}' "$volume")" = "$volume_created" ] || { echo 'PostgreSQL volume was replaced'; exit 1; }
[ "$(ledger)" = "$new_files" ] || { echo 'Candidate ledger is not exact'; exit 1; }
snapshot > "$work/after.snapshot"
diff -u "$work/before.snapshot" "$work/after.snapshot"
cat "$work/after.snapshot"
compose exec -T -e FLUX_UPGRADE_PHASE=verify -e FLUX_UPGRADE_STATE="$state" -e FLUX_PUBLIC_ORIGIN="$origin" \
  api node --input-type=module - < "$here/scripts/proactive-upgrade-fixture.mjs"
compose stop api worker >/dev/null
compose run --rm migrate
compose up -d --wait api worker >/dev/null
[ "$(ledger)" = "$new_files" ] || { echo 'Rerun changed the ledger'; exit 1; }
snapshot > "$work/upgraded.snapshot"

echo '#118 fault injection on the upgraded volume'
health() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FLUX_PORT/api/v1/health"; }
# expect_refusal <label> <pattern> <command...>: the command must fail and print the operator error.
expect_refusal() {
  label=$1 pattern=$2; shift 2
  if "$@" > "$work/fault.out" 2>&1; then cat "$work/fault.out"; echo "FAIL: $label was accepted"; exit 1; fi
  grep -q "$pattern" "$work/fault.out" || { cat "$work/fault.out"; echo "FAIL: $label failed without the expected error"; exit 1; }
  echo "refused ($label): $(grep -o "$pattern[^.]*" "$work/fault.out" | head -n 1)"
}
# A one-off API or worker start with this image; a start that stays up for 30 s counts as accepted.
start_refused() { compose run --rm --no-deps -T --entrypoint timeout "$1" 30 node "$2"; }
migrate_with() { compose run --rm -T -v "$1:/app/packages/db/migrations:ro" migrate; }
api_with() { compose run --rm --no-deps -T -v "$1:/app/packages/db/migrations:ro" --entrypoint timeout api 30 node apps/server/dist/index.js; }
image_files() { rm -rf "$work/faults"; mkdir -p "$work/faults"; cp "$(migration_dir)"/*.sql "$work/faults/"; chmod -R a+rX "$work/faults"; }
[ "$(health)" = 200 ] || { echo 'Upgraded API is not healthy before fault injection'; exit 1; }

# 1. A phantom applied version: the running API turns unhealthy, and neither migrator, API nor worker accepts it.
sql 'INSERT INTO flux_schema_version(version) VALUES (9999)' >/dev/null
[ "$(health)" = 503 ] || { echo 'FAIL: health stayed ready with a phantom ledger row'; exit 1; }
echo 'refused (phantom row, running API): health 503'
expect_refusal 'phantom row, migrator' 'versions without files in this image: 9999' compose run --rm -T migrate
expect_refusal 'phantom row, API start' 'versions without files in this image: 9999' start_refused api apps/server/dist/index.js
expect_refusal 'phantom row, worker start' 'versions without files in this image: 9999' start_refused worker apps/worker/dist/index.js
sql 'DELETE FROM flux_schema_version WHERE version = 9999' >/dev/null
[ "$(health)" = 200 ] || { echo 'FAIL: health did not recover after removing the phantom row'; exit 1; }

# 2. A file of this image left out of the ledger (a skipped gap-fill): not ready, and no second application.
sql 'DELETE FROM flux_schema_version WHERE version = 35' >/dev/null
[ "$(health)" = 503 ] || { echo 'FAIL: health stayed ready with 0035 missing from the ledger'; exit 1; }
echo 'refused (unrecorded 0035, running API): health 503'
expect_refusal 'unrecorded 0035, API start' 'ledger is missing files: 0035_cowork_coordination.sql' start_refused api apps/server/dist/index.js
expect_refusal 'unrecorded 0035, worker start' 'ledger is missing files: 0035_cowork_coordination.sql' start_refused worker apps/worker/dist/index.js
# The migrator re-runs 0035 in a transaction; its tables exist, so it fails and rolls back.
expect_refusal 'unrecorded 0035, migrator re-run' 'already exists' compose run --rm -T migrate
[ "$(sql 'SELECT count(*) FROM flux_schema_version WHERE version = 35')" = 0 ] || { echo 'FAIL: a failed 0035 re-run recorded a version'; exit 1; }
sql 'INSERT INTO flux_schema_version(version) VALUES (35)' >/dev/null
[ "$(health)" = 200 ] || { echo 'FAIL: health did not recover after restoring row 35'; exit 1; }

# 3. Images whose migration files are wrong refuse before executing any SQL.
latest=$(ls "$(migration_dir)" | sed -n 's/^\([0-9]\{4\}\)_.*\.sql$/\1/p' | sort | tail -n 1)
latest_version=$(printf '%s' "$latest" | sed 's/^0*//')
image_files; printf 'CREATE TABLE ledger_fault_probe(id integer);\n' > "$work/faults/${latest}_duplicate_probe.sql"
expect_refusal 'duplicate prefix, migrator' "Duplicate Flux migration version $latest_version" migrate_with "$work/faults"
expect_refusal 'duplicate prefix, API start' "Duplicate Flux migration version $latest_version" api_with "$work/faults"
image_files; printf 'CREATE TABLE ledger_fault_probe(id integer);\n' > "$work/faults/0035-skipped_probe.sql"
expect_refusal 'misnamed file, migrator' 'Invalid Flux migration filename: 0035-skipped_probe.sql' migrate_with "$work/faults"
image_files; rm "$work/faults/0035_cowork_coordination.sql"
expect_refusal 'image without applied 0035, migrator' 'versions without files in this image: 35' migrate_with "$work/faults"
expect_refusal 'image without applied 0035, API start' 'versions without files in this image: 35' api_with "$work/faults"
# 4. SQL that records another version than its own rolls back with everything it did.
image_files; latest_file=$(ls "$work/faults" | sort | tail -n 1)
printf 'CREATE TABLE ledger_fault_probe(id integer);\nINSERT INTO flux_schema_version(version) VALUES (9998);\n' > "$work/faults/$latest_file"
sql "DELETE FROM flux_schema_version WHERE version = $latest_version" >/dev/null
expect_refusal 'foreign ledger insert, migrator' "${latest_file} changed unrelated ledger versions (added: 9998" migrate_with "$work/faults"
[ "$(sql "SELECT to_regclass('ledger_fault_probe') IS NULL AND NOT EXISTS (SELECT 1 FROM flux_schema_version WHERE version IN (9998, $latest_version))")" = t ] ||
  { echo 'FAIL: the rejected migration left its table or a ledger row'; exit 1; }
sql "INSERT INTO flux_schema_version(version) VALUES ($latest_version)" >/dev/null
[ "$(sql "SELECT count(*) FROM pg_tables WHERE tablename = 'ledger_fault_probe'")" = 0 ] || { echo 'FAIL: a refused image created its probe table'; exit 1; }

compose run --rm -T migrate >/dev/null
compose up -d --wait api worker >/dev/null
[ "$(health)" = 200 ] || { echo 'FAIL: API not healthy after the faults were removed'; exit 1; }
[ "$(ledger)" = "$new_files" ] || { echo 'FAIL: ledger is not exact after fault injection'; exit 1; }
snapshot > "$work/faults.snapshot"
diff -u "$work/upgraded.snapshot" "$work/faults.snapshot" || { echo 'FAIL: fault injection changed retained rows'; exit 1; }
echo "PASS: same PostgreSQL volume, exact ledger {$old_ledger} -> {$new_files}, immutable content/session retention, usable new schema, idempotent migration, and fail-closed phantom/unrecorded/duplicate/misnamed/missing-file/foreign-insert faults with the data kept."
