#!/usr/bin/env bash
# The post-upgrade journeys on a COPY of a real installation (founder request, Hubert, 2026-11-20): a `./flux backup` archive is restored
# into a throwaway project of the release that wrote it, upgraded to this working tree by `./flux upgrade -y`, and read through the API
# as one of its people (scripts/release/smoke_journeys.py real: read only, counts and PASS/FAIL, never a name, a title, a word or a secret).
#
#   scripts/check_backup_upgrade.sh <flux-backup-....tar> <work directory>
#
# The work directory holds the copy's tree, its logs and the report; it must be private and stay on this machine (the restore writes the
# backup's data into Docker volumes of the throwaway project, and the logs name the project). Everything is removed at the end (./flux clean
# -y and the tree); the archive is never changed. The copy cannot reach the outside as the original did: it gets fresh secrets from ./flux up,
# push keys and e-mail are switched off before the data is restored, and the AI key file is not in a backup, so its agents cannot run.
# To sign in, the company's owner gets a new password sign-in in the copy (an owner may use single sign-on only); it is never printed.
#
# Environment: FLUX_BACKUP_CHECK_PORT (default 26500; +1 and +2 are taken too), FLUX_BACKUP_CHECK_PROJECT (default fluxbkc<pid>),
# FLUX_BACKUP_CHECK_OVERRIDE=FILE  copied to the copy's docker/compose.override.yaml (an operator override this host needs).
# FLUX_BACKUP_CHECK_TREE=DIR  an empty folder for the copy's Flux tree (default <work directory>/flux); its images are built from it, so on an
#                             SELinux host it belongs where the repository's checkouts are, not under a home folder (#1606).
# Needs docker with Compose, python3, git and the release's tag in this repository.
set -euo pipefail
archive=$(realpath "${1:?usage: check_backup_upgrade.sh <backup archive> <work directory>}")
work=${2:?usage: check_backup_upgrade.sh <backup archive> <work directory>}
root=$(cd "$(dirname "$0")/.." && pwd)
port=${FLUX_BACKUP_CHECK_PORT:-26500}
project=${FLUX_BACKUP_CHECK_PROJECT:-fluxbkc$$}
fail() { echo "check_backup_upgrade: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
mkdir -p "$work"; chmod 700 "$work"
work=$(cd "$work" && pwd -P)
tree=${FLUX_BACKUP_CHECK_TREE:-$work/flux}
case "$tree" in "$root"/*) fail "FLUX_BACKUP_CHECK_TREE must be outside this checkout: its files would become part of the candidate" ;; esac
mkdir -p "$tree"; tree=$(cd "$tree" && pwd -P)
[ -z "$(ls -A "$tree")" ] || fail "FLUX_BACKUP_CHECK_TREE ($tree) is not empty"
logs="$work/logs"
mkdir -p "$logs"
export XDG_STATE_HOME="$work/state" FLUX_PROJECT="$project" FLUX_PORT="$port" FLUX_DEV_PORT=$((port + 1)) FLUX_MAILPIT_PORT=$((port + 2))
cleanup() {
  status=$?
  if [ -x "$tree/flux" ]; then (cd "$tree" && ./flux clean -y > "$logs/clean.log" 2>&1) || true; fi
  rm -rf "$tree" "$work/state"
  [ "$status" = 0 ] || echo "check_backup_upgrade: failed; the logs are in $logs" >&2
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

manifest=$(tar -xOf "$archive" manifest.json)
value() { printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
version=$(value appVersion); schema=$(value schemaVersion)
tag="v${version#v}"
git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null || fail "the backup was written by Flux $version; this repository has no tag $tag"
echo "backup: schema $schema, written by Flux $version; the copy is project $project on port $port; candidate $(git -C "$root" rev-parse --short HEAD)"

step "1. Flux $tag in a throwaway project, with fresh secrets and no push or e-mail"
git -C "$root" archive "$tag" | tar -xf - -C "$tree"
[ -z "${FLUX_BACKUP_CHECK_OVERRIDE:-}" ] || cp "$FLUX_BACKUP_CHECK_OVERRIDE" "$tree/docker/compose.override.yaml"
(cd "$tree" && ./flux up > "$logs/up.log" 2>&1) || { tail -n 20 "$logs/up.log"; fail "./flux up of $tag failed"; }
quiet_env() {
  local env_file="$tree/docker/.env" key
  for key in FLUX_VAPID_PUBLIC_KEY FLUX_VAPID_PRIVATE_KEY FLUX_VAPID_SUBJECT FLUX_SMTP_URL; do
    if grep -q "^$key=" "$env_file"; then sed -i "s#^$key=.*#$key=#" "$env_file"; else echo "$key=" >> "$env_file"; fi
  done
  chmod 600 "$env_file"
}
quiet_env

step "2. Restore the backup into it"
# A source checkout names no release version (git archive has no commit), so the same schema is restored with --migrate, which
# then has nothing to migrate: the upgrade below is the step under test.
(cd "$tree" && ./flux restore "$archive" --migrate -y > "$logs/restore.log" 2>&1) || { tail -n 20 "$logs/restore.log"; fail "./flux restore failed"; }
grep -q "^FLUX_VAPID_PRIVATE_KEY=$" "$tree/docker/.env" || fail "the copy has push keys after the restore"
curl -fsS "http://127.0.0.1:$port/api/v1/health" | grep -q "\"schemaVersion\":$schema" || fail "the restored copy does not answer at schema $schema"

step "3. ./flux upgrade -y to this working tree"
cp "$tree/docker/.env" "$work/copy.env"
[ ! -f "$tree/docker/compose.override.yaml" ] || cp "$tree/docker/compose.override.yaml" "$work/override.yaml"
find "$tree" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
(cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | (cd "$tree" && tar -xf -)
mkdir -p "$tree/docker"; cp "$work/copy.env" "$tree/docker/.env"; chmod 600 "$tree/docker/.env"; rm -f "$work/copy.env"
[ ! -f "$work/override.yaml" ] || mv "$work/override.yaml" "$tree/docker/compose.override.yaml"
(cd "$tree" && ./flux upgrade -y > "$logs/upgrade.log" 2>&1) || { tail -n 20 "$logs/upgrade.log"; fail "./flux upgrade failed"; }
grep -o "Upgraded $project from schema [0-9]* to [0-9]*" "$logs/upgrade.log" || fail "./flux upgrade did not report the schemas"

step "4. The read-only journeys as the company's owner"
sql() { docker exec -i "$project-db-1" sh -c 'psql -X -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1" </dev/null; }
email=$(sql "SELECT u.email FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id AND w.company JOIN auth_users u ON u.id = m.user_id WHERE m.role = 'owner' ORDER BY m.created_at LIMIT 1")
[ -n "$email" ] || fail "the copy has no company owner"
# The owner may sign in by single sign-on only (no password, so no reset link): the copy's owner gets a password of its own instead, hashed
# by the copy's own identity service and stored as their password sign-in. Neither the address nor the password is printed.
password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
hash=$(docker exec -w /app/apps/server -e FLUX_COPY_PASSWORD="$password" "$project-api-1" node --input-type=module -e \
  "const { hashPassword } = await import('better-auth/crypto'); process.stdout.write(await hashPassword(process.env.FLUX_COPY_PASSWORD));") ||
  fail "the copy's identity service did not hash a password"
[ -n "$hash" ] || fail "the copy's identity service did not hash a password"
docker exec -i "$project-db-1" sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v email="$1" -v hash="$2"' sh "$email" "$hash" > /dev/null <<'SQL' ||
DELETE FROM auth_accounts WHERE provider_id = 'credential' AND user_id = (SELECT id FROM auth_users WHERE lower(email) = lower(:'email'));
INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password, confirmed_at)
  SELECT gen_random_uuid()::text, id, id, 'credential', :'hash', now() FROM auth_users WHERE lower(email) = lower(:'email');
SQL
  fail "the copy did not take the owner's new password"
unset hash
FLUX_JOURNEYS_EMAIL="$email" FLUX_JOURNEYS_PASSWORD="$password" python3 "$root/scripts/release/smoke_journeys.py" real \
  --origin "http://127.0.0.1:$port" --report "$work/report.json"
