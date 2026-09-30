#!/bin/sh
# #58 / #118: old protected-main image -> this committed head on one PostgreSQL/files volume.
# Baseline and candidate are immutable git archives; only Docker executes the application.
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
compose() {
  docker compose --project-directory "$checkout/infra" --env-file "$checkout/.env" -p "$project" -f "$checkout/infra/compose.yaml" "$@"
}
cleanup() {
  status=$?
  if [ -f "$checkout/.env" ]; then
    project=$(sed -n 's/^FLUX_PROJECT=//p' "$checkout/.env")
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
expected_ledger() { ls "$checkout/packages/db/migrations" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)_.*\.sql$/\1/p' | sort -n | sed 's/^0*//' | paste -sd, -; }
snapshot() {
  for table in workspaces workspace_members projects project_grants drafts project_materials project_material_versions project_conversations project_messages sketches sketch_thoughts sketch_links project_work_items project_decisions project_results project_object_links; do
    compose exec -T db psql -X -tA -v ON_ERROR_STOP=1 -U flux -d flux -c \
      "SELECT '$table:' || count(*) || ':' || md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM $table t"
  done
}
echo "Baseline $from -> candidate $candidate; isolated same-volume rehearsal"
"$checkout/flux" up > "$work/baseline-up.log" 2>&1 || { cat "$work/baseline-up.log"; exit 1; }
"$checkout/flux" demo > "$work/demo.log" 2>&1 || { cat "$work/demo.log"; exit 1; }
project=$(sed -n 's/^FLUX_PROJECT=//p' "$checkout/.env")
origin=$(sed -n 's/^FLUX_PUBLIC_ORIGIN=//p' "$checkout/.env")
owner_password=$(sed -n 's/^FLUX_DEMO_OWNER_PASSWORD=//p' "$checkout/.env")
prepared=$(compose exec -T -e FLUX_UPGRADE_PHASE=prepare -e FLUX_PUBLIC_ORIGIN="$origin" -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" \
  api node --input-type=module - < "$here/scripts/proactive-upgrade-fixture.mjs")
state=$(printf '%s\n' "$prepared" | sed -n 's/^FLUX_UPGRADE_STATE //p')
[ -n "$state" ] || { echo 'Missing prepared fixture state'; exit 1; }
compose stop api worker >/dev/null
old_ledger=$(ledger)
[ "$old_ledger" = "$(expected_ledger)" ] || { echo 'Baseline ledger does not match baseline files'; exit 1; }
snapshot > "$work/before.snapshot"
volume="${project}_pgdata"
volume_created=$(docker volume inspect -f '{{.CreatedAt}}' "$volume")
# Preserve this checkout's .env and volumes; replace only its source like an ordinary update.
find "$checkout" -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
git -C "$here" archive "$candidate" | tar -xf - -C "$checkout"
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
echo "PASS: same PostgreSQL volume, exact ledger {$old_ledger} -> {$new_files}, immutable content/session retention, usable new schema and idempotent migration."
