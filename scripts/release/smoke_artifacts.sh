#!/usr/bin/env bash
# Exercise a downloaded, digest-pinned Compose package in isolated projects (#77 AC-3).
#
#   smoke_artifacts.sh <assets> <state dir> <install project> <restore project>
#   FLUX_SMOKE_PREVIOUS_ASSETS=<previous release's assets> smoke_artifacts.sh ...   (adds the upgrade leg)
#
# Leg 1 (unless FLUX_SMOKE_LEGS=upgrade): a clean install of the candidate's assets EXACTLY as INSTALL.md says, with its default settings
# and no overlay: an account, workspace and content created through the API (smoke_data.py seed: people, a guest, spaces, an encrypted
# space with the keyring secrets of INSTALL.md, conversations, a wiki, a map, tasks, notification settings, a second device), a paired
# PostgreSQL + files backup and its restore into fresh volumes. The agents' settings and the provider mock are not part of it.
#
# Leg 2, only when FLUX_SMOKE_PREVIOUS_ASSETS names the downloaded assets of the PREVIOUS release (its
# compose.yaml, env.example, release.json, SHA256SUMS): INSTALL.md's upgrade, followed literally. The previous release is ANY published
# release from v0.2.0 on, not only the last one: check_upgrade_matrix.sh runs this leg for each of them (#1241). It is the leg that
# seeds the agents' data: its environment file also sets the three switches of "Agents on your own AI key" and its projects carry the
# provider mock overlay (an AI connection on an API key, an agent with memory and schedules, a run).
#   1. Install the previous release, create the same content through its API and a file in the files volume.
#   2. Take a paired backup with the previous release's files, then stop the writers with them.
#   3. Pull and start the candidate's compose.yaml with the SAME environment file and project (same volumes).
#   4. Check that the data and the migrations survived: the migrate service exited 0; /api/v1/health reports a
#      schemaVersion that did not go down; the migration ledger equals the candidate's migration files and
#      contains every earlier row; the rows of the content tables are unchanged (count and md5 over the
#      previous columns); the volumes were not recreated; the account signs in and every created item reads back;
#      the instance accepts new work (smoke_data.py verify --write: messages of each kind, a task, a new agent run on the provider
#      mock, a message in the unlocked encrypted space) and the second device's session still works.
#   5. Back up the upgraded installation and restore it into fresh volumes with the candidate's files.
#   6. Recovery path: restore the PRE-upgrade backup into fresh volumes with the PREVIOUS release's files,
#      check it there, then upgrade that restored installation to the candidate and check it again.
# Leg 3, with Leg 2 and FLUX_SMOKE_RECOVERY=1: a migration that breaks the old data (it passes on an empty database; see
# check_upgrade_matrix.sh) is added to the candidate. The upgrade stops with the failing migration, API and worker do not start,
# and the paired backup taken with the previous release's files restores into fresh volumes with those files and reads back.
# FLUX_SMOKE_INJECT=old-data adds that migration to Leg 2's upgrade itself: the leg must fail (the negative control).
#
# final-release.yml runs Leg 2 from the previous release in its `package` job and the matrix of every earlier release in its
# `upgrade` job; the draft needs both. The agents' data is on a provider mock (provider-mock.compose.yaml, provider_mock.mjs), in Leg 2 and after only.
#
# Ports default to 18081 (installation) and 18082 (restore); set FLUX_SMOKE_PORT and FLUX_SMOKE_RESTORE_PORT for
# a machine where those are taken. Both legs use them one after the other. Runs on GNU/Linux and macOS (bash 3.2).
set -euo pipefail

