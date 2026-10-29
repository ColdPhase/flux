#!/bin/sh
# F-030 encrypted workspaces (#655), S1, S2a and S2c acceptance in Docker (docs/product/encrypted-workspaces.md#tests-and-acceptance-criteria):
#   AC-1 crypto, AC-2 lifecycle / AI forced off / keyring and swap, AC-5 (S2a-1 part) the registry against the live catalog and
#   the backstops, the S2a-1 sealed repositories with their in-database canary scan, AC-4 two APIs with PostgreSQL logging every
#   statement and its parameters (docker/compose.encryption.test.yaml), the whole PostgreSQL, API, worker and keyring
#   logs scanned for every secret of the run, AC-3 restarts, and AC-13 key rotation (S2c) with a worker crash and a keyring
#   restart mid-rotation. Its own Compose project; ports FLUX_TEST_PORT and
#   FLUX_TEST_MAILPIT_PORT as for check_application.sh.
set -eu

cd "$(dirname "$0")/.."
project="flux-encryption-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18089}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18025}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml -f docker/compose.encryption.test.yaml --profile test"
scan_dir=$(mktemp -d)

# Peak memory of the run's long-lived services (F-030 S1 sets the default limits to at least twice the observed peaks).
report_memory() {
  for service in api api2 worker keyring; do
    container=$($compose ps -q "$service" 2>/dev/null) || continue
    [ -n "$container" ] || continue
    peak=$(docker exec "$container" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unknown)
    swap=$(docker exec "$container" cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo unknown)
    echo "memory $service: peak ${peak} bytes since its last start, swap.max ${swap}" >&2
  done
}

