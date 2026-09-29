#!/bin/sh
# End-to-end check of ./flux backup, restore, export and upgrade (issue #123) in Docker, on
# isolated copies of this checkout with their own path-derived Compose projects, ports, volumes
# and image tags. It never touches the checkout's own .env or any other Compose project.
#
#  1. Fresh restore with real data: checkout A runs ./flux up and ./flux demo, then
#     scripts/backup-fixture.mjs adds conversations, a DM, a private note, a project sketch,
#     work/decision/result with links, a doc with two versions, a push subscription, a revoked
#     and a live session, two OAuth agent connections with bearers (#52; one revoked before the
#     backup, one after it) and an outsider; a file is put into the files volume. ./flux export
#     is checked for content and exclusions. ./flux backup refuses when the writers cannot be
#     confirmed stopped, keeps two backups of the same second apart, and prunes with --keep 1;
#     restore is refused when not confirmed, for a damaged archive, a manifest that disagrees
#     with its dump's migration ledger, a newer schema, and a ledger version this image lacks
#     (before any data is replaced). An exact ledger restores plainly. A's
#     volumes are destroyed, a fresh checkout B restores the archive, and the fixture verifies
#     through B's API: the same data, versions and links, sessions, sign-in, permissions and
#     agent access as of the backup; restore --revoke-agent-connections then ends all of it.
#  2. Upgrade: checkout U starts the previous main's version (the newest commit on main's
#     first-parent history with other migrations than this tree, or FLUX_UPGRADE_FROM) with its demo, its files are replaced by this tree,
#     ./flux upgrade migrates forward and the demo data is verified. The pre-upgrade backup (a
#     subset of this image's migrations) is refused without --migrate and restored with it. A broken migration then
#     makes ./flux upgrade fail with restore instructions, which are followed. Failures after the
#     new version started (health probe, partial start) stop and confirm the writers and warn that
#     work since the start is not in the backup; an unconfirmed stop is reported as such.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
unset FLUX_PROJECT FLUX_PUBLIC_ORIGIN
base_port=${FLUX_BACKUP_TEST_PORT:-19571}
port_a=$base_port port_b=$((base_port + 3)) port_u=$((base_port + 6))
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-backup-check.XXXXXX")
work=$(cd "$work" && pwd -P)
A="$work/a/flux" B="$work/b/flux" U="$work/u/flux"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Each checkout gets its own ports; its Compose project comes from its path.
flux_a() { FLUX_PORT=$port_a FLUX_DEV_PORT=$((port_a + 1)) FLUX_MAILPIT_PORT=$((port_a + 2)) "$A/flux" "$@"; }
# B replaces A on A's address after A is destroyed: OAuth issuer and audience are the origin.
flux_b() { FLUX_PORT=$port_a FLUX_PUBLIC_ORIGIN="http://127.0.0.1:$port_a" FLUX_DEV_PORT=$((port_b + 1)) FLUX_MAILPIT_PORT=$((port_b + 2)) "$B/flux" "$@"; }
flux_u() { FLUX_PORT=$port_u FLUX_DEV_PORT=$((port_u + 1)) FLUX_MAILPIT_PORT=$((port_u + 2)) "$U/flux" "$@"; }
project_of() { sed -n 's/^FLUX_PROJECT=//p' "$1/.env"; }
env_of() { sed -n "s/^$2=//p" "$1/.env" | tail -n 1; }
compose_in() { # checkout args...
  checkout=$1; shift
  docker compose --project-directory "$checkout/infra" --env-file "$checkout/.env" -p "$(project_of "$checkout")" -f "$checkout/infra/compose.yaml" "$@"
}
# Runs scripts/backup-fixture.mjs inside a checkout's API container.
fixture() { # checkout mode [state-json]
  compose_in "$1" exec -T -e FLUX_FIXTURE_MODE="$2" -e FLUX_FIXTURE_STATE="${3:-}" -e FLUX_FIXTURE_OAUTH_CLIENT="$oauth_client" \
    -e FLUX_PUBLIC_ORIGIN="$(env_of "$1" FLUX_PUBLIC_ORIGIN)" \
    -e FLUX_DEMO_OWNER_PASSWORD="$(env_of "$1" FLUX_DEMO_OWNER_PASSWORD)" -e FLUX_DEMO_PARTNER_PASSWORD="$(env_of "$1" FLUX_DEMO_PARTNER_PASSWORD)" \
    api node --input-type=module - < "$here/scripts/backup-fixture.mjs"
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
copy_tree() { # target
  mkdir -p "$1"
  (cd "$here" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf - 2>/dev/null) | (cd "$1" && tar -xf -)
}
schema_of_tree() { ls "$1/packages/db/migrations" | sed -n 's/^\([0-9]\{4\}\)_.*\.sql$/\1/p' | sort | tail -n 1 | sed 's/^0*//'; }
migrations_of_ref() { git -C "$here" ls-tree --name-only "$1" packages/db/migrations/ | sed -n 's#^.*/\([0-9]\{4\}_.*\.sql\)$#\1#p' | sort; }
migrations_of_tree() { ls "$1/packages/db/migrations" | grep -E '^[0-9]{4}_.*\.sql$' | sort; }
schema_of_ref() { migrations_of_ref "$1" | tail -n 1 | sed 's/^\([0-9]*\)_.*/\1/; s/^0*//'; }

oauth_client="flux-backup-check-$$"

cleanup() {
  status=$?
  for checkout in "$A" "$B" "$U"; do
    if [ "$status" -ne 0 ] && [ -f "$checkout/.env" ]; then compose_in "$checkout" logs --no-color --tail 60 2>/dev/null || true; fi
    if [ -x "$checkout/flux" ] && [ -f "$checkout/.env" ]; then "$checkout/flux" clean -y >/dev/null 2>&1 || true; fi
    docker volume ls -q --filter "label=com.flux.checkout=$checkout" | xargs docker volume rm >/dev/null 2>&1 || true
  done
  rm -rf "${work:?}"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

step "Preflight: Docker is reachable and there are at least 20 GB free"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable (this check never restarts it)"
free_kb=$(df -Pk "$work" | awk 'NR == 2 { print $4 }')
[ "$free_kb" -ge 20971520 ] || fail "only $((free_kb / 1048576)) GB free on $(df -P "$work" | awk 'NR == 2 { print $6 }'); need 20 GB"
echo "Docker $(docker info --format '{{.ServerVersion}}'), $((free_kb / 1048576)) GB free"

step "Copy the working tree to $A and $B"
copy_tree "$A"
copy_tree "$B"
cd "$work"

step "Checkout A: ./flux up, ./flux demo and the real-data fixture"
flux_a up >/dev/null
flux_a demo >/dev/null
run_a=$(project_of "$A")
# A local OAuth client, inserted as tests/app/oauth-mcp.test.ts does (no external client metadata).
compose_in "$A" exec -T db psql -X -q -v ON_ERROR_STOP=1 -U flux -d flux -c "
  INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
  VALUES (gen_random_uuid()::text, '$oauth_client', 'Backup check client', ARRAY['http://127.0.0.1:19737/callback'], 'none', ARRAY['authorization_code'], ARRAY['code'], ARRAY['flux.context.read'], true, now(), now());
  INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES (gen_random_uuid()::text, '$oauth_client', 'http://127.0.0.1:$port_a/mcp', now());"
seed_out=$(fixture "$A" seed)
state=$(printf '%s\n' "$seed_out" | sed -n 's/^FLUX_FIXTURE //p')
[ -n "$state" ] || fail "the fixture did not report its state: $seed_out"
printf '%s' "$state" > "$work/state.json"
tag=$(printf '%s' "$state" | sed -n 's/^{"tag":"\([0-9a-f]*\)".*/\1/p')
[ -n "$tag" ] || fail "no fixture tag"
head -c 300000 /dev/urandom > "$work/upload.bin"
compose_in "$A" --profile ops run --rm --no-deps -T files-archive sh -c 'mkdir -p /data/files/uploads && cat > /data/files/uploads/sentinel.bin && chown -R 1000:1000 /data/files/uploads' < "$work/upload.bin"
upload_sha=$(sha256 "$work/upload.bin")
echo "seeded fixture $tag and a 300 kB file (sha256 $upload_sha)"

step "./flux export writes the project bundle without DMs, private notes or other projects"
flux_a export 'Community garden sensors' --output "$work/export.tar.gz"
mkdir -p "$work/export"
tar -xzf "$work/export.tar.gz" -C "$work/export"
bundle=$(ls -d "$work"/export/flux-project-*)
[ -f "$bundle/project.json" ] && [ -f "$bundle/manifest.json" ] && [ -f "$bundle/schema/project-export.v1.schema.json" ] || fail "bundle files missing"
for word in BACKUP-message BACKUP-reply BACKUP-thought BACKUP-work BACKUP-decision BACKUP-result BACKUP-doc-v1 BACKUP-doc-v2 'Moisture first'; do
  grep -q "$word" "$bundle/project.json" || fail "export lacks $word"
done
if grep -rq -e "BACKUP-private" -e "BACKUP-dm" -e 'Before Thursday' -e 'Quick one before Thursday' "$bundle"; then fail "export leaks a private note or a DM"; fi
grep -q '"name": "Ada Kowalska"' "$bundle/project.json" || fail "export has no exporter name"
grep -q '"reimportSupported": false' "$bundle/project.json" || fail "export does not state that re-import is unsupported"
sed -n 's/^ *"path": "\([^"]*\)",$/\1/p' "$bundle/manifest.json" > "$work/manifest-paths"
[ -s "$work/manifest-paths" ] || fail "empty bundle manifest"
while read -r path; do
  expected=$(grep -A2 "\"path\": \"$path\"" "$bundle/manifest.json" | sed -n 's/^ *"sha256": "\([0-9a-f]*\)".*/\1/p')
  [ "$(sha256 "$bundle/$path")" = "$expected" ] || fail "bundle checksum mismatch for $path"
done < "$work/manifest-paths"
ls "$bundle"/docs/*.md >/dev/null 2>&1 || fail "bundle has no docs/*.md"
if flux_a export 'Community garden sensors' --as jonas@demo.flux.test --output "$work/denied.tar.gz" > "$work/denied.out" 2>&1; then fail "a member without project.manage exported"; fi
grep -q 'may not manage' "$work/denied.out" || fail "no project.manage refusal: $(cat "$work/denied.out")"
[ ! -e "$work/denied.tar.gz" ] || fail "a refused export left a file"

step "./flux backup refuses when the writers cannot be confirmed stopped, and restarts nothing it did not stop"
# A docker shim whose `compose ... stop` fails without stopping anything.
real_docker=$(command -v docker)
mkdir -p "$work/shim-stop" "$work/shim-date"
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = stop ] && { echo "shim: stop refused" >&2; exit 1; }; done\nexec %s "$@"\n' "$real_docker" > "$work/shim-stop/docker"
# A date shim: every backup starts in the same UTC second.
printf '#!/bin/sh\n[ "$*" = "-u +%%Y%%m%%dT%%H%%M%%SZ" ] && { echo 20260101T000000Z; exit 0; }\nexec /bin/date "$@"\n' > "$work/shim-date/date"
chmod +x "$work/shim-stop/docker" "$work/shim-date/date"
api_started() { docker inspect -f '{{.State.StartedAt}}' "$(compose_in "$A" ps -q api)"; }
before_start=$(api_started)
# Subshells: an assignment before a shell function call can outlive the call in sh.
if (PATH="$work/shim-stop:$PATH"; export PATH; flux_a backup --output "$work/backups") > "$work/stopfail.out" 2>&1; then fail "a backup ran although the writers were not stopped"; fi
grep -q 'Could not confirm that API and worker are stopped (still running: api worker; stop failed). No backup was written.' "$work/stopfail.out" \
  || fail "no stop refusal: $(cat "$work/stopfail.out")"
[ -z "$(ls -A "$work/backups" 2>/dev/null)" ] || fail "the refused backup left files: $(ls -A "$work/backups")"
[ "$(api_started)" = "$before_start" ] || fail "the refused backup restarted the API it had not stopped"
[ ! -e "$A/.flux-backup-lock-$run_a" ] || fail "the refused backup left its lock"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" | grep -q '"status":"ok"' || fail "API not healthy after the refused backup"

step "./flux backup (twice in one second, then --keep 1) stops the writers, writes checked archives and restarts them"
(PATH="$work/shim-date:$PATH"; export PATH; flux_a backup --output "$work/backups") > "$work/backup1.out"
cat "$work/backup1.out"
grep -q 'Stopping api worker so the database and files are captured at one point in time' "$work/backup1.out" || fail "backup did not stop API and worker"
first=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/backup1.out")
[ -f "$first" ] || fail "no archive reported"
(PATH="$work/shim-date:$PATH"; export PATH; flux_a backup --output "$work/backups") > "$work/backup2.out"
second=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/backup2.out")
case "$first$second" in *20260101T000000Z-*20260101T000000Z-*) ;; *) fail "the date shim did not apply: $first $second" ;; esac
[ -f "$first" ] && [ -f "$second" ] && [ "$first" != "$second" ] || fail "a backup in the same second replaced the first ($first, $second)"
flux_a backup --output "$work/backups" --keep 1 > "$work/backup3.out"
archive=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/backup3.out")
[ -f "$archive" ] || fail "third archive missing"
[ ! -e "$first" ] && [ ! -e "$second" ] || fail "--keep 1 kept an older archive"
[ "$(ls "$work/backups" | grep -c '\.tar$')" = 1 ] || fail "--keep 1 left $(ls "$work/backups")"
grep -q "Removed old backup" "$work/backup3.out" || fail "--keep 1 did not report the pruning"
[ "$(ls -l "$archive" | cut -c1-10)" = "-rw-------" ] || fail "archive is not private"
(cd "$(dirname "$archive")" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$(basename "$archive").sha256"; else shasum -a 256 -c "$(basename "$archive").sha256"; fi) >/dev/null || fail "archive .sha256 does not match"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" | grep -q '"status":"ok"' || fail "API not healthy after the backup"
mkdir -p "$work/unpacked"
tar -xf "$archive" -C "$work/unpacked"
manifest="$work/unpacked/manifest.json"
schema=$(schema_of_tree "$A")
grep -q "\"schemaVersion\": $schema," "$manifest" || fail "manifest schema is not $schema: $(cat "$manifest")"
ledger=$(migrations_of_tree "$A" | sed 's/_.*//; s/^0*//' | paste -sd, -)
grep -q "\"appliedMigrations\": \[$ledger\]," "$manifest" || fail "manifest ledger is not [$ledger]: $(cat "$manifest")"
grep -q '"appVersion": "0.1.0"' "$manifest" && grep -q '"consistency": "api and worker stopped' "$manifest" || fail "manifest fields missing"
grep -q '"image": "sha256:' "$manifest" && grep -q '"postgresImage": "postgres@sha256:' "$manifest" || fail "manifest image digests missing"
for part in database.dump files.tar.gz flux.env; do
  grep -q "{\"name\": \"$part\", \"bytes\": $(wc -c < "$work/unpacked/$part" | tr -d ' '), \"sha256\": \"$(sha256 "$work/unpacked/$part")\"}" "$manifest" \
    || fail "manifest checksum of $part is wrong"
done
tar -tzf "$work/unpacked/files.tar.gz" | grep -q 'uploads/sentinel.bin' || fail "files archive lacks the uploaded file"
fixture "$A" revoke-live "$state"

step "./flux restore asks first, and refuses damaged archives and other versions"
if echo n | flux_a restore "$archive" > "$work/cancel.out" 2>&1; then fail "restore without confirmation succeeded"; fi
grep -q 'Cancelled; nothing was changed' "$work/cancel.out" || fail "no cancel message: $(cat "$work/cancel.out")"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" >/dev/null || fail "cancelled restore stopped A"
repack() { # name manifest-sed dump-append
  rm -rf "$work/repack" && mkdir -p "$work/repack" && tar -xf "$archive" -C "$work/repack"
  sed "$2" "$work/repack/manifest.json" > "$work/repack/m" && mv "$work/repack/m" "$work/repack/manifest.json"
  [ -z "$3" ] || printf '%s' "$3" >> "$work/repack/database.dump"
  (cd "$work/repack" && tar -cf "$work/$1.tar" manifest.json database.dump files.tar.gz flux.env)
}
repack damaged 's/x/x/' 'tampered'
if flux_a restore "$work/damaged.tar" -y > "$work/damaged.out" 2>&1; then fail "a damaged archive was restored"; fi
grep -q 'database.dump does not match its checksum' "$work/damaged.out" || fail "no checksum refusal: $(cat "$work/damaged.out")"
repack edited "s/\"appliedMigrations\": \[$ledger\]/\"appliedMigrations\": [${ledger%,*}]/" ''
if flux_a restore "$work/edited.tar" --migrate -y > "$work/edited.out" 2>&1; then fail "a manifest that disagrees with its dump was restored"; fi
grep -q "the dump's migration ledger {$ledger} differs from the manifest's" "$work/edited.out" || fail "no ledger/manifest refusal: $(cat "$work/edited.out")"
repack newer "s/\"schemaVersion\": $schema,/\"schemaVersion\": $((schema + 1)),/" ''
if flux_a restore "$work/newer.tar" --migrate -y > "$work/newer.out" 2>&1; then fail "a newer schema was restored"; fi
grep -q "newer than this checkout" "$work/newer.out" || fail "no newer-schema refusal: $(cat "$work/newer.out")"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" >/dev/null || fail "refused restores stopped A"

step "A backup whose ledger has a version this image lacks is refused before any data is replaced"
# The checkout loses a migration below the highest one: the backup's ledger now names a
# version without a file here (same max(version)), as a backup from another branch would.
foreign=$(migrations_of_tree "$A" | tail -n 2 | head -n 1)
mv "$A/packages/db/migrations/$foreign" "$work/$foreign"
before_start=$(api_started)
messages_before=$(compose_in "$A" exec -T db psql -X -tA -U flux -d flux -c 'SELECT count(*) FROM project_messages')
if flux_a restore "$archive" --migrate -y > "$work/foreign.out" 2>&1; then fail "a backup with a foreign migration version was restored"; fi
grep -q "refused before replacing any data: the backup's migration ledger has versions without files in this image: $(printf '%s' "$foreign" | sed 's/_.*//; s/^0*//')" "$work/foreign.out" \
  || fail "no foreign-version refusal: $(cat "$work/foreign.out")"
if grep -q 'Replacing the data' "$work/foreign.out"; then fail "the foreign-version restore started replacing data"; fi
[ "$(api_started)" = "$before_start" ] || fail "the refused restore restarted A"
[ "$(compose_in "$A" exec -T db psql -X -tA -U flux -d flux -c 'SELECT count(*) FROM project_messages')" = "$messages_before" ] || fail "the refused restore changed A's data"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" | grep -q '"status":"ok"' || fail "A is not healthy after the refused restore"
mv "$work/$foreign" "$A/packages/db/migrations/$foreign"

step "Destroy A's volumes, then restore the archive into a fresh checkout B"
flux_a reset -y >/dev/null
for volume in "${run_a}_pgdata" "${run_a}_files"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then fail "reset left $volume"; fi
done
[ ! -f "$B/.env" ] || fail "B is not fresh"
flux_b restore "$archive" -y > "$work/restore.out" 2>&1 || { cat "$work/restore.out"; fail "restore into B failed"; }
tail -n 7 "$work/restore.out"
grep -q 'NOTE: 1 agent connection(s) are active as of the backup' "$work/restore.out" || fail "restore did not warn about restored agent connections"
run_b=$(project_of "$B")
[ -n "$run_b" ] && [ "$run_b" != "$run_a" ] || fail "B did not use its own project ($run_b)"
[ "$(ls -l "$B/.env" | cut -c1-10)" = "-rw-------" ] || fail "restored .env is not private"
[ "$(env_of "$B" FLUX_AUTH_SECRET)" = "$(env_of "$A" FLUX_AUTH_SECRET)" ] || fail "restored .env has other secrets"
[ "$(env_of "$B" FLUX_PORT)" = "$port_a" ] || fail "restored .env did not take the port from the shell"
grep -q "Migrations: the backup's migration ledger matches this image exactly" "$work/restore.out" || fail "restore did not report the exact ledger match"
grep -q "Health: {\"status\":\"ok\",\"schemaVersion\":$schema}.*(migration ledger matches this image: $ledger)" "$work/restore.out" || fail "restore did not report the health and exact ledger check"
fixture "$B" verify "$state"
compose_in "$B" --profile ops run --rm --no-deps -T files-archive cat /data/files/uploads/sentinel.bin > "$work/restored.bin"
[ "$(sha256 "$work/restored.bin")" = "$upload_sha" ] || fail "the uploaded file changed in the restore"
owner_uid=$(compose_in "$B" --profile ops run --rm --no-deps -T files-archive stat -c %u /data/files/uploads/sentinel.bin | tr -d '\r')
[ "$owner_uid" = 1000 ] || fail "restored file belongs to uid $owner_uid, not the API user"
flux_b restore "$archive" --revoke-agent-connections -y > "$work/revoke.out" 2>&1 || { cat "$work/revoke.out"; fail "restore --revoke-agent-connections failed"; }
grep -q 'Revoked 1 agent connection(s)' "$work/revoke.out" || fail "no revocation report: $(tail -n 5 "$work/revoke.out")"
fixture "$B" agents-revoked "$state"
flux_b clean -y >/dev/null
flux_a clean -y >/dev/null

step "Upgrade from the previous main's schema"
current=$(schema_of_tree "$here")
migrations_of_tree "$here" > "$work/migrations.now"
from=${FLUX_UPGRADE_FROM:-}
if [ -z "$from" ]; then
  main_ref=$(git -C "$here" merge-base HEAD origin/main 2>/dev/null || git -C "$here" merge-base HEAD main)
  for commit in $(git -C "$here" rev-list --first-parent --max-count=200 "$main_ref"); do
    migrations_of_ref "$commit" > "$work/migrations.from"
    if ! cmp -s "$work/migrations.from" "$work/migrations.now"; then from=$commit; break; fi
  done
fi
[ -n "$from" ] || fail "no main commit with other migrations than this tree; set FLUX_UPGRADE_FROM"
migrations_of_ref "$from" > "$work/migrations.from"
new_migrations=$(comm -13 "$work/migrations.from" "$work/migrations.now")
[ -n "$new_migrations" ] || fail "$from has no migration that this tree adds"
from_schema=$(schema_of_ref "$from")
echo "upgrading from $(git -C "$here" log -1 --format='%h %s' "$from") (schema $from_schema) to this tree (schema $current); new migrations:" $new_migrations
mkdir -p "$U"
git -C "$here" archive "$from" | tar -xf - -C "$U"
flux_u up >/dev/null
flux_u demo >/dev/null
run_u=$(project_of "$U")
# `git pull`: the files of the checkout change, .env and the data stay.
find "$U" -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
copy_tree "$U"
if echo n | flux_u upgrade > "$work/upgrade-cancel.out" 2>&1; then fail "upgrade without confirmation succeeded"; fi
flux_u upgrade -y > "$work/upgrade.out" 2>&1 || { cat "$work/upgrade.out"; fail "upgrade failed"; }
tail -n 4 "$work/upgrade.out"
grep -q "Upgraded $run_u from schema $from_schema to $current" "$work/upgrade.out" || fail "upgrade did not report schema $from_schema -> $current"
for migration in $new_migrations; do
  grep -q "Applied migration $migration" "$work/upgrade.out" || fail "upgrade did not apply $migration"
done
upgrade_archive=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/upgrade.out")
[ -f "$upgrade_archive" ] || fail "upgrade wrote no backup"
tar -xOf "$upgrade_archive" manifest.json | grep -q "\"schemaVersion\": $from_schema," || fail "the upgrade backup is not of schema $from_schema"
fixture "$U" demo

step "The pre-upgrade backup (a subset of this image's migrations) restores only with --migrate"
if flux_u restore "$upgrade_archive" -y > "$work/subset.out" 2>&1; then fail "a backup lacking migrations was restored without --migrate"; fi
grep -q 'refused before replacing any data: the backup lacks migrations of this image' "$work/subset.out" || fail "no subset refusal: $(cat "$work/subset.out")"
curl -fsS "http://127.0.0.1:$port_u/api/v1/health" | grep -q '"status":"ok"' || fail "U stopped by the refused restore"
flux_u restore "$upgrade_archive" --migrate -y > "$work/subset-migrate.out" 2>&1 || { cat "$work/subset-migrate.out"; fail "restore --migrate of the pre-upgrade backup failed"; }
grep -q "they are applied after the restore" "$work/subset-migrate.out" || fail "restore --migrate did not list the missing migrations"
for migration in $new_migrations; do
  grep -q "Applied migration $migration" "$work/subset-migrate.out" || fail "restore --migrate did not apply $migration"
done
grep -q "migration ledger matches this image" "$work/subset-migrate.out" || fail "restore --migrate did not end with an exact ledger"
fixture "$U" demo

step "A failing upgrade prints restore instructions that work"
printf 'SELECT 1 / 0;\n' > "$U/packages/db/migrations/9998_broken_upgrade_check.sql"
if flux_u upgrade -y > "$work/broken.out" 2>&1; then fail "an upgrade with a failing migration succeeded"; fi
grep -q 'UPGRADE FAILED: the migration failed' "$work/broken.out" || { cat "$work/broken.out"; fail "no failure report"; }
broken_archive=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/broken.out")
grep -q "./flux restore '$broken_archive'" "$work/broken.out" || fail "no restore instruction for $broken_archive"
rm -f "$U/packages/db/migrations/9998_broken_upgrade_check.sql"
flux_u restore "$broken_archive" -y > "$work/after-broken.out" 2>&1 || { cat "$work/after-broken.out"; fail "following the restore instructions failed"; }
fixture "$U" demo

running_u() { "$real_docker" compose -p "$run_u" ps --status running --services 2>/dev/null | grep -E '^(api|worker)$' | sort | paste -sd' ' -; }
step "A failure after the new version started stops the writers and says work may be missing"
# Only the final health probe fails; `up --wait` has already started API and worker.
mkdir -p "$work/shim-health" "$work/shim-partial" "$work/shim-health-stop"
printf '#!/bin/sh\ncase "$*" in *exec*api*/api/v1/health*) echo "shim: health probe failed" >&2; exit 1 ;; esac\nexec %s "$@"\n' "$real_docker" > "$work/shim-health/docker"
# The start itself reports failure after starting the containers (a partial start).
printf '#!/bin/sh\ncase "$*" in *" up -d --wait "*api*worker*) %s "$@"; exit 1 ;; esac\nexec %s "$@"\n' "$real_docker" "$real_docker" > "$work/shim-partial/docker"
# Health fails, and every stop after that is refused (the backup before it may stop them).
printf '#!/bin/sh\ncase "$*" in *exec*api*/api/v1/health*) : > "%s/health-failed"; exit 1 ;; *" stop "*) [ -e "%s/health-failed" ] && { echo "shim: stop refused" >&2; exit 1; } ;; esac\nexec %s "$@"\n' "$work" "$work" "$real_docker" > "$work/shim-health-stop/docker"
chmod +x "$work/shim-health/docker" "$work/shim-partial/docker" "$work/shim-health-stop/docker"
for case_name in health partial; do
  if (PATH="$work/shim-$case_name:$PATH"; export PATH; flux_u upgrade -y) > "$work/upgrade-$case_name.out" 2>&1; then fail "upgrade with a failing $case_name step succeeded"; fi
  grep -q 'UPGRADE FAILED' "$work/upgrade-$case_name.out" || { cat "$work/upgrade-$case_name.out"; fail "no failure report ($case_name)"; }
  grep -q 'API and worker of the new version ran from .* and are stopped now' "$work/upgrade-$case_name.out" || { cat "$work/upgrade-$case_name.out"; fail "the report does not say the new version ran ($case_name)"; }
  grep -q 'NOT in that backup' "$work/upgrade-$case_name.out" || fail "the report does not warn about work after the backup ($case_name)"
  if grep -q 'nothing was written after' "$work/upgrade-$case_name.out"; then fail "the report claims nothing was written ($case_name)"; fi
  [ -z "$(running_u)" ] || fail "API/worker still running after a failed upgrade ($case_name): $(running_u)"
  flux_u up > /dev/null 2>&1 || fail "could not start again after the $case_name case"
done
if (PATH="$work/shim-health-stop:$PATH"; export PATH; flux_u upgrade -y) > "$work/upgrade-nostop.out" 2>&1; then fail "upgrade with failing health and stop succeeded"; fi
grep -q 'Could not stop api worker' "$work/upgrade-nostop.out" || { cat "$work/upgrade-nostop.out"; fail "an unconfirmed stop was not reported"; }
if grep -q 'nothing was written after\|are stopped now' "$work/upgrade-nostop.out"; then fail "an unconfirmed stop was reported as stopped"; fi
[ "$(running_u)" = "api worker" ] || fail "the shim should have left both writers running: $(running_u)"
flux_u clean -y >/dev/null

step "PASS: backup, restore into a fresh project, agent access, export, upgrade from $(git -C "$here" rev-parse --short "$from") (+$(printf '%s\n' "$new_migrations" | wc -l | tr -d ' ') migrations) and failed-upgrade recovery"