assets=${1:?release asset directory required}
state_dir=${2:?temporary state directory required}
source_project=${3:?source project name required}
restore_project=${4:?restore project name required}
previous_assets=${FLUX_SMOKE_PREVIOUS_ASSETS:-}
legs=${FLUX_SMOKE_LEGS:-all}
recovery=${FLUX_SMOKE_RECOVERY:-}
inject=${FLUX_SMOKE_INJECT:-}
source_port=${FLUX_SMOKE_PORT:-18081}
restore_port=${FLUX_SMOKE_RESTORE_PORT:-18082}
root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$state_dir"
assets=$(realpath "$assets")
state_dir=$(realpath "$state_dir")
source_env="$state_dir/source.env"
restore_env="$state_dir/restore.env"
up_dir="$state_dir/upgrade"
up_env="$up_dir/source.env"
up_restore_env="$up_dir/restore.env"

fail() { echo "smoke_artifacts: $*" >&2; exit 1; }
case "$legs" in all|upgrade) ;; *) fail "FLUX_SMOKE_LEGS is 'all' or 'upgrade', not '$legs'" ;; esac
[ "$legs" = all ] || [ -n "$previous_assets" ] || fail "FLUX_SMOKE_LEGS=upgrade needs FLUX_SMOKE_PREVIOUS_ASSETS"
case "$inject" in ''|old-data) ;; *) fail "FLUX_SMOKE_INJECT is 'old-data' or empty, not '$inject'" ;; esac
# FLUX_SMOKE_WAIT: seconds `up --wait` allows (default 300; an emulated platform needs more).
wait_timeout=${FLUX_SMOKE_WAIT:-300}
step() { printf '\n== %s\n' "$*"; }
json_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
candidate_image=$(json_field "$assets/release.json" image)
# The database image a release pins: the official PostgreSQL image before v0.2.1, Flux's own database image from it on (F-042).
db_image() { sed -n 's/^ *image: *\(\(postgres\|[^ ]*\/flux-database\)@sha256:[0-9a-f]*\).*/\1/p' "$1/compose.yaml"; }
check_sums() { # in the current directory
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS >/dev/null; else shasum -a 256 -c SHA256SUMS >/dev/null; fi
}

# The previous release is checked before anything starts: a refusal costs no image pull.
if [ -n "$previous_assets" ]; then
  [ -d "$previous_assets" ] || fail "FLUX_SMOKE_PREVIOUS_ASSETS is not a directory: $previous_assets"
  previous_assets=$(realpath "$previous_assets")
  for name in compose.yaml env.example release.json SHA256SUMS; do
    [ -f "$previous_assets/$name" ] || fail "the previous release has no $name"
  done
  ( cd "$previous_assets" && check_sums ) || fail "the previous release's assets do not match its SHA256SUMS"
  previous_image=$(json_field "$previous_assets/release.json" image)
  [ "$previous_image" != "$candidate_image" ] || fail "the previous release and the candidate pin the same image ($candidate_image); nothing would be upgraded"
  [ -n "$(db_image "$previous_assets")" ] && [ -n "$(db_image "$assets")" ] || fail "a release pins no database image"
  # The database image may change between releases (v0.2.1 moves from the official Alpine image to Flux's own); its PostgreSQL major may
  # not, which INSTALL.md answers with a restore into a fresh installation. The data directory is checked on the new image below.
  [ "$(db_image "$previous_assets")" = "$(db_image "$assets")" ] ||
    echo "the database image changes: $(db_image "$previous_assets") -> $(db_image "$assets") (the PostgreSQL major must stay; checked after the upgrade)"
fi