cleanup() {
  status=$?
  report_memory || true
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail 200 migrate api api2 worker keyring test || true
  fi
  $compose down -v || true
  remove_project_images
  rm -rf "$scan_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

$compose build
$compose up -d db migrate
$compose --profile setup run --rm files-init

files="${FLUX_ENCRYPTION_FILES:-tests/app/encryption-crypto.test.ts tests/app/encryption-keyring.test.ts tests/app/encrypted-workspaces.test.ts tests/app/encryption-registry.test.ts tests/app/encryption-sealed-content.test.ts tests/app/encryption-search-live.test.ts tests/app/sealed-search-heap.test.ts tests/app/encryption-rotation.test.ts tests/app/live/encryption-two-api.test.ts}"
# shellcheck disable=SC2086
$compose run --rm test node_modules/.bin/tsx --test --test-concurrency=1 $files

# AC-7 (S2b part): none of the canaries of the encrypted workspace (search content, live Wiki and live map) is in any file of the
# PostgreSQL data directory or its WAL, after a checkpoint and a WAL switch; the plain workspace's canaries are (positive control).
$compose run --rm --no-deps -T test cat /state/encryption-disk-canaries.txt > "$scan_dir/disk-canaries"
$compose run --rm --no-deps -T test cat /state/encryption-disk-control.txt > "$scan_dir/disk-control"
db_container=$($compose ps -q db)
docker exec "$db_container" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c CHECKPOINT -c 'SELECT pg_switch_wal()' > /dev/null
docker cp "$scan_dir/disk-canaries" "$db_container:/tmp/disk-canaries"
docker cp "$scan_dir/disk-control" "$db_container:/tmp/disk-control"
pgdata=$(docker exec "$db_container" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SHOW data_directory')
canary_count=$(grep -c . "$scan_dir/disk-canaries")
[ "$canary_count" -ge 20 ] || { echo "too few disk canaries ($canary_count)" >&2; exit 1; }
docker exec -u root "$db_container" sh -c "grep -rlaF -f /tmp/disk-control '$pgdata' | head -1" | grep -q . || { echo 'positive control: no plain canary found in the data directory or WAL' >&2; exit 1; }
if [ -n "$(docker exec -u root "$db_container" sh -c "grep -rlaF -f /tmp/disk-canaries '$pgdata'")" ]; then
  echo "CANARY of an encrypted workspace FOUND on the PostgreSQL disk (data directory or WAL)" >&2
  exit 1
fi
echo "AC-7 disk scan: $canary_count canary encodings, 0 files of the data directory or WAL hold one; the positive control is found"

# AC-4: no password, recovery code, KEK, holder private key, DEK or subkey in any log, in any encoding.
$compose run --rm --no-deps -T test cat /state/encryption-secrets.txt > "$scan_dir/secrets"
# S2c: the rotation tests' passwords, codes and DEKs (old and new versions) too.
$compose run --rm --no-deps -T test cat /state/rotation-secrets.txt >> "$scan_dir/secrets"
count=$(grep -c . "$scan_dir/secrets")
[ "$count" -ge 40 ] || { echo "too few secrets to scan for ($count)" >&2; exit 1; }
$compose logs --no-color db > "$scan_dir/postgres.log"
grep -q 'LOG:  statement: ' "$scan_dir/postgres.log" || { echo 'PostgreSQL did not log statements (log_statement=all)' >&2; exit 1; }
grep -q 'workspace_unlocks' "$scan_dir/postgres.log" || { echo 'the PostgreSQL log does not cover the unlock writes' >&2; exit 1; }
$compose run --rm --no-deps -T test cat /state/encryption-control.txt > "$scan_dir/control"
grep -F -f "$scan_dir/control" "$scan_dir/postgres.log" > /dev/null || { echo 'positive control: a bind parameter the test sent is not in the PostgreSQL log' >&2; exit 1; }
$compose logs --no-color api api2 worker keyring > "$scan_dir/services.log"
hits=0
for log in postgres services; do
  if grep -F -f "$scan_dir/secrets" "$scan_dir/$log.log" > "$scan_dir/$log.hits"; then
    echo "SECRET FOUND in the $log log ($(wc -l < "$scan_dir/$log.hits") lines)" >&2
    hits=1
  fi
done
[ "$hits" -eq 0 ] || exit 1
echo "AC-4 log scan: $count secret encodings, $(wc -l < "$scan_dir/postgres.log") PostgreSQL log lines, $(wc -l < "$scan_dir/services.log") service log lines, 0 hits"

report_memory

# AC-3: restarts and the lock.
$compose run --rm test node_modules/.bin/tsx tests/app/encryption-restart.check.ts prepare
$compose restart
$compose up -d --wait api api2 worker keyring
$compose run --rm test node_modules/.bin/tsx tests/app/encryption-restart.check.ts stack-locked
$compose restart api
$compose up -d --wait api
$compose run --rm test node_modules/.bin/tsx tests/app/encryption-restart.check.ts api-unlocked
$compose run --rm test node_modules/.bin/tsx tests/app/encryption-restart.check.ts mark
$compose restart keyring
$compose run --rm test node_modules/.bin/tsx tests/app/encryption-restart.check.ts keyring-locked

# AC-13 (S2c): a worker crash and a keyring restart mid-rotation.
rotation="node_modules/.bin/tsx tests/app/encryption-rotation.check.ts"
FLUX_TEST_ROTATION_HOLD_AFTER_PAGES=3 $compose up -d --wait worker
$compose run --rm --no-deps test $rotation crash-prepare
docker kill "$($compose ps -q worker)"
FLUX_TEST_ROTATION_HOLD_AFTER_PAGES= $compose up -d worker
$compose run --rm --no-deps test $rotation crash-resumed
FLUX_TEST_ROTATION_HOLD_AFTER_PAGES=3 $compose up -d --wait worker
$compose run --rm --no-deps test $rotation keyring-prepare
$compose restart keyring
$compose run --rm --no-deps test $rotation keyring-locked
FLUX_TEST_ROTATION_HOLD_AFTER_PAGES= $compose up -d worker
$compose run --rm --no-deps test $rotation keyring-resumed

echo 'F-030 S1, S2a and S2c encryption checks passed'
