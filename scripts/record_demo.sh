#!/bin/sh
# Records the README demo GIF (#121, AC-5) from the real application, in Docker only.
# Starts the Compose app on its own project and loopback port, seeds the `./flux demo` data
# through the public API (scripts/flux-demo.mjs), then walks the core journey in the pinned
# Playwright container (app/tests/ui/record_demo.py). Writes docs/assets/demo/flux-demo.gif,
# or the path given as the first argument.
set -eu

cd "$(dirname "$0")/.."
out="${1:-docs/assets/demo/flux-demo.gif}"
project="flux-demo-rec-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-rec-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-rec-$$-$(date +%s)"
export FLUX_PORT="${FLUX_DEMO_RECORD_PORT:-18595}"
export FLUX_MAILPIT_PORT="${FLUX_DEMO_RECORD_MAILPIT_PORT:-18596}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-rec-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
owner_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
partner_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
shots=$(mktemp -d)
export FLUX_UI_SCREENSHOT_DIR="$shots"
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml --profile ui"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color api | tail -60 || true
  fi
  $compose down -v >/dev/null 2>&1 || true
  remove_project_images
  rm -rf "$shots"
  exit $status
}
trap cleanup EXIT HUP INT TERM

$compose build migrate ui-test
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker
echo "Seeding the ./flux demo data through the public API..."
$compose exec -T -e FLUX_PUBLIC_ORIGIN="$FLUX_PUBLIC_ORIGIN" \
  -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" \
  api node --input-type=module - < scripts/flux-demo.mjs
# Pillow writes the GIF; it is installed by hash for this run only, not into the test image.
$compose run --rm -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" ui-test sh -c \
  'pip install --quiet --no-cache-dir --break-system-packages --only-binary=:all: --require-hashes -r tests/ui/demo-requirements.txt && python3 tests/ui/record_demo.py'
mkdir -p "$(dirname "$out")"
cp "$shots/flux-demo.gif" "$out"
echo "Wrote $out ($(wc -c < "$out") bytes)"