# The agents' provider is a mock on the project's network (provider-mock.compose.yaml): the AI connection of the seeded data
# is an owner API key whose base URL is that service. Its image is the candidate's own Node, so no other image is pulled.
export FLUX_SMOKE_MOCK_IMAGE=$candidate_image FLUX_SMOKE_MOCK_FILE="$root/scripts/release/provider_mock.mjs"
provider_overlay="$root/scripts/release/provider-mock.compose.yaml"
provider_url=http://provider-mock:8091/v1
background_key="$state_dir/background.key"
inject_overlay="" # set while the candidate runs with the injected migration (Leg 3, FLUX_SMOKE_INJECT)
# A project has the provider mock exactly when its environment file names the background key file (make_env ... agents): the default
# install of Leg 1 has neither the settings nor the overlay.
agents_on() { [ -f "$1" ] && grep -q '^FLUX_BACKGROUND_KEY_HOST_FILE=.' "$1"; }
dc() { # project, environment file, assets directory, then docker compose arguments
  local project=$1 env_file=$2 dir=$3 files=(-f "$3/compose.yaml")
  shift 3
  if agents_on "$env_file"; then files+=(-f "$provider_overlay"); fi
  if [ -n "$inject_overlay" ] && [ "$dir" = "$assets" ]; then files+=(-f "$inject_overlay"); fi
  docker compose --env-file "$env_file" -p "$project" "${files[@]}" "$@"
}
down() { # project, environment file (the candidate's compose file names the same services as the previous one)
  if [ -f "$2" ]; then dc "$1" "$2" "$assets" down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for pair in "$source_project|$source_env" "$source_project|$up_env" "$restore_project|$restore_env" "$restore_project|$up_restore_env"; do
      if [ -f "${pair#*|}" ]; then
        echo "-- logs of ${pair%%|*} (${pair#*|})" >&2
        dc "${pair%%|*}" "${pair#*|}" "$assets" logs --no-color --tail 30 db migrate api worker >&2 2>&1 || true
      fi
    done
  fi
  down "$restore_project" "$restore_env"; down "$restore_project" "$up_restore_env"
  down "$source_project" "$source_env"; down "$source_project" "$up_env"
  exit "$status"
}
trap cleanup EXIT

