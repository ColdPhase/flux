#!/usr/bin/env bash
# Exercise a downloaded, digest-pinned Compose package in two isolated projects.
# Ports default to 18081 (installation) and 18082 (restore); set FLUX_SMOKE_PORT and
# FLUX_SMOKE_RESTORE_PORT for a machine where those are taken.
set -euo pipefail

assets=${1:?release asset directory required}
state_dir=${2:?temporary state directory required}
source_project=${3:?source project name required}
restore_project=${4:?restore project name required}
source_port=${FLUX_SMOKE_PORT:-18081}
restore_port=${FLUX_SMOKE_RESTORE_PORT:-18082}
mkdir -p "$state_dir"
assets=$(realpath "$assets")
state_dir=$(realpath "$state_dir")
compose_file="$assets/compose.yaml"
source_env="$state_dir/source.env"
restore_env="$state_dir/restore.env"

source_compose() {
  docker compose --env-file "$source_env" -p "$source_project" -f "$compose_file" "$@"
}
restore_compose() {
  docker compose --env-file "$restore_env" -p "$restore_project" -f "$compose_file" "$@"
}
cleanup() {
  restore_compose down -v --remove-orphans >/dev/null 2>&1 || true
  source_compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The environment template is the downloaded asset, filled in exactly as INSTALL.md instructs.
python3 scripts/release/write_test_env.py \
  --source "$assets/env.example" --destination "$source_env" --port "$source_port"
sed -e "s/^FLUX_PORT=.*/FLUX_PORT=$restore_port/" \
  -e "s#^FLUX_PUBLIC_ORIGIN=.*#FLUX_PUBLIC_ORIGIN=http://127.0.0.1:$restore_port#" \
  "$source_env" > "$restore_env"
chmod 600 "$restore_env"

source_compose config --quiet
source_compose pull
source_compose up -d --wait --wait-timeout 300
curl --fail --show-error --silent "http://127.0.0.1:$source_port/api/v1/health" >/dev/null
python3 scripts/release/smoke_data.py seed \
  --origin "http://127.0.0.1:$source_port" --state "$state_dir/account.json"
# The database holds the account; this file in the files volume proves the paired archive too.
probe=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
source_compose run -T --rm --no-deps --entrypoint sh api \
  -c 'printf %s "$1" > /data/files/restore-probe.txt' probe "$probe"

source_compose stop api worker
source_compose exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "$state_dir/database.dump"
source_compose run -T --rm --no-deps --entrypoint tar api \
  -C /data/files -cf - . > "$state_dir/files.tar"
test -s "$state_dir/database.dump"
test -s "$state_dir/files.tar"
tar -tf "$state_dir/files.tar" > "$state_dir/files.list"
grep -q 'restore-probe\.txt$' "$state_dir/files.list"

restore_compose config --quiet
restore_compose up -d --wait --wait-timeout 300 db
restore_compose exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' \
  < "$state_dir/database.dump"
restore_compose run -T --rm --no-deps --entrypoint tar api \
  -C /data/files -xf - < "$state_dir/files.tar"
restore_compose up -d --wait --wait-timeout 300
curl --fail --show-error --silent "http://127.0.0.1:$restore_port/api/v1/health" >/dev/null
python3 scripts/release/smoke_data.py verify \
  --origin "http://127.0.0.1:$restore_port" --state "$state_dir/account.json"
test "$(restore_compose run -T --rm --no-deps --entrypoint cat api /data/files/restore-probe.txt)" = "$probe"
test "$(restore_compose run -T --rm --no-deps --entrypoint stat api -c %u /data/files/restore-probe.txt)" != 0
echo 'Packaged clean install, backup and restore passed.'
