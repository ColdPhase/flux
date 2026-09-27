#!/bin/sh
# End-to-end check of the ./flux launcher (issue #72) in Docker, on an isolated copy of this
# checkout with its own Compose project names, ports, volumes and image tags:
#   up (fresh .env, never overwritten), demo (logins work, idempotent, refuses production),
#   dev (web and API hot reload through the Vite proxy), down/reset/clean scoped to this run.
# It never touches the checkout's own .env or any other Compose project.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
run="fluxcli$$"
export FLUX_PROJECT="$run"
export FLUX_PORT="${FLUX_CLI_TEST_PORT:-19561}"
export FLUX_DEV_PORT="${FLUX_CLI_TEST_DEV_PORT:-19562}"
export FLUX_MAILPIT_PORT="${FLUX_CLI_TEST_MAILPIT_PORT:-19563}"
base="http://127.0.0.1:$FLUX_PORT"
dev="http://127.0.0.1:$FLUX_DEV_PORT"
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-cli-check.XXXXXX")
copy="$work/flux"
sentinel="${run}-sentinel_keep"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -x "$copy/flux" ] && [ -f "$copy/.env" ]; then
    (cd "$copy" && docker compose --project-directory infra --env-file .env -p "$run" -f infra/compose.yaml logs --no-color --tail 80 2>/dev/null) || true
    (cd "$copy" && docker compose --project-directory infra --env-file .env -p "$run-dev" -f infra/compose.yaml -f infra/compose.dev.yaml --profile dev logs --no-color --tail 80 2>/dev/null) || true
  fi
  if [ -x "$copy/flux" ] && [ -f "$copy/.env" ]; then "$copy/flux" clean -y >/dev/null 2>&1 || true; fi
  docker volume rm "$sentinel" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

# A volume labelled as another Compose project: reset and clean must leave it alone.
docker volume create --label com.docker.compose.project="${run}other" "$sentinel" >/dev/null

step "Copy the working tree (tracked and new files, no .env) to $copy"
mkdir -p "$copy"
(cd "$here" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf - 2>/dev/null) | (cd "$copy" && tar -xf -)
[ ! -e "$copy/.env" ] || fail ".env was copied"
cd "$work"   # run the launcher from outside the checkout: paths resolve relative to ./flux

step "./flux up on a fresh copy creates .env and starts a healthy stack"
start=$(date +%s)
"$copy/flux" up
echo "up took $(( $(date +%s) - start ))s"
[ -f "$copy/.env" ] || fail ".env not created"
mode=$(ls -l "$copy/.env" | cut -c1-10)
[ "$mode" = "-rw-------" ] || fail ".env mode is $mode, expected -rw-------"
if grep -q 'replace-with' "$copy/.env"; then fail "placeholder secrets left in .env"; fi
for key in POSTGRES_PASSWORD FLUX_FIXTURE_TOKEN FLUX_AUTH_SECRET FLUX_VAPID_PUBLIC_KEY FLUX_VAPID_PRIVATE_KEY FLUX_DEMO_OWNER_PASSWORD; do
  value=$(sed -n "s/^$key=//p" "$copy/.env")
  [ "${#value}" -ge 20 ] || fail "$key is missing or short in .env"
done
grep -qx "FLUX_PUBLIC_ORIGIN=$base" "$copy/.env" || fail "FLUX_PUBLIC_ORIGIN is not $base"
grep -q '^FLUX_VAPID_SUBJECT=mailto:' "$copy/.env" || fail "FLUX_VAPID_SUBJECT not set"
curl -fsS "$base/api/v1/health" | grep -q '"status":"ok"' || fail "health not ok"

step "A second ./flux up keeps .env byte for byte"
before=$(cksum < "$copy/.env")
"$copy/flux" up >/dev/null
[ "$(cksum < "$copy/.env")" = "$before" ] || fail ".env changed on the second up"
curl -fsS "$base/api/v1/health" >/dev/null || fail "health after second up"

