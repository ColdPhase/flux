#!/usr/bin/env bash
# Exercise a downloaded, digest-pinned Compose package in isolated projects (#77 AC-3).
#
#   smoke_artifacts.sh <assets> <state dir> <install project> <restore project>
#   FLUX_SMOKE_PREVIOUS_ASSETS=<previous release's assets> smoke_artifacts.sh ...   (adds the upgrade leg)
#
# Leg 1, always: a clean install of the candidate's assets, an account, workspace and content created
# through the API, a paired PostgreSQL + files backup and its restore into fresh volumes.
#
# Leg 2, only when FLUX_SMOKE_PREVIOUS_ASSETS names the downloaded assets of the PREVIOUS release (its
# compose.yaml, env.example, release.json, SHA256SUMS): INSTALL.md's upgrade, followed literally.
#   1. Install the previous release, create the same content through its API and a file in the files volume.
#   2. Take a paired backup with the previous release's files, then stop the writers with them.
#   3. Pull and start the candidate's compose.yaml with the SAME environment file and project (same volumes).
#   4. Check that the data and the migrations survived: the migrate service exited 0; /api/v1/health reports a
#      schemaVersion that did not go down; the migration ledger equals the candidate's migration files and
#      contains every earlier row; the rows of the content tables are unchanged (count and md5 over the
#      previous columns); the volumes were not recreated; the account signs in and every created item reads back;
#      the instance accepts a new message.
#   5. Back up the upgraded installation and restore it into fresh volumes with the candidate's files.
#   6. Recovery path: restore the PRE-upgrade backup into fresh volumes with the PREVIOUS release's files,
#      check it there, then upgrade that restored installation to the candidate and check it again.
# The leg does not run in final-release.yml: the first release (v0.1, whose schema is the single baseline of #779)
# has no previous release. The independent
# reviewer runs it with the previous release's downloaded assets and the candidate's draft assets.
#
# Ports default to 18081 (installation) and 18082 (restore); set FLUX_SMOKE_PORT and FLUX_SMOKE_RESTORE_PORT for
# a machine where those are taken. Both legs use them one after the other. Runs on GNU/Linux and macOS (bash 3.2).
set -euo pipefail

assets=${1:?release asset directory required}
state_dir=${2:?temporary state directory required}
source_project=${3:?source project name required}
restore_project=${4:?restore project name required}
previous_assets=${FLUX_SMOKE_PREVIOUS_ASSETS:-}
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
# FLUX_SMOKE_WAIT: seconds `up --wait` allows (default 300; an emulated platform needs more).
wait_timeout=${FLUX_SMOKE_WAIT:-300}
step() { printf '\n== %s\n' "$*"; }
json_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
db_image() { sed -n 's/^ *image: *\(postgres@sha256:[0-9a-f]*\).*/\1/p' "$1/compose.yaml"; }
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
  candidate_image=$(json_field "$assets/release.json" image)
  [ "$previous_image" != "$candidate_image" ] || fail "the previous release and the candidate pin the same image ($candidate_image); nothing would be upgraded"
  [ "$(db_image "$previous_assets")" = "$(db_image "$assets")" ] ||
    fail "the PostgreSQL pin differs between the releases; INSTALL.md says to restore into a fresh installation instead of upgrading in place"
fi

dc() { # project, environment file, assets directory, then docker compose arguments
  local project=$1 env_file=$2 dir=$3
  shift 3
  docker compose --env-file "$env_file" -p "$project" -f "$dir/compose.yaml" "$@"
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
expected_ledger() { # the candidate's migration files, as the migrator numbers them
  ls "$root/app/packages/db/migrations" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)_.*\.sql$/\1/p' | sort -n | sed 's/^0*//' | paste -sd, -
}
# Content tables compared across the upgrade: rows keep their previous columns (a migration may add a column or a
# constraint but must not change or drop a recorded value). Tables the previous release lacks are skipped.
content_tables="workspaces workspace_members projects project_grants drafts project_materials project_material_versions project_conversations project_messages project_work_items project_decisions project_results agents"
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
make_env() { # template, destination, port
  python3 "$root/scripts/release/write_test_env.py" --source "$1" --destination "$2" --port "$3"
}
restore_env_from() { # source environment file, destination, port
  sed -e "s/^FLUX_PORT=.*/FLUX_PORT=$3/" -e "s#^FLUX_PUBLIC_ORIGIN=.*#FLUX_PUBLIC_ORIGIN=http://127.0.0.1:$3#" "$1" > "$2"
  chmod 600 "$2"
}

# ---------------------------------------------------------------------------------------------------------
step "Leg 1: clean install of the candidate, paired backup and restore"
# The environment template is the downloaded asset, filled in exactly as INSTALL.md instructs.
make_env "$assets/env.example" "$source_env" "$source_port"
restore_env_from "$source_env" "$restore_env" "$restore_port"

dc "$source_project" "$source_env" "$assets" config --quiet
dc "$source_project" "$source_env" "$assets" pull
dc "$source_project" "$source_env" "$assets" up -d --wait --wait-timeout "$wait_timeout"
health "$source_port" >/dev/null
echo "running: api $(dc "$source_project" "$source_env" "$assets" exec -T api uname -m), db $(dc "$source_project" "$source_env" "$assets" exec -T db uname -m)"
python3 "$root/scripts/release/smoke_data.py" seed --origin "http://127.0.0.1:$source_port" --state "$state_dir/account.json"
# The database holds the account; this file in the files volume proves the paired archive too.
probe=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
write_probe "$source_project" "$source_env" "$assets" "$probe"
paired_backup "$source_project" "$source_env" "$assets" "$state_dir"
restore_backup "$restore_project" "$restore_env" "$assets" "$state_dir" "$restore_port"
python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$restore_port" --state "$state_dir/account.json" --write
check_probe "$restore_project" "$restore_env" "$assets" "$probe"
echo 'Packaged clean install, backup and restore passed.'

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
make_env "$previous_assets/env.example" "$up_env" "$source_port"
restore_env_from "$up_env" "$up_restore_env" "$restore_port"
candidate_ledger=$(expected_ledger)
[ -n "$candidate_ledger" ] || fail "no migration files found under app/packages/db/migrations"

echo "-- 1. the previous release, installed from its own assets"
dc "$source_project" "$up_env" "$previous_assets" config --quiet
dc "$source_project" "$up_env" "$previous_assets" pull
dc "$source_project" "$up_env" "$previous_assets" up -d --wait --wait-timeout "$wait_timeout"
health "$source_port" >/dev/null
python3 "$root/scripts/release/smoke_data.py" seed --origin "http://127.0.0.1:$source_port" --state "$up_dir/account.json"
up_probe=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
write_probe "$source_project" "$up_env" "$previous_assets" "$up_probe"
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

echo "-- 3. pull and start the candidate with the same environment file and project"
started=$(date +%s)
dc "$source_project" "$up_env" "$assets" config --quiet
dc "$source_project" "$up_env" "$assets" pull
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

echo "Packaged upgrade $previous_version ($previous_digest) to $candidate_version ($candidate_digest), backup and restore passed."
