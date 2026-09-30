#!/bin/sh
# Exercises the operator Compose example (docker/compose.yaml, issue #76) without a published
# image: builds the checked-out source image, puts it in place of the release marker in a
# temporary copy, generates a .env from docker/.env.example, and starts the stack the way an
# operator does (`--env-file .env -f compose.yaml up -d --wait`) on its own project and port.
# Removes the project, its volumes and the per-run image afterwards.
set -eu

cd "$(dirname "$0")/.."
project="flux-operator-$(date +%s)-$$"
port="${FLUX_OPERATOR_TEST_PORT:-18951}"
origin="http://127.0.0.1:${port}"
marker='ghcr.io/coldphase/flux@sha256:RELEASE_DIGEST'
image="flux-foundation:${project}"
work=$(mktemp -d)
env_file="$work/.env"
compose_file="$work/compose.yaml"
compose="docker compose --env-file $env_file -p $project -f $compose_file"
. scripts/test_images.sh

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$env_file" ]; then
    $compose logs --no-color db migrate api worker || true
  fi
  if [ -f "$env_file" ]; then
    $compose down -v --remove-orphans || true
    remove_project_images
  fi
  docker image rm -f "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

fail() { echo "check_operator_compose: $*" >&2; exit 1; }
random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
set_env() {
  awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; found = 1; next } { print }
    END { if (!found) exit 3 }' "$env_file" > "$env_file.tmp" || fail "$1 is missing from docker/.env.example"
  mv "$env_file.tmp" "$env_file"
}

# The same Dockerfile and final (runtime) stage that infra/compose.yaml builds.
# One retry for a transient registry or package download error.
docker build -q -f infra/Dockerfile -t "$image" . >/dev/null ||
  docker build -q -f infra/Dockerfile -t "$image" . >/dev/null

count=$(grep -c "image: $marker\$" docker/compose.yaml) || true
[ "$count" = 3 ] || fail "expected the release marker on 3 services, found $count"
sed "s#$marker#$image#" docker/compose.yaml > "$compose_file"
! grep -v '^ *#' "$compose_file" | grep -q RELEASE_DIGEST || fail "marker left in the temporary Compose file"

umask 077
cp docker/.env.example "$env_file"
# The example must fail closed: its empty required secrets stop Compose before anything runs.
if $compose config --quiet 2>/dev/null; then fail "config accepted the unfilled example"; fi
set_env FLUX_PROJECT "$project"
set_env FLUX_PORT "$port"
set_env FLUX_PUBLIC_ORIGIN "$origin"
set_env POSTGRES_PASSWORD "$(random_hex)"
set_env FLUX_AUTH_SECRET "$(random_hex)"
set_env FLUX_FIXTURE_TOKEN "$(random_hex)"
$compose config --quiet
[ "$($compose config --images | grep -c "^$image\$")" = 3 ] || fail "api, worker and migrate must use one image"

# Web Push keys with the documented operator command, against the image in the Compose file.
keys=$($compose run --rm --no-deps -T migrate apps/worker/node_modules/.bin/web-push generate-vapid-keys --json)
set_env FLUX_VAPID_PUBLIC_KEY "$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
set_env FLUX_VAPID_PRIVATE_KEY "$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')"
set_env FLUX_VAPID_SUBJECT "mailto:operator-check@example.test"
grep -q '^FLUX_VAPID_PUBLIC_KEY=.' "$env_file" && grep -q '^FLUX_VAPID_PRIVATE_KEY=.' "$env_file" ||
  fail "VAPID key generation failed: $keys"

$compose up -d --wait --wait-timeout 300

