#!/usr/bin/env bash
# Exercise a downloaded, digest-pinned Compose package in two isolated projects.
set -euo pipefail

assets=${1:?release asset directory required}
state_dir=${2:?temporary state directory required}
source_project=${3:?source project name required}
restore_project=${4:?restore project name required}
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

python3 scripts/release/write_test_env.py \
  --source "$assets/.env.example" --destination "$source_env" --port 18081
sed -e 's/^FLUX_PORT=.*/FLUX_PORT=18082/' \
  -e 's#^FLUX_PUBLIC_ORIGIN=.*#FLUX_PUBLIC_ORIGIN=http://127.0.0.1:18082#' \
  "$source_env" > "$restore_env"
chmod 600 "$restore_env"

source_compose config --quiet
source_compose pull
source_compose up -d --wait
curl --fail --show-error --silent http://127.0.0.1:18081/api/v1/health >/dev/null
python3 scripts/release/smoke_data.py seed \
  --origin http://127.0.0.1:18081 --state "$state_dir/account.json"

source_compose stop api worker
source_compose exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "$state_dir/database.dump"
source_compose run -T --rm --no-deps --entrypoint tar api \
  -C /data/files -cf - . > "$state_dir/files.tar"
test -s "$state_dir/database.dump"
test -s "$state_dir/files.tar"

restore_compose config --quiet
restore_compose up -d --wait db
restore_compose exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' \
  < "$state_dir/database.dump"
restore_compose run -T --rm --no-deps --entrypoint tar api \
  -C /data/files -xf - < "$state_dir/files.tar"
restore_compose up -d --wait
curl --fail --show-error --silent http://127.0.0.1:18082/api/v1/health >/dev/null
python3 scripts/release/smoke_data.py verify \
  --origin http://127.0.0.1:18082 --state "$state_dir/account.json"
echo 'Packaged clean install, backup and restore passed.'
