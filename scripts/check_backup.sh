#!/bin/sh
# End-to-end check of ./flux backup, restore, export and upgrade (issue #123) in Docker, on
# isolated copies of this checkout with their own path-derived Compose projects, ports, volumes
# and image tags. It never touches the checkout's own .env or any other Compose project.
#
#  1. Fresh restore with real data: checkout A runs ./flux up and ./flux demo, then
#     scripts/backup-fixture.mjs adds conversations, a DM, a private note, a project sketch,
#     work/decision/result with links, a doc with two versions, a push subscription, a revoked
#     and a live session, three OAuth agent connections with bearers (one revoked before the
#     backup, one after it, and one for native task Undo) and an outsider; a file is put into the files volume. ./flux export
#     is checked for content and exclusions. ./flux backup refuses when the writers cannot be
#     confirmed stopped, keeps two backups of the same second apart, and prunes with --keep 1;
#     restore is refused when not confirmed, for a damaged archive, a manifest that disagrees
#     with its dump's migration ledger, a newer schema, and a ledger version this image lacks
#     (before any data is replaced). An exact ledger restores plainly. A's
#     volumes are destroyed, a fresh checkout B restores the archive, and the fixture verifies
#     through B's API: the same data, versions and links, sessions, sign-in, permissions and
#     agent access as of the backup; restore --revoke-agent-connections then ends all of it.
#  2. Upgrade: checkout U starts the previous version with its demo, its files are replaced by the next version,
#     ./flux upgrade migrates forward and the demo data is verified. The previous version is FLUX_UPGRADE_FROM, else
#     the newest commit on main's first-parent history since the v0.1 baseline (#779) with other migrations than this
#     tree. Before any such commit exists (v0.1 itself), it is this tree and the next version is this tree plus one
#     synthetic migration (0002, or the next number), so the upgrade path is exercised on the real baseline. The
#     pre-upgrade backup (a subset of the new image's migrations) is refused without --migrate and restored with it. A
#     broken migration then makes ./flux upgrade fail with restore instructions, which are followed. Failures after the
#     new version started (health probe, partial start) stop and confirm the writers and warn that work since the start
#     is not in the backup; an unconfirmed stop is reported as such. Finally the previous version is restored from the
#     pre-upgrade backup and upgraded again.
#  3. AC-10 of F-030 (encrypted workspaces): checkout E, a test deployment (encrypted spaces are fixture-only until S3),
#     seeds an encrypted space with a canary project name and a plain control, backs up, then changes the unlock
#     password. The archive (database as SQL, files, env, manifest) holds the canary in no encoding and the control in
#     plain text. After ./flux restore the space is locked, the later password does not open it, the password of
#     backup time does, and ./flux export of its project exits non-zero with "is encrypted. Export it from the app.".
#     FLUX_BACKUP_CASES=encryption runs only this case.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
unset FLUX_PROJECT FLUX_PUBLIC_ORIGIN
base_port=${FLUX_BACKUP_TEST_PORT:-19571}
port_a=$base_port port_b=$((base_port + 3)) port_u=$((base_port + 6))
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-backup-check.XXXXXX")
work=$(cd "$work" && pwd -P)
A="$work/a/flux" B="$work/b/flux" U="$work/u/flux" E="$work/e/flux" port_e=$((base_port + 9))

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Each checkout gets its own ports; its Compose project comes from its path.
flux_a() { FLUX_PORT=$port_a FLUX_DEV_PORT=$((port_a + 1)) FLUX_MAILPIT_PORT=$((port_a + 2)) "$A/flux" "$@"; }
# B replaces A on A's address after A is destroyed: OAuth issuer and audience are the origin.
flux_b() { FLUX_PORT=$port_a FLUX_PUBLIC_ORIGIN="http://127.0.0.1:$port_a" FLUX_DEV_PORT=$((port_b + 1)) FLUX_MAILPIT_PORT=$((port_b + 2)) "$B/flux" "$@"; }
flux_e() { FLUX_PORT=$port_e FLUX_DEV_PORT=$((port_e + 1)) FLUX_MAILPIT_PORT=$((port_e + 2)) "$E/flux" "$@"; }
flux_u() { FLUX_PORT=$port_u FLUX_DEV_PORT=$((port_u + 1)) FLUX_MAILPIT_PORT=$((port_u + 2)) "$U/flux" "$@"; }
env_path() { if [ -f "$1/docker/.env" ]; then printf '%s/docker/.env' "$1"; else printf '%s/.env' "$1"; fi; }
migration_dir() { if [ -d "$1/app/packages/db/migrations" ]; then printf '%s/app/packages/db/migrations' "$1"; else printf '%s/packages/db/migrations' "$1"; fi; }
project_of() { sed -n 's/^FLUX_PROJECT=//p' "$(env_path "$1")"; }
env_of() { sed -n "s/^$2=//p" "$(env_path "$1")" | tail -n 1; }
compose_in() { # checkout args...
  checkout=$1; shift
  if [ -f "$checkout/docker/compose.source.yaml" ]; then
    compose_dir="$checkout/docker" compose_file="$checkout/docker/compose.source.yaml"
  else
    compose_dir="$checkout/infra" compose_file="$checkout/infra/compose.yaml"
  fi
  docker compose --project-directory "$compose_dir" --env-file "$(env_path "$checkout")" -p "$(project_of "$checkout")" -f "$compose_file" "$@"
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
  # Read the complete NUL-delimited inventory in one archive. xargs may split a large
  # checkout into multiple tar invocations; an extractor then stops after the first archive.
  (cd "$here" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | (cd "$1" && tar -xf -)
}
schema_of_tree() { ls "$(migration_dir "$1")" | sed -n 's/^\([0-9]\{4\}\)_.*\.sql$/\1/p' | sort | tail -n 1 | sed 's/^0*//'; }
migrations_of_ref() { git -C "$here" ls-tree --name-only "$1" packages/db/migrations/ app/packages/db/migrations/ | sed -n 's#^.*/\([0-9]\{4\}_.*\.sql\)$#\1#p' | sort; }
migrations_of_tree() { ls "$(migration_dir "$1")" | grep -E '^[0-9]{4}_.*\.sql$' | sort; }
schema_of_ref() { migrations_of_ref "$1" | tail -n 1 | sed 's/^\([0-9]*\)_.*/\1/; s/^0*//'; }

oauth_client="flux-backup-check-$$"

cleanup() {
  status=$?
  for checkout in "$A" "$B" "$U" "$E"; do
    if [ "$status" -ne 0 ] && [ -f "$(env_path "$checkout")" ]; then compose_in "$checkout" logs --no-color --tail 60 2>/dev/null || true; fi
    if [ -x "$checkout/flux" ] && [ -f "$(env_path "$checkout")" ]; then "$checkout/flux" clean -y >/dev/null 2>&1 || true; fi
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

# AC-10 (F-030): see 3. in the header.
encryption_case() {
  step "AC-10: an encrypted space's backup holds no content; restored, it is locked and opens only with the password of backup time"
  copy_tree "$E"
  flux_e up >/dev/null
  printf 'FLUX_TEST_FAILURE_INJECTION=true\n' >> "$(env_path "$E")"
  flux_e up >/dev/null
  flux_e demo >/dev/null
  enc() { # mode [state-json]
    compose_in "$E" exec -T -e FLUX_FIXTURE_MODE="$1" -e FLUX_FIXTURE_STATE="${2:-}" -e FLUX_PUBLIC_ORIGIN="$(env_of "$E" FLUX_PUBLIC_ORIGIN)" \
      -e FLUX_DEMO_OWNER_PASSWORD="$(env_of "$E" FLUX_DEMO_OWNER_PASSWORD)" -e FLUX_FIXTURE_TOKEN="$(env_of "$E" FLUX_FIXTURE_TOKEN)" \
      api node --input-type=module - < "$here/scripts/encryption-backup-fixture.mjs"
  }
  estate=$(enc seed | sed -n 's/^FLUX_ENCRYPTION //p')
  [ -n "$estate" ] || fail "the encryption fixture did not report its state"
  field() { printf '%s' "$estate" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
  canary=$(field canary) control=$(field control) eproject=$(field projectId)
  [ -n "$canary" ] && [ -n "$control" ] && [ -n "$eproject" ] || fail "incomplete encryption fixture state: $estate"
  flux_e backup --output "$work/e-backups" > "$work/e-backup.out" || { cat "$work/e-backup.out"; fail "backup of E failed"; }
  earchive=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/e-backup.out")
  [ -f "$earchive" ] || fail "no archive of E"
  enc rekey "$estate" | grep -q 'FLUX_ENCRYPTION rekeyed' || fail "changing the unlock password after the backup failed"
  # The AC-7 scanner on the archive: every part, the database as SQL (pg_restore decompresses the custom format).
  mkdir -p "$work/e-unpacked"
  tar -xf "$earchive" -C "$work/e-unpacked"
  compose_in "$E" exec -T db pg_restore -f - < "$work/e-unpacked/database.dump" > "$work/e-dump.sql" || fail "pg_restore could not read the archive's dump"
  tar -xzOf "$work/e-unpacked/files.tar.gz" > "$work/e-files.bin" 2>/dev/null || true
  : > "$work/e-encodings"
  for pad in '' 'x' 'xy'; do
    encoded=$(printf '%s%s' "$pad" "$canary" | base64 | tr -d '\n')
    printf '%s\n' "$encoded" | cut -c5-40 >> "$work/e-encodings"
    printf '%s\n' "$encoded" | tr '+/' '-_' | cut -c5-40 >> "$work/e-encodings"
  done
  { printf '%s\n' "$canary"; printf '%s' "$canary" | od -An -v -tx1 | tr -d ' \n'; echo; printf '%s' "$canary" | sha256sum | cut -d' ' -f1; } >> "$work/e-encodings"
  for part in "$work/e-dump.sql" "$work/e-files.bin" "$work/e-unpacked/flux.env" "$work/e-unpacked/manifest.json" "$earchive"; do
    # Case-insensitive: the search index stores lowercased text.
    if grep -aqiF -f "$work/e-encodings" "$part"; then fail "the backup holds the encrypted space's canary ($(basename "$part"))"; fi
  done
  grep -qF "$control" "$work/e-dump.sql" || fail "positive control: the plain project's name is not in the backup's database"
  echo "archive scanned: $(wc -l < "$work/e-encodings" | tr -d ' ') encodings of the canary, 0 hits; the plain control is there"
  flux_e restore "$earchive" -y > "$work/e-restore.out" 2>&1 || { cat "$work/e-restore.out"; fail "restore of E failed"; }
  [ "$(compose_in "$E" exec -T db psql -X -At -U flux -d flux -c 'SELECT count(*) FROM workspace_unlocks')" = 0 ] || fail "the restore left unlock rows of the backup's server"
  enc restored "$estate" || fail "the restored encrypted space did not behave as AC-10 requires"
  if flux_e export "$eproject" --output "$work/e-export.tar.gz" > "$work/e-export.out" 2>&1; then fail "./flux export of an encrypted space succeeded"; fi
  grep -q 'is encrypted. Export it from the app.' "$work/e-export.out" || fail "no encrypted-space refusal: $(cat "$work/e-export.out")"
  [ ! -e "$work/e-export.tar.gz" ] || fail "a refused export left a file"
  flux_e clean -y >/dev/null
}

if [ "${FLUX_BACKUP_CASES:-all}" = encryption ]; then
  encryption_case
  step "PASS: AC-10 encrypted-space backup and restore"
  exit 0
fi

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
  VALUES (gen_random_uuid()::text, '$oauth_client', 'Backup check client', ARRAY['http://127.0.0.1:19737/callback'], 'none', ARRAY['authorization_code'], ARRAY['code'], ARRAY['flux.context.read','flux.action.execute'], true, now(), now());
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
# The fixture publishes a binary attachment through HTTP; the operator CLI must export its
# exact bytes and the paired restore later rechecks them through the authorized download.
file_id=$(printf '%s' "$state" | sed -n 's/.*"fileId":"\([0-9a-f-]*\)".*/\1/p')
file_hex=$(printf '%s' "$state" | sed -n 's/.*"fileHex":"\([0-9a-f]*\)".*/\1/p')
[ -n "$file_id" ] && [ -n "$file_hex" ] || fail "no binary attachment fixture"
[ "$(od -An -v -tx1 "$bundle/files/$file_id" | tr -d ' \n')" = "$file_hex" ] || fail "CLI export attachment bytes differ"
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
# The identity provider's offline refresh tokens (F-024 S4, #311) stay out of the archive: the table's definition is
# there, its rows are not.
toc=$(compose_in "$A" exec -T db pg_restore --list < "$work/unpacked/database.dump")
printf '%s\n' "$toc" | grep -Eq ' TABLE public auth_idp_standing ' || fail "the backup lacks the auth_idp_standing definition"
if printf '%s\n' "$toc" | grep -Eq 'TABLE DATA public auth_idp_standing '; then fail "the backup holds rows of auth_idp_standing"; fi
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
# The manifest names one version more than its dump (with only the v0.1 baseline, dropping one would leave the same list).
repack edited "s/\"appliedMigrations\": \[$ledger\]/\"appliedMigrations\": [$ledger,$((schema + 1))]/" ''
if flux_a restore "$work/edited.tar" --migrate -y > "$work/edited.out" 2>&1; then fail "a manifest that disagrees with its dump was restored"; fi
grep -q "the dump's migration ledger {$ledger} differs from the manifest's" "$work/edited.out" || fail "no ledger/manifest refusal: $(cat "$work/edited.out")"
repack newer "s/\"schemaVersion\": $schema,/\"schemaVersion\": $((schema + 1)),/" ''
if flux_a restore "$work/newer.tar" --migrate -y > "$work/newer.out" 2>&1; then fail "a newer schema was restored"; fi
grep -q "newer than this checkout" "$work/newer.out" || fail "no newer-schema refusal: $(cat "$work/newer.out")"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" >/dev/null || fail "refused restores stopped A"

if [ "$(migrations_of_tree "$A" | wc -l)" -ge 2 ]; then
step "A backup whose ledger has a version this image lacks is refused before any data is replaced"
# The checkout loses a migration below the highest one: the backup's ledger now names a
# version without a file here (same max(version)), as a backup from another branch would.
foreign=$(migrations_of_tree "$A" | tail -n 2 | head -n 1)
mv "$A/app/packages/db/migrations/$foreign" "$work/$foreign"
before_start=$(api_started)
messages_before=$(compose_in "$A" exec -T db psql -X -tA -U flux -d flux -c 'SELECT count(*) FROM project_messages')
if flux_a restore "$archive" --migrate -y > "$work/foreign.out" 2>&1; then fail "a backup with a foreign migration version was restored"; fi
grep -q "refused before replacing any data: the backup's migration ledger has versions without files in this image: $(printf '%s' "$foreign" | sed 's/_.*//; s/^0*//')" "$work/foreign.out" \
  || fail "no foreign-version refusal: $(cat "$work/foreign.out")"
if grep -q 'Replacing the data' "$work/foreign.out"; then fail "the foreign-version restore started replacing data"; fi
[ "$(api_started)" = "$before_start" ] || fail "the refused restore restarted A"
[ "$(compose_in "$A" exec -T db psql -X -tA -U flux -d flux -c 'SELECT count(*) FROM project_messages')" = "$messages_before" ] || fail "the refused restore changed A's data"
curl -fsS "http://127.0.0.1:$port_a/api/v1/health" | grep -q '"status":"ok"' || fail "A is not healthy after the refused restore"
mv "$work/$foreign" "$A/app/packages/db/migrations/$foreign"
else
  # v0.1: the only file is the baseline, so no backup can hold a lower version this tree lacks. The refusal itself is
  # covered by migration-ledger.test.ts (phantom rows); this step returns with the first migration after the baseline.
  step "SKIP: a foreign ledger version needs two migrations; this tree has only the v0.1 baseline"
fi

step "Destroy A's volumes, then restore the archive into a fresh checkout B"
flux_a reset -y >/dev/null
for volume in "${run_a}_pgdata" "${run_a}_files"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then fail "reset left $volume"; fi
done
[ ! -f "$B/docker/.env" ] || fail "B is not fresh"
flux_b restore "$archive" -y > "$work/restore.out" 2>&1 || { cat "$work/restore.out"; fail "restore into B failed"; }
tail -n 7 "$work/restore.out"
grep -q 'NOTE: 2 agent connection(s) are active as of the backup' "$work/restore.out" || fail "restore did not warn about both restored agent connections"
run_b=$(project_of "$B")
[ -n "$run_b" ] && [ "$run_b" != "$run_a" ] || fail "B did not use its own project ($run_b)"
[ "$(ls -l "$B/docker/.env" | cut -c1-10)" = "-rw-------" ] || fail "restored .env is not private"
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
grep -q 'Revoked 2 agent connection(s)' "$work/revoke.out" || fail "no revocation report: $(tail -n 5 "$work/revoke.out")"
fixture "$B" agents-revoked "$state"
flux_b clean -y >/dev/null
flux_a clean -y >/dev/null

step "Upgrade from the previous version's schema"
baseline=0001_v0_1_baseline.sql
migrations_of_tree "$here" > "$work/migrations.now"
grep -qx "$baseline" "$work/migrations.now" || fail "this tree has no $baseline"
from=${FLUX_UPGRADE_FROM:-}
if [ -z "$from" ]; then
  main_ref=$(git -C "$here" merge-base HEAD origin/main 2>/dev/null || git -C "$here" merge-base HEAD main)
  for commit in $(git -C "$here" rev-list --first-parent --max-count=200 "$main_ref"); do
    migrations_of_ref "$commit" > "$work/migrations.from"
    # Pre-release schemas before the baseline cannot be upgraded (#779); stop at the first of them.
    grep -qx "$baseline" "$work/migrations.from" || break
    if ! cmp -s "$work/migrations.from" "$work/migrations.now"; then from=$commit; break; fi
  done
fi
# The previous version's files, then the next version's: a commit and this tree, or this tree and this tree
# plus one synthetic migration (its number in FLUX_SCHEMA_VERSION, as a real next migration would have it).
from_tree() { # target
  mkdir -p "$1"
  if [ -n "$from" ]; then git -C "$here" archive "$from" | tar -xf - -C "$1"; else copy_tree "$1"; fi
}
to_tree() { # target
  copy_tree "$1"
  if [ -z "$from" ]; then
    printf -- '-- check_backup.sh: a synthetic next migration over the v0.1 baseline.\nCREATE TABLE upgrade_check_marker (id integer PRIMARY KEY);\n' \
      > "$1/app/packages/db/migrations/${synthetic}_upgrade_check.sql"
    sed -i.orig "s/^export const FLUX_SCHEMA_VERSION = [0-9]*;/export const FLUX_SCHEMA_VERSION = $synthetic_version;/" "$1/app/packages/db/src/index.ts"
    rm -f "$1/app/packages/db/src/index.ts.orig"
    grep -q "^export const FLUX_SCHEMA_VERSION = $synthetic_version;" "$1/app/packages/db/src/index.ts" || fail "could not set the synthetic schema version"
  fi
}
if [ -n "$from" ]; then
  migrations_of_ref "$from" > "$work/migrations.from"
  from_schema=$(schema_of_ref "$from") from_label=$(git -C "$here" log -1 --format='%h %s' "$from")
else
  cp "$work/migrations.now" "$work/migrations.from"
  from_schema=$(schema_of_tree "$here") from_label="this tree (no main commit since the v0.1 baseline adds a migration)"
  synthetic_version=$((from_schema + 1)); synthetic=$(printf '%04d' "$synthetic_version")
fi
mkdir -p "$work/next"
to_tree "$work/next"
current=$(schema_of_tree "$work/next")
migrations_of_tree "$work/next" > "$work/migrations.next"
rm -rf "$work/next"
new_migrations=$(comm -13 "$work/migrations.from" "$work/migrations.next")
[ -n "$new_migrations" ] || fail "the next version adds no migration"
echo "upgrading from $from_label (schema $from_schema) to schema $current; new migrations:" $new_migrations
from_tree "$U"
(FLUX_PROJECT="flux-upgrade-check-$$"; export FLUX_PROJECT; flux_u up >/dev/null)
flux_u demo >/dev/null
run_u=$(project_of "$U")
# `git pull`: the files of the checkout change, .env and the data stay.
original_env=$(env_path "$U")
env_relative=${original_env#"$U"/}
original_env_hash=$(sha256 "$original_env")
cp "$original_env" "$work/upgrade.env"
find "$U" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
to_tree "$U"
mkdir -p "$(dirname "$U/$env_relative")"
cp "$work/upgrade.env" "$U/$env_relative"
chmod 600 "$U/$env_relative"
if echo n | flux_u upgrade > "$work/upgrade-cancel.out" 2>&1; then fail "upgrade without confirmation succeeded"; fi
flux_u upgrade -y > "$work/upgrade.out" 2>&1 || { cat "$work/upgrade.out"; fail "upgrade failed"; }
tail -n 4 "$work/upgrade.out"
[ "$(project_of "$U")" = "$run_u" ] || fail "the upgrade changed the stored custom project"
[ "$(sha256 "$U/$env_relative")" = "$original_env_hash" ] || fail "the upgrade changed env bytes"

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
printf 'SELECT 1 / 0;\n' > "$U/app/packages/db/migrations/9998_broken_upgrade_check.sql"
if flux_u upgrade -y > "$work/broken.out" 2>&1; then fail "an upgrade with a failing migration succeeded"; fi
grep -q 'UPGRADE FAILED: the migration failed' "$work/broken.out" || { cat "$work/broken.out"; fail "no failure report"; }
broken_archive=$(sed -n 's/^Backup written: \(.*\.tar\) (.*/\1/p' "$work/broken.out")
grep -q "./flux restore '$broken_archive'" "$work/broken.out" || fail "no restore instruction for $broken_archive"
rm -f "$U/app/packages/db/migrations/9998_broken_upgrade_check.sql"
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
# Health fails, then both stopping and asking Compose what runs fail: nothing is claimed.
mkdir -p "$work/shim-noinspect"; rm -f "$work/health-failed"
printf '#!/bin/sh\ncase "$*" in *exec*api*/api/v1/health*) : > "%s/health-failed"; exit 1 ;; *" stop "*|*" ps "*) [ -e "%s/health-failed" ] && { echo "shim: refused" >&2; exit 1; } ;; esac\nexec %s "$@"\n' "$work" "$work" "$real_docker" > "$work/shim-noinspect/docker"
chmod +x "$work/shim-noinspect/docker"
if (PATH="$work/shim-noinspect:$PATH"; export PATH; flux_u upgrade -y) > "$work/upgrade-noinspect.out" 2>&1; then fail "upgrade with failing health, stop and ps succeeded"; fi
grep -q 'Could not check whether API and worker stopped' "$work/upgrade-noinspect.out" || { cat "$work/upgrade-noinspect.out"; fail "an unknown writer state was not reported"; }
if grep -q 'nothing was written after\|are stopped now' "$work/upgrade-noinspect.out"; then fail "an unknown writer state was reported as stopped"; fi
[ "$(running_u)" = "api worker" ] || fail "the shim should have left both writers running: $(running_u)"
# A backup whose writer state cannot be read stops nothing and writes nothing, and a backup
# whose state after the stop cannot be read brings back what was running. Actual API and
# worker state is checked, not only the archive count.
[ "$(running_u)" = "api worker" ] || fail "both writers should run before the inspection cases: $(running_u)"
mkdir -p "$work/shim-ps-before" "$work/shim-ps-after"
printf '#!/bin/sh\ncase "$*" in *" ps --status running"*) exit 1 ;; esac\nexec %s "$@"\n' "$real_docker" > "$work/shim-ps-before/docker"
printf '#!/bin/sh\ncase "$*" in *" stop "*) : > "%s/stopped-once" ;; *" ps --status running"*) [ -e "%s/stopped-once" ] && exit 1 ;; esac\nexec %s "$@"\n' "$work" "$work" "$real_docker" > "$work/shim-ps-after/docker"
chmod +x "$work/shim-ps-before/docker" "$work/shim-ps-after/docker"
archives() { ls "$work/backups" 2>/dev/null | grep -c '\.tar$' || true; }
before_ps=$(archives)
if (PATH="$work/shim-ps-before:$PATH"; export PATH; flux_u backup --output "$work/backups") > "$work/backup-ps-before.out" 2>&1; then fail "a backup ran although the writer state was unknown before the stop"; fi
grep -q 'Could not check which Flux services are running' "$work/backup-ps-before.out" || { cat "$work/backup-ps-before.out"; fail "no refusal before the stop"; }
[ "$(archives)" = "$before_ps" ] || fail "an archive was written although the writer state was unknown"
[ "$(running_u)" = "api worker" ] || fail "writers stopped although the backup refused before the stop: $(running_u)"
rm -f "$work/stopped-once"
if (PATH="$work/shim-ps-after:$PATH"; export PATH; flux_u backup --output "$work/backups") > "$work/backup-ps-after.out" 2>&1; then fail "a backup ran although the state after the stop was unknown"; fi
grep -q 'Could not check whether API and worker stopped' "$work/backup-ps-after.out" || { cat "$work/backup-ps-after.out"; fail "no refusal after the stop"; }
[ "$(archives)" = "$before_ps" ] || fail "an archive was written although the state after the stop was unknown"
[ "$(running_u)" = "api worker" ] || fail "the writers that were running were not brought back: $(running_u)"
step "Go back to the previous version from the pre-upgrade backup, keep the custom project, then upgrade again"
cp "$upgrade_archive" "$work/rollback.tar"
compose_in "$U" stop api worker >/dev/null
cp "$(env_path "$U")" "$work/rollback.env"
find "$U" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
from_tree "$U"
mkdir -p "$(dirname "$U/$env_relative")"
cp "$work/rollback.env" "$U/$env_relative"
chmod 600 "$U/$env_relative"
flux_u restore "$work/rollback.tar" -y > "$work/rollback.out" 2>&1 || { cat "$work/rollback.out"; fail "restoring the previous version failed"; }
[ "$(project_of "$U")" = "$run_u" ] || fail "rollback lost the custom project"
flux_u demo | grep -q 'already exists; nothing new was seeded' || fail "rollback lost the original demo data"
cp "$(env_path "$U")" "$work/rollback.env"
find "$U" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
to_tree "$U"
mkdir -p "$(dirname "$U/$env_relative")"
cp "$work/rollback.env" "$U/$env_relative"
chmod 600 "$U/$env_relative"
flux_u upgrade -y > "$work/reupgrade.out" 2>&1 || { cat "$work/reupgrade.out"; fail "re-upgrade after the rollback failed"; }
[ "$(project_of "$U")" = "$run_u" ] || fail "re-upgrade lost the custom project"
flux_u demo | grep -q 'already exists; nothing new was seeded' || fail "re-upgrade lost restored data"
flux_u clean -y >/dev/null

encryption_case

step "PASS: backup, restore into a fresh project, agent access, export, upgrade from ${from:+$(git -C "$here" rev-parse --short "$from")}${from:-this tree} (+$(printf '%s\n' "$new_migrations" | wc -l | tr -d ' ') migrations) and failed-upgrade recovery"