# Migration: one-shot, exited 0, ledger equals the image's schema, reported by health.
[ "$($compose ps -a --format '{{.ExitCode}}' migrate)" = 0 ] || fail "migrate did not exit 0"
expected=$(sed -n 's/^export const FLUX_SCHEMA_VERSION = \([0-9]*\);$/\1/p' packages/db/src/index.ts)
ledger=$($compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "SELECT count(*), max(version) FROM flux_schema_version"')
[ "$ledger" = "$expected|$expected" ] || fail "migration ledger $ledger, expected $expected|$expected"
health=$(curl -fsS "$origin/api/v1/health")
[ "$health" = "{\"status\":\"ok\",\"schemaVersion\":$expected}" ] || fail "health: $health"
$compose logs --no-color migrate | grep -q "Flux schema $expected and pg-boss ready" || fail "no migration completion log"

# Non-root runtime and the database kept off the host.
[ "$($compose exec -T api id -u)" != 0 ] || fail "api runs as root"
[ "$($compose exec -T worker id -u)" != 0 ] || fail "worker runs as root"
[ -z "$(docker port "$($compose ps -q db)")" ] || fail "database port is published"
[ "$(docker port "$($compose ps -q api)")" = "8080/tcp -> 127.0.0.1:$port" ] || fail "API must be published on loopback only"
[ "$($compose ps --status running --format '{{.Service}}' | sort | tr '\n' ' ')" = "api db worker " ] ||
  fail "expected api, db and worker running"

# A person signs up, creates a workspace and reads it back; the web app is served.
jar="$work/cookies"
body="$work/body"
code=$(curl -sS -o "$body" -w '%{http_code}' -c "$jar" -H "Origin: $origin" -H 'Content-Type: application/json' \
  -d "{\"email\":\"operator-$$@example.test\",\"password\":\"$(random_hex)\",\"name\":\"Operator check\"}" \
  "$origin/api/auth/sign-up/email")
[ "$code" = 200 ] || { cat "$body" >&2; fail "sign-up returned $code"; }
code=$(curl -sS -o "$body" -w '%{http_code}' -b "$jar" -H "Origin: $origin" -H 'Content-Type: application/json' \
  -d '{"name":"Operator probe"}' "$origin/api/v1/workspaces")
[ "$code" = 201 ] || { cat "$body" >&2; fail "workspace creation returned $code"; }
workspace=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$body" | head -n 1)
[ -n "$workspace" ] || fail "no workspace id in $(cat "$body")"
curl -fsS -b "$jar" "$origin/api/v1/workspaces/$workspace" | grep -q '"name":"Operator probe"' || fail "workspace not readable"
curl -fsS -H 'Accept: text/html' "$origin/" | grep -qi '<!doctype html' || fail "web app not served"
curl -fsS "$origin/api/v1/push/public-key" -b "$jar" | grep -q "$(sed -n 's/^FLUX_VAPID_PUBLIC_KEY=//p' "$env_file")" ||
  fail "API does not report the configured VAPID key"

# The worker processes a job; test-only failure injection is off in the operator file.
token=$(sed -n 's/^FLUX_FIXTURE_TOKEN=//p' "$env_file")
code=$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -H 'X-Flux-Test-Failure: after-insert' -d '{"title":"operator sample"}' "$origin/api/v1/integration/sample")
[ "$code" = 201 ] || { cat "$body" >&2; fail "fixture sample returned $code (failure injection must be off)"; }
sample_sql="SELECT count(*) FROM samples s JOIN sample_results r ON r.sample_id=s.id WHERE s.title='operator sample'"
attempt=0
until [ "$($compose exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tA -c \"$sample_sql\"")" = 1 ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || fail "worker did not process the sample"
  sleep 1
done

# Restart: data persists in the named volumes and the migration is idempotent.
$compose stop api worker
$compose up -d --wait --wait-timeout 300
[ "$($compose ps -a --format '{{.ExitCode}}' migrate)" = 0 ] || fail "migrate failed on restart"
curl -fsS -b "$jar" "$origin/api/v1/workspaces/$workspace" | grep -q '"name":"Operator probe"' ||
  fail "workspace or session lost across restart"

echo "Operator Compose check passed: pull-only file with local image, schema $expected, sign-up, workspace, worker job, restart."
