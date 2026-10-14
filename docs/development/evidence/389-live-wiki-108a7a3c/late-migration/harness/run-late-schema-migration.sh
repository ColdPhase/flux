#!/usr/bin/env bash
set -euo pipefail
repo=/home/hubert/Develop/flux-389
evidence=/home/hubert/Develop/flux-evidence-archive/flux389-108a7a3c-late-migration
expected=108a7a3c5935cb0265e55658176e97b759a1d937
mkdir -p "$evidence"
if [[ -n "$(find "$evidence" -mindepth 1 -print -quit)" ]]; then echo "evidence dir not empty: $evidence" >&2; exit 2; fi
cd "$repo"
actual=$(git rev-parse HEAD)
[[ "$actual" == "$expected" ]] || { echo "source mismatch expected=$expected actual=$actual" >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'source worktree is not clean' >&2; exit 2; }
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux389-late94-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-389-late94-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT=18189 FLUX_MAILPIT_PORT=18190
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-389-late94-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL='smtp://mailpit:1025' FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_AUTH_RATE_LIMIT=false FLUX_STREAM_HEARTBEAT_MS=1000
export FLUX_GIT_COMMIT="$actual"
keydir=$(mktemp -d)
head -c 32 /dev/urandom > "$keydir/background_key"
chmod 0444 "$keydir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$keydir/background_key"
project="flux389-late94-$(date +%s)-$$"
compose=(docker compose -p "$project" -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test)
. scripts/test_images.sh
cleanup() {
  status=$?
  if (( status != 0 )); then "${compose[@]}" logs --no-color db migrate test > "$evidence/compose-failure.log" 2>&1 || true; fi
  "${compose[@]}" down -v > "$evidence/compose-down.log" 2>&1 || true
  remove_project_images > "$evidence/image-cleanup.log" 2>&1 || true
  chmod 0600 "$keydir/background_key" || true
  rm -rf "$keydir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$evidence/run-metadata.txt" <<META
source=$actual
branch=$(git branch --show-current)
base=$(git rev-parse "$actual^1")
schema_version=$(sed -n 's/.*FLUX_SCHEMA_VERSION = \([0-9]*\);/\1/p' app/packages/db/src/index.ts)
compose_project=$project
selection=tests/app/live-editing-migration.test.ts --test-name-pattern '0046, 0047 and 0084 arrive late on the canonical latest schema'
META
sha256sum "$0" scripts/check_application.sh > "$evidence/harness-sha256.txt"
printf 'Building migrate and test images for source %s\n' "$actual"
"${compose[@]}" build migrate test > "$evidence/build.log" 2>&1
"${compose[@]}" up -d db migrate > "$evidence/services.log" 2>&1
"${compose[@]}" --profile setup run --rm files-init >> "$evidence/services.log" 2>&1
"${compose[@]}" run --rm --no-deps test node_modules/.bin/tsx --test --test-concurrency=1 \
  --test-name-pattern '0046, 0047 and 0084 arrive late on the canonical latest schema' \
  tests/app/live-editing-migration.test.ts > "$evidence/api-tests.log" 2>&1
cat "$evidence/api-tests.log"
