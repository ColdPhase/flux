#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

project="flux-undo-legacy-$(date +%s)-$$"
run_dir=$(mktemp -d)
evidence="${FLUX_LEGACY_EVIDENCE_DIR:-$run_dir/evidence}"
mkdir -p "$evidence"
case "$evidence" in /*) ;; *) echo 'FLUX_LEGACY_EVIDENCE_DIR must be absolute' >&2; exit 1 ;; esac
# Only synthetic fixture data; the container's node user writes the comparison snapshot here.
chmod 0777 "$evidence"
export FLUX_LEGACY_CHECK_ROOT="$PWD" FLUX_LEGACY_CHECK_IMAGE="flux-test-tools:$project"
export FLUX_LEGACY_CHECK_EVIDENCE="$evidence"
export FLUX_LEGACY_TEST_SUBNET="${FLUX_LEGACY_TEST_SUBNET:-10.199.150.0/24}"
export FLUX_GIT_COMMIT="$(git rev-parse HEAD)"
cat > "$run_dir/compose.yaml" <<'EOF'
services:
  db:
    image: postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
    environment:
      POSTGRES_USER: flux
      POSTGRES_PASSWORD: flux-undo-legacy-fixture
      POSTGRES_DB: flux
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "flux", "-d", "flux"]
      interval: 2s
      timeout: 2s
      retries: 20
  checks:
    image: ${FLUX_LEGACY_CHECK_IMAGE}
    build:
      context: ${FLUX_LEGACY_CHECK_ROOT}/app
      dockerfile: ${FLUX_LEGACY_CHECK_ROOT}/docker/Dockerfile
      target: test
      labels:
        com.flux.commit: ${FLUX_GIT_COMMIT}
    environment:
      DATABASE_URL: postgres://flux:flux-undo-legacy-fixture@db:5432/flux
      FLUX_DB_CONNECT_TIMEOUT_MS: "10000"
      FLUX_LEGACY_EVIDENCE_DIR: /evidence
    volumes:
      - ${FLUX_LEGACY_CHECK_EVIDENCE}:/evidence:Z
networks:
  default:
    ipam:
      config:
        - subnet: ${FLUX_LEGACY_TEST_SUBNET}
volumes:
  pgdata:
EOF
compose="docker compose -p $project -f $run_dir/compose.yaml"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then $compose logs --no-color db || true; fi
  $compose down -v || true
  docker image rm "$FLUX_LEGACY_CHECK_IMAGE" || true
  rm -rf "$run_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

$compose build checks
$compose up -d --wait db
$compose run --rm --no-deps checks node tooling/dist/migrate.js
$compose run --rm --no-deps checks node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/app/migration-ledger.test.ts tests/app/morning-summary-migration.test.ts \
  tests/app/task-creation-undo-compatibility.test.ts tests/app/task-creation-undo-migration.test.ts \
  tests/app/task-creation-undo-reversal-control.test.ts tests/app/task-creation-undo-core.test.ts

$compose run --rm --no-deps checks node_modules/.bin/tsx tests/app/task-creation-undo-legacy-restore.check.ts prepare
$compose exec -T db pg_dump -U flux --format=custom flux_undo_legacy_restore > "$evidence/original45c.dump"
$compose exec -T db dropdb -U flux flux_undo_legacy_restore
$compose exec -T db createdb -U flux flux_undo_legacy_restore
$compose exec -T db pg_restore -U flux --exit-on-error -d flux_undo_legacy_restore < "$evidence/original45c.dump"
$compose run --rm --no-deps checks node_modules/.bin/tsx tests/app/task-creation-undo-legacy-restore.check.ts verify
$compose run --rm --no-deps checks node_modules/.bin/tsx tests/app/task-creation-undo-legacy-restore.check.ts prepare current
$compose exec -T db pg_dump -U flux --format=custom flux_undo_current_restore > "$evidence/current.dump"
$compose exec -T db dropdb -U flux flux_undo_current_restore
$compose exec -T db createdb -U flux flux_undo_current_restore
$compose exec -T db pg_restore -U flux --exit-on-error -d flux_undo_current_restore < "$evidence/current.dump"
$compose run --rm --no-deps checks node_modules/.bin/tsx tests/app/task-creation-undo-legacy-restore.check.ts verify current
printf 'Undo semantic legacy refusal checks passed at %s. No conversion or future composition acceptance.\n' "$FLUX_GIT_COMMIT"