health() { curl --fail --show-error --silent "http://127.0.0.1:$1/api/v1/health"; }
schema_version() { health "$1" | sed -n 's/.*"schemaVersion":\([0-9][0-9]*\).*/\1/p'; }
sql() { # project, environment file, assets directory, statement
  dc "$1" "$2" "$3" exec -T db sh -c 'psql -X -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$4" </dev/null
}
ledger() { sql "$1" "$2" "$3" "SELECT string_agg(version::text, ',' ORDER BY version) FROM flux_schema_version"; }
# The database runs the candidate's database image (F-042: Debian with pg_search, also when the previous release ran the official
# Alpine image), and every B-tree index of the data it kept is intact under that image's collation (amcheck, in a transaction that
# is rolled back, so nothing is left behind).
database_check() { # project, environment file, assets directory
  sql "$1" "$2" "$3" "SELECT version()" | grep -q 'Debian' || fail "the database does not run the candidate's database image"
  [ "$(sql "$1" "$2" "$3" "SELECT current_setting('server_version_num')::int / 10000")" = "$(cat "$up_dir/major.before")" ] ||
    fail "the PostgreSQL major changed across the upgrade"
  [ "$(sql "$1" "$2" "$3" "SHOW shared_preload_libraries" | tr ',' '\n' | grep -cx 'pg_search')" = 1 ] || fail "pg_search is not preloaded"
  checked=$(sql "$1" "$2" "$3" "BEGIN; CREATE EXTENSION IF NOT EXISTS amcheck; SELECT count(bt_index_check(c.oid, true)) FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am a ON a.oid = c.relam JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.amname = 'btree' AND c.relkind = 'i' AND i.indisvalid AND c.relpersistence = 'p' AND n.nspname NOT IN ('pg_catalog', 'pg_toast'); ROLLBACK;" | grep -E '^[0-9]+$') \
    || fail "a B-tree index does not pass amcheck on the candidate's database image"
  echo "database: $(sql "$1" "$2" "$3" "SELECT version()" | cut -d, -f1); $checked B-tree indexes pass amcheck (heap included; partitioned parents are checked through their partitions)"
}
expected_ledger() { # the candidate's migration files, as the migrator numbers them
  ls "$root/app/packages/db/migrations" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)_.*\.sql$/\1/p' | sort -n | sed 's/^0*//' | paste -sd, -
}
# Content tables compared across the upgrade: rows keep their previous columns (a migration may add a column or a
# constraint but must not change or drop a recorded value). Tables the previous release lacks are skipped.
content_tables="workspaces workspace_members projects project_grants project_materials project_material_versions project_conversations project_messages project_work_items project_decisions agents"
table_columns() {
  local table columns
  for table in $content_tables; do
    columns=$(sql "$1" "$2" "$3" "SELECT string_agg(quote_literal(column_name), ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '$table'")
    if [ -n "$columns" ]; then printf '%s %s\n' "$table" "$columns"; fi
  done
}
table_snapshot() { # project, environment file, assets directory, file of "table columns" lines
  local table columns
  while read -r table columns; do
    sql "$1" "$2" "$3" "SELECT '$table:' || count(*) || ':' || md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) FROM (SELECT (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(t)) WHERE key IN ($columns)) AS r FROM $table t) s"
  done < "$4"
}
volume_stamps() { docker volume inspect -f '{{.Name}} {{.CreatedAt}}' "$1_pgdata" "$1_files"; }
write_probe() { # project, environment file, assets directory, value: a file in the files volume
  dc "$1" "$2" "$3" run -T --rm --no-deps --entrypoint sh api -c 'printf %s "$1" > /data/files/restore-probe.txt' probe "$4"
}
check_probe() { # project, environment file, assets directory, value
  test "$(dc "$1" "$2" "$3" run -T --rm --no-deps --entrypoint cat api /data/files/restore-probe.txt)" = "$4"
  test "$(dc "$1" "$2" "$3" run -T --rm --no-deps --entrypoint stat api -c %u /data/files/restore-probe.txt)" != 0
}
paired_backup() { # project, environment file, assets directory, output directory: INSTALL.md's "Consistent backup"
  mkdir -p "$4"
  dc "$1" "$2" "$3" stop api worker
  dc "$1" "$2" "$3" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$4/database.dump"
  dc "$1" "$2" "$3" run -T --rm --no-deps --entrypoint tar api -C /data/files -cf - . > "$4/files.tar"
  test -s "$4/database.dump"
  test -s "$4/files.tar"
  tar -tf "$4/files.tar" > "$4/files.list"
  grep -q 'restore-probe\.txt$' "$4/files.list"
}
restore_backup() { # project, environment file, assets directory, backup directory, port: INSTALL.md's restore
  dc "$1" "$2" "$3" config --quiet
  dc "$1" "$2" "$3" up -d --wait --wait-timeout "$wait_timeout" db
  dc "$1" "$2" "$3" exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$4/database.dump"
  dc "$1" "$2" "$3" run -T --rm --no-deps --entrypoint tar api -C /data/files -xf - < "$4/files.tar"
  dc "$1" "$2" "$3" up -d --wait --wait-timeout "$wait_timeout"
  health "$5" >/dev/null
}
# A migration that breaks the old data: it passes on an empty database (no message rows) and fails on a database that holds
# what a release wrote (#1241). It is mounted into the candidate's migrate service (the migrator reads its image's migrations
# directory), so no image is rebuilt. The migrator expects the highest file to be its image's FLUX_SCHEMA_VERSION, so the file takes
# the next number and the one compiled file that holds the constant is mounted as a copy of itself with the constant one higher.
make_injection() { # directory
  mkdir -p "$1"
  injected_number=$(( $(expected_ledger | tr ',' '\n' | tail -n 1) + 1 ))
  injected_file=$(printf '%04d_upgrade_check.sql' "$injected_number")
  printf -- '-- smoke_artifacts.sh: a migration that works on an empty database and breaks the data of a release.\nALTER TABLE project_messages ADD CONSTRAINT upgrade_check_no_messages CHECK (false);\n' > "$1/$injected_file"
  docker run --rm --entrypoint cat "$candidate_image" /app/packages/db/dist/index.js |
    sed "s/^export const FLUX_SCHEMA_VERSION = [0-9]*;/export const FLUX_SCHEMA_VERSION = $injected_number;/" > "$1/index.js"
  grep -q "^export const FLUX_SCHEMA_VERSION = $injected_number;" "$1/index.js" || fail "could not set the schema version of the injected migration"
  chmod 644 "$1/$injected_file" "$1/index.js"
  printf 'services:\n  migrate:\n    volumes:\n      - %s:/app/packages/db/migrations/%s:ro,z\n      - %s:/app/packages/db/dist/index.js:ro,z\n' "$1/$injected_file" "$injected_file" "$1/index.js" > "$1/compose.inject.yaml"
}
set_env() { # file, key, value: replaces the key's line or appends it (a value with no `#`)
  if grep -q "^$2=" "$1"; then sed "s#^$2=.*#$2=$3#" "$1" > "$1.edit" && mv "$1.edit" "$1"; else printf '%s=%s\n' "$2" "$3" >> "$1"; fi
  chmod 600 "$1"
}
make_env() { # template, destination, port, [agents]: INSTALL.md's values; with `agents` also the three switches of "Agents on your own AI key", on the provider mock
  python3 "$root/scripts/release/write_test_env.py" --source "$1" --destination "$2" --port "$3"
  if [ "${4:-}" = agents ]; then
    [ -f "$background_key" ] || { head -c 32 /dev/urandom > "$background_key"; chmod 644 "$background_key"; }
    set_env "$2" FLUX_PERSONAL_RUNS on
    set_env "$2" FLUX_AI_PRIVATE_TARGETS provider-mock
    set_env "$2" FLUX_BACKGROUND_KEY_HOST_FILE "$background_key"
  fi
}
restore_env_from() { # source environment file, destination, port
  sed -e "s/^FLUX_PORT=.*/FLUX_PORT=$3/" -e "s#^FLUX_PUBLIC_ORIGIN=.*#FLUX_PUBLIC_ORIGIN=http://127.0.0.1:$3#" "$1" > "$2"
  chmod 600 "$2"
}