step "./flux demo seeds through the API and prints working logins"
out=$(FLUX_DEMO_JSON=1 "$copy/flux" demo)
printf '%s\n' "$out" | grep -v '^FLUX_DEMO_RESULT'
owner_pw=$(printf '%s\n' "$out" | sed -n 's/.*ada@demo\.flux\.test *\(demo-[0-9a-f]*\).*/\1/p')
partner_pw=$(printf '%s\n' "$out" | sed -n 's/.*jonas@demo\.flux\.test *\(demo-[0-9a-f]*\).*/\1/p')
[ -n "$owner_pw" ] && [ -n "$partner_pw" ] || fail "demo did not print both logins"
printf '%s\n' "$out" | grep -q "Flux demo is ready:  $base" || fail "demo did not print the URL"
printf '%s\n' "$out" | grep -q 'seeded  conversation with 4 messages' || fail "conversation not seeded"
printf '%s\n' "$out" | grep -Eq 'seeded  sketch|skipped sketch' || fail "sketch neither seeded nor skipped"

jar="$work/jar"
sign_in() { # email password -> cookie jar $jar
  rm -f "$jar"
  code=$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" -H "Origin: $base" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" "$base/api/auth/sign-in/email")
  [ "$code" = 200 ] || fail "sign-in for $1 answered $code"
}
api() { curl -fsS -b "$jar" -H "Origin: $base" "$base$1"; }
sign_in ada@demo.flux.test "$owner_pw"
api /api/v1/push/public-key | grep -q "\"publicKey\":\"$(sed -n 's/^FLUX_VAPID_PUBLIC_KEY=//p' "$copy/.env")\"" \
  || fail "API does not serve the generated VAPID public key"
workspaces=$(api /api/v1/workspaces)
printf '%s' "$workspaces" | grep -q 'Riverside Makers (demo)' || fail "owner cannot see the demo workspace"
ws=$(printf '%s' "$workspaces" | sed -n 's/.*"id":"\([^"]*\)","name":"Riverside Makers (demo)".*/\1/p')
[ -n "$ws" ] || fail "could not read the workspace id"
drafts=$(api "/api/v1/workspaces/$ws/drafts")
printf '%s' "$drafts" | grep -q 'Before Thursday (private)' || fail "owner does not see the private note"
project=$(api "/api/v1/workspaces/$ws/projects" | sed -n 's/.*"id":"\([^"]*\)".*"name":"Community garden sensors".*/\1/p')
[ -n "$project" ] || fail "demo project missing"
conversation=$(printf '%s\n' "$out" | sed -n 's/.*"conversationId":"\([^"]*\)".*/\1/p')
thread=$(api "/api/v1/conversations/$conversation")
[ "$(printf '%s' "$thread" | grep -o '"sequence":' | wc -l | tr -d ' ')" = 4 ] || fail "conversation does not have 4 messages"
printf '%s' "$thread" | grep -q '"source":{"materialId"' || fail "no message cites the material"
sign_in jonas@demo.flux.test "$partner_pw"
if api "/api/v1/workspaces/$ws/drafts" | grep -q 'Before Thursday'; then fail "partner can see the owner's private note"; fi
api "/api/v1/conversations/$conversation" | grep -q 'Moisture first' || fail "partner cannot read the conversation"

step "A second ./flux demo seeds nothing new"
"$copy/flux" demo | grep -q 'already exists; nothing new was seeded' || fail "second demo was not idempotent"
sign_in ada@demo.flux.test "$owner_pw"
[ "$(api /api/v1/workspaces | grep -o 'Riverside Makers (demo)' | wc -l | tr -d ' ')" = 1 ] || fail "duplicate demo workspace"

step "./flux demo refuses a production-looking origin"
cp "$copy/.env" "$work/env.saved"
sed 's#^FLUX_PUBLIC_ORIGIN=.*#FLUX_PUBLIC_ORIGIN=https://flux.example.org#' "$work/env.saved" > "$copy/.env"
if "$copy/flux" demo > "$work/refuse.out" 2>&1; then fail "demo ran against https://flux.example.org"; fi
grep -q 'refuses to seed https://flux.example.org' "$work/refuse.out" || fail "missing refusal message"
cat "$work/env.saved" > "$copy/.env"

