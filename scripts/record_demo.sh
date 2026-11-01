#!/bin/sh
# Records the README demo GIF (#121, AC-5) from the real application, in Docker only.
# Starts the Compose app on its own project and loopback port, seeds the `./flux demo` data
# through the public API (scripts/flux-demo.mjs), then walks the core journey in the pinned
# Playwright container (app/tests/ui/record_demo.py). Writes docs/assets/demo/flux-demo.gif,
# or the path given as the first argument. A second argument names a directory that also receives
# the README stills, light and dark (conversation-desktop.webp, home-phone.webp and their -dark
# twins), e.g. docs/assets/readme. A third argument names a directory that also receives the
# product screens of the documentation and the README highlights (app/tests/ui/record_docs_media.py,
# #780), e.g. docs/assets/screens.
set -eu

cd "$(dirname "$0")/.."
out="${1:-docs/assets/demo/flux-demo.gif}"
stills="${2:-}"
screens="${3:-}"
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
# The recorder signs in many times from one address (every window it opens); the login rate limit is covered by the API suite.
export FLUX_AUTH_RATE_LIMIT=false
# The keyring of encrypted spaces (F-030), so the encrypted space of the README highlights can be made, and
# throwaway VAPID keys below, so the notification settings show the Push column of a real install.
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_VAPID_PUBLIC_KEY="" FLUX_VAPID_PRIVATE_KEY="" FLUX_VAPID_SUBJECT=""
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
# The same pinned command `./flux up` uses; the keys exist only for this run.
keys=$($compose run --rm --no-deps -T migrate apps/worker/node_modules/.bin/web-push generate-vapid-keys --json 2>/dev/null) || keys=""
vapid_public=$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')
vapid_private=$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')
if [ -n "$vapid_public" ] && [ -n "$vapid_private" ]; then
  export FLUX_VAPID_PUBLIC_KEY="$vapid_public" FLUX_VAPID_PRIVATE_KEY="$vapid_private" FLUX_VAPID_SUBJECT="mailto:admin@localhost.localdomain"
else
  echo "Could not generate VAPID keys; the notification settings will say push is not set up." >&2
fi
$compose up -d --wait api worker
echo "Seeding the ./flux demo data through the public API..."
$compose exec -T -e FLUX_PUBLIC_ORIGIN="$FLUX_PUBLIC_ORIGIN" \
  -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" \
  api node --input-type=module - < scripts/flux-demo.mjs
# Pillow writes the GIF and the images; it is installed by hash for this run only, not into the test image.
# The documentation screens come after the journey, so Ada's workspace already has its task and decision.
recorders="python3 tests/ui/record_demo.py"
if [ -n "$screens" ]; then recorders="$recorders && python3 tests/ui/record_docs_media.py"; fi
$compose run --rm -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" ui-test sh -c \
  "pip install --quiet --no-cache-dir --break-system-packages --only-binary=:all: --require-hashes -r tests/ui/demo-requirements.txt && $recorders"
mkdir -p "$(dirname "$out")"
cp "$shots/flux-demo.gif" "$out"
echo "Wrote $out ($(wc -c < "$out") bytes)"
if [ -n "$stills" ]; then
  mkdir -p "$stills"
  cp "$shots"/conversation-desktop*.webp "$shots"/home-phone*.webp "$stills/"
  echo "Wrote the README stills to $stills"
fi
if [ -n "$screens" ]; then
  mkdir -p "$screens"
  cp "$shots"/docs/*.webp "$screens/"
  echo "Wrote the documentation screens to $screens"
fi