# ---------------------------------------------------------------------------------------------------------
if [ "$legs" = all ]; then
  step "Leg 1: clean install of the candidate, paired backup and restore"
  # The environment template is the downloaded asset, filled in exactly as INSTALL.md instructs.
  make_env "$assets/env.example" "$source_env" "$source_port"
  restore_env_from "$source_env" "$restore_env" "$restore_port"

  dc "$source_project" "$source_env" "$assets" config --quiet
  dc "$source_project" "$source_env" "$assets" pull
  dc "$source_project" "$source_env" "$assets" up -d --wait --wait-timeout "$wait_timeout"
  health "$source_port" >/dev/null
  echo "running: api $(dc "$source_project" "$source_env" "$assets" exec -T api uname -m), db $(dc "$source_project" "$source_env" "$assets" exec -T db uname -m)"
  FLUX_SETUP_TOKEN=$(sed -n 's/^FLUX_SETUP_TOKEN=//p' "$source_env") python3 "$root/scripts/release/smoke_data.py" seed --origin "http://127.0.0.1:$source_port" --state "$state_dir/account.json"
  # The database holds the account; this file in the files volume proves the paired archive too.
  probe=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
  write_probe "$source_project" "$source_env" "$assets" "$probe"
  paired_backup "$source_project" "$source_env" "$assets" "$state_dir"
  restore_backup "$restore_project" "$restore_env" "$assets" "$state_dir" "$restore_port"
  python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$state_dir/account.json" --write
  check_probe "$restore_project" "$restore_env" "$assets" "$probe"
  echo 'Packaged clean install, backup and restore passed.'
fi