step "./flux dev serves Vite with hot reload for web and API"
"$copy/flux" dev
curl -fsS "$dev/" | grep -q '/@vite/client' || fail "dev server is not Vite"
curl -fsS "$dev/api/v1/health" | grep -q '"status":"ok"' || fail "Vite does not proxy /api to the API"
marker="hot-reload-$run"
printf "\nexport const fluxDevMarker = '%s';\n" "$marker" >> "$copy/apps/web/src/app/theme.ts"
sed "s/return { status: 'ok', schemaVersion: FLUX_SCHEMA_VERSION };/return { status: 'ok', schemaVersion: FLUX_SCHEMA_VERSION, dev: '$marker' };/" \
  "$copy/apps/server/src/index.ts" > "$work/index.ts" && cat "$work/index.ts" > "$copy/apps/server/src/index.ts"
grep -q "$marker" "$copy/apps/server/src/index.ts" || fail "could not edit the server health handler"
edit=$(date +%s); web_s='' api_s=''
while [ $(( $(date +%s) - edit )) -lt 60 ]; do
  [ -n "$web_s" ] || { curl -fsS "$dev/src/app/theme.ts" 2>/dev/null | grep -q "$marker" && web_s=$(( $(date +%s) - edit )); } || true
  [ -n "$api_s" ] || { curl -fsS "$dev/api/v1/health" 2>/dev/null | grep -q "$marker" && api_s=$(( $(date +%s) - edit )); } || true
  [ -n "$web_s" ] && [ -n "$api_s" ] && break
  sleep 0.5
done
[ -n "$web_s" ] || fail "web change not served by Vite within 60s"
[ -n "$api_s" ] || fail "API change not live within 60s"
echo "hot reload without rebuild: web ${web_s}s, api ${api_s}s after the edit"
dev_out=$("$copy/flux" demo --dev)
printf '%s\n' "$dev_out" | grep -q "Flux demo is ready:  $dev" || fail "demo --dev did not seed the dev stack"

step "./flux down stops both stacks and keeps their data"
"$copy/flux" down
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$run")" ] || fail "containers of $run still running"
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$run-dev")" ] || fail "containers of $run-dev still running"
docker volume inspect "${run}_pgdata" >/dev/null 2>&1 || fail "down removed the database volume"

step "./flux reset asks first, then removes only this checkout's volumes"
if echo n | "$copy/flux" reset; then fail "reset without confirmation returned success"; fi
docker volume inspect "${run}_pgdata" >/dev/null 2>&1 || fail "cancelled reset removed data"
"$copy/flux" reset -y
for volume in "${run}_pgdata" "${run}_files" "${run}-dev_pgdata" "${run}-dev_files"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then fail "reset left $volume"; fi
done
docker volume inspect "$sentinel" >/dev/null 2>&1 || fail "reset removed another project's volume"
[ -f "$copy/.env" ] || fail "reset removed .env"

step "./flux up after reset starts empty with the same .env; ./flux clean removes own images"
"$copy/flux" up >/dev/null
sign_in_code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Origin: $base" -H 'Content-Type: application/json' \
  -d "{\"email\":\"ada@demo.flux.test\",\"password\":\"$owner_pw\"}" "$base/api/auth/sign-in/email")
[ "$sign_in_code" != 200 ] || fail "demo account survived reset"
docker image inspect "flux-foundation:$run" >/dev/null 2>&1 || fail "missing flux-foundation:$run before clean"
docker image inspect "flux-dev:$run-dev" >/dev/null 2>&1 || fail "missing flux-dev:$run-dev before clean"
clean_out=$("$copy/flux" clean -y)
printf '%s\n' "$clean_out" | grep -E 'Removed [0-9]+ image|builder prune'
for image in "flux-foundation:$run" "flux-dev:$run-dev"; do
  if docker image inspect "$image" >/dev/null 2>&1; then fail "clean left $image"; fi
done
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$run")" ] || fail "clean left containers"
docker volume inspect "$sentinel" >/dev/null 2>&1 || fail "clean removed another project's volume"
printf '%s\n' "$clean_out" | grep -q 'docker builder prune' || fail "clean did not print the build cache advice"

step "PASS: ./flux up, demo, dev, down, reset and clean"