if [ -z "$previous_assets" ]; then
  echo 'Upgrade leg not run: FLUX_SMOKE_PREVIOUS_ASSETS is not set (the first release has no previous release).'
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------
down "$restore_project" "$restore_env"
down "$source_project" "$source_env"
previous_version=$(json_field "$previous_assets/release.json" version)
candidate_version=$(json_field "$assets/release.json" version)
previous_digest=${previous_image##*@}
candidate_digest=${candidate_image##*@}
step "Leg 2: upgrade $previous_version ($previous_digest) to $candidate_version ($candidate_digest), then backup and restore"
mkdir -p "$up_dir"
make_env "$previous_assets/env.example" "$up_env" "$source_port" agents
restore_env_from "$up_env" "$up_restore_env" "$restore_port"
candidate_ledger=$(expected_ledger)
[ -n "$candidate_ledger" ] || fail "no migration files found under app/packages/db/migrations"

echo "-- 1. the previous release, installed from its own assets"
dc "$source_project" "$up_env" "$previous_assets" config --quiet
dc "$source_project" "$up_env" "$previous_assets" pull
dc "$source_project" "$up_env" "$previous_assets" up -d --wait --wait-timeout "$wait_timeout"
health "$source_port" >/dev/null
FLUX_SETUP_TOKEN=$(sed -n 's/^FLUX_SETUP_TOKEN=//p' "$up_env") python3 "$root/scripts/release/smoke_data.py" seed --origin "http://127.0.0.1:$source_port" --state "$up_dir/account.json" --provider-url "$provider_url"
up_probe=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
write_probe "$source_project" "$up_env" "$previous_assets" "$up_probe"
if [ -n "${FLUX_SMOKE_DUMP:-}" ]; then
  # The seeded database as the previous release wrote it (plain INSERTs, no owners): a fixture of app/tests/app/released-databases.test.ts.
  mkdir -p "$(dirname "$FLUX_SMOKE_DUMP")"
  dc "$source_project" "$up_env" "$previous_assets" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --inserts' |
    grep -v '^\\' | gzip -9n > "$FLUX_SMOKE_DUMP"
  echo "dumped the seeded database of $previous_version to $FLUX_SMOKE_DUMP ($(wc -c < "$FLUX_SMOKE_DUMP") bytes)"
fi
schema_before=$(schema_version "$source_port")
ledger "$source_project" "$up_env" "$previous_assets" | tr ',' '\n' > "$up_dir/ledger.before"
table_columns "$source_project" "$up_env" "$previous_assets" > "$up_dir/columns"
[ "$(grep -c . "$up_dir/columns")" -ge 5 ] || fail "fewer than five content tables found in the previous release"
echo "previous release: schemaVersion $schema_before, $(grep -c . "$up_dir/ledger.before") ledger rows, $(grep -c . "$up_dir/columns") content tables compared"

echo "-- 2. paired backup with the previous release's files, then stop its writers"
paired_backup "$source_project" "$up_env" "$previous_assets" "$up_dir/backup-previous"
dc "$source_project" "$up_env" "$previous_assets" up -d --wait --wait-timeout "$wait_timeout"
dc "$source_project" "$up_env" "$previous_assets" stop api worker
table_snapshot "$source_project" "$up_env" "$previous_assets" "$up_dir/columns" > "$up_dir/tables.before"
volume_stamps "$source_project" > "$up_dir/volumes.before"
sql "$source_project" "$up_env" "$previous_assets" "SELECT current_setting('server_version_num')::int / 10000" > "$up_dir/major.before"

echo "-- 3. pull and start the candidate with the same environment file and project"
if [ -n "$inject" ]; then
  echo "NEGATIVE CONTROL: the candidate carries a migration that breaks the old data; this leg must fail"
  make_injection "$up_dir/injected"; inject_overlay="$up_dir/injected/compose.inject.yaml"
fi
started=$(date +%s)
dc "$source_project" "$up_env" "$assets" config --quiet
dc "$source_project" "$up_env" "$assets" pull
if [ -n "$inject" ]; then
  # The negative control: this upgrade must stop at the injected migration, and the leg ends here, failed, saying why.
  if dc "$source_project" "$up_env" "$assets" up -d --wait --wait-timeout "$wait_timeout" > "$up_dir/inject.out" 2>&1; then
    fail "NEGATIVE CONTROL FAILED: the upgrade with a migration that breaks the old data succeeded"
  fi
  tail -n 4 "$up_dir/inject.out"
  migrate_log=$(docker logs "$(docker ps -aq --filter "label=com.docker.compose.project=$source_project" --filter "label=com.docker.compose.service=migrate" | head -n 1)" 2>&1 || true)
  printf '%s\n' "$migrate_log" | tail -n 6
  printf '%s' "$migrate_log" | grep -q 'upgrade_check_no_messages' || fail "the upgrade stopped, but not at the injected migration"
  fail "the upgrade stopped at the injected migration $injected_file (the negative control: this leg is meant to fail)"
fi
dc "$source_project" "$up_env" "$assets" up -d --wait --wait-timeout "$wait_timeout"
downtime=$(( $(date +%s) - started ))
dc "$source_project" "$up_env" "$assets" ps

echo "-- 4. data and migrations survived"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$(dc "$source_project" "$up_env" "$assets" ps -aq migrate)")" = 0 ] || fail "the migrate service did not exit 0"
schema_after=$(schema_version "$source_port")
[ -n "$schema_after" ] && [ "$schema_after" -ge "$schema_before" ] || fail "schemaVersion went from $schema_before to '${schema_after:-none}'"
dc "$source_project" "$up_env" "$assets" stop api worker
ledger_after=$(ledger "$source_project" "$up_env" "$assets")
[ "$ledger_after" = "$candidate_ledger" ] || fail "the ledger after the upgrade ($ledger_after) is not the candidate's migration files ($candidate_ledger)"
printf '%s\n' "$ledger_after" | tr ',' '\n' > "$up_dir/ledger.after"
[ -z "$(comm -23 <(sort "$up_dir/ledger.before") <(sort "$up_dir/ledger.after"))" ] || fail "a ledger row of the previous release is gone"
table_snapshot "$source_project" "$up_env" "$assets" "$up_dir/columns" > "$up_dir/tables.after"
cmp "$up_dir/tables.before" "$up_dir/tables.after" || { diff "$up_dir/tables.before" "$up_dir/tables.after" >&2 || true; fail "content rows changed across the upgrade"; }
[ "$(volume_stamps "$source_project")" = "$(cat "$up_dir/volumes.before")" ] || fail "a volume was recreated by the upgrade"
database_check "$source_project" "$up_env" "$assets"
dc "$source_project" "$up_env" "$assets" up -d --wait --wait-timeout "$wait_timeout"
health "$source_port" >/dev/null
python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$source_port" --state "$up_dir/account.json" --write
check_probe "$source_project" "$up_env" "$assets" "$up_probe"
echo "upgrade: schemaVersion $schema_before -> $schema_after; ledger $(grep -c . "$up_dir/ledger.before") -> $(grep -c . "$up_dir/ledger.after") rows (+$(( $(grep -c . "$up_dir/ledger.after") - $(grep -c . "$up_dir/ledger.before") ))); $(grep -c . "$up_dir/tables.after") content tables identical; downtime from stopping the writers to healthy $downtime s"

echo "-- 5. paired backup of the upgraded installation, restored with the candidate's files"
paired_backup "$source_project" "$up_env" "$assets" "$up_dir/backup-upgraded"
down "$source_project" "$up_env"
restore_backup "$restore_project" "$up_restore_env" "$assets" "$up_dir/backup-upgraded" "$restore_port"
python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$up_dir/account.json"
check_probe "$restore_project" "$up_restore_env" "$assets" "$up_probe"
[ "$(ledger "$restore_project" "$up_restore_env" "$assets")" = "$candidate_ledger" ] || fail "the restored upgraded installation has another ledger"
down "$restore_project" "$up_restore_env"

echo "-- 6. recovery path: the pre-upgrade backup with the previous release's files, then the upgrade"
restore_backup "$restore_project" "$up_restore_env" "$previous_assets" "$up_dir/backup-previous" "$restore_port"
python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$up_dir/account.json"
check_probe "$restore_project" "$up_restore_env" "$previous_assets" "$up_probe"
[ "$(schema_version "$restore_port")" = "$schema_before" ] || fail "the restored previous release reports another schemaVersion"
dc "$restore_project" "$up_restore_env" "$previous_assets" stop api worker
dc "$restore_project" "$up_restore_env" "$assets" config --quiet
dc "$restore_project" "$up_restore_env" "$assets" up -d --wait --wait-timeout "$wait_timeout"
[ "$(schema_version "$restore_port")" = "$schema_after" ] || fail "the restored installation did not reach schemaVersion $schema_after"
[ "$(ledger "$restore_project" "$up_restore_env" "$assets")" = "$candidate_ledger" ] || fail "the restored and upgraded installation has another ledger"
python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$up_dir/account.json" --write
check_probe "$restore_project" "$up_restore_env" "$assets" "$up_probe"

if [ -n "$recovery" ]; then
  echo "-- 7. a migration that breaks the old data: the upgrade stops, and the paired backup of the previous release restores"
  make_injection "$up_dir/broken"
  down "$restore_project" "$up_restore_env"
  restore_backup "$restore_project" "$up_restore_env" "$previous_assets" "$up_dir/backup-previous" "$restore_port"
  python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$up_dir/account.json"
  paired_backup "$restore_project" "$up_restore_env" "$previous_assets" "$up_dir/backup-before-break"
  inject_overlay="$up_dir/broken/compose.inject.yaml"
  dc "$restore_project" "$up_restore_env" "$assets" config --quiet
  if dc "$restore_project" "$up_restore_env" "$assets" up -d --wait --wait-timeout "$wait_timeout" > "$up_dir/break.out" 2>&1; then
    fail "the upgrade with a migration that breaks the old data succeeded"
  fi
  tail -n 3 "$up_dir/break.out"
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$(dc "$restore_project" "$up_restore_env" "$assets" ps -aq migrate)")" != 0 ] || fail "the migrate service exited 0 with a broken migration"
  dc "$restore_project" "$up_restore_env" "$assets" logs --no-color migrate 2>&1 | grep -q 'upgrade_check_no_messages' || fail "the migrate service did not name the failing migration"
  [ -z "$(dc "$restore_project" "$up_restore_env" "$assets" ps -q --status running api worker)" ] || fail "API or worker run after a failed migration"
  if health "$restore_port" >/dev/null 2>&1; then fail "the instance answers after a failed migration"; fi
  case ",$(ledger "$restore_project" "$up_restore_env" "$assets")," in *,"$injected_number",*) fail "the failed migration is in the ledger" ;; esac
  echo "the broken migration $injected_file stopped the upgrade: migrate failed naming it, API and worker did not start, the ledger lacks $injected_number"
  inject_overlay=""
  down "$restore_project" "$up_restore_env"
  restore_backup "$restore_project" "$up_restore_env" "$previous_assets" "$up_dir/backup-before-break" "$restore_port"
  [ "$(schema_version "$restore_port")" = "$schema_before" ] || fail "the restored previous release reports another schemaVersion"
  python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$up_dir/account.json" --write
  check_probe "$restore_project" "$up_restore_env" "$previous_assets" "$up_probe"
  echo "restored from the backup taken before the failed upgrade: $previous_version reads back and accepts new work"
fi

echo "Packaged upgrade $previous_version ($previous_digest) to $candidate_version ($candidate_digest), backup and restore passed."
