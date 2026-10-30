#!/bin/sh
# Records the screen shots of the launch video (#307, L-3) from the real application, in Docker only.
# Starts the Compose app on its own project and loopback ports, seeds the `./flux demo` data through the
# public API (scripts/flux-demo.mjs), then records shot 1 (opening card), shots 2 to 4 (the core journey in one
# take) and shot 8 (closing card) of docs/product/launch-video.md with Playwright's video recorder
# (app/tests/ui/record_video.py). Shots 5 to 7 need a person's own model account and are not recorded here.
#
#   ./scripts/record_video.sh [output-dir]       # both languages, default $TMPDIR/flux-launch-video
#   FLUX_VIDEO_LANG=en ./scripts/record_video.sh # one language (en or pl)
#   FLUX_VIDEO_VERSION=v0.1.0 ./scripts/record_video.sh   # the version on the closing card
#   FLUX_VIDEO_CAPTIONS=off ./scripts/record_video.sh     # no caption bar, for a cut with a subtitle track
#
# Writes <output-dir>/<lang>/shot-1-open.webm, shots-2-4-journey.webm, shot-8-close.webm and timings.json.
# The demo data changes during the journey, so each language starts its own fresh stack.
set -eu

cd "$(dirname "$0")/.."
out="${1:-${TMPDIR:-/tmp}/flux-launch-video}"
if [ -z "${FLUX_VIDEO_LANG:-}" ]; then
  for lang in en pl; do
    FLUX_VIDEO_LANG="$lang" "$0" "$out"
  done
  exit 0
fi
lang="$FLUX_VIDEO_LANG"
version="${FLUX_VIDEO_VERSION:-pre-release}"
project="flux-video-rec-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-vid-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-vid-$$-$(date +%s)"
export FLUX_PORT="${FLUX_VIDEO_RECORD_PORT:-18597}"
export FLUX_MAILPIT_PORT="${FLUX_VIDEO_RECORD_MAILPIT_PORT:-18598}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-vid-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
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
# Pillow is needed only because record_video.py reuses the journey helpers of record_demo.py; it is installed
# by hash for this run only, not into the test image. The Kreska logo is mounted from the repository.
$compose run --rm -v "$PWD/docs/assets/brand:/brand:ro,z" \
  -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" \
  -e FLUX_VIDEO_LANG="$lang" -e FLUX_VIDEO_VERSION="$version" -e FLUX_VIDEO_CAPTIONS="${FLUX_VIDEO_CAPTIONS:-on}" ui-test sh -c \
  'pip install --quiet --no-cache-dir --break-system-packages --only-binary=:all: --require-hashes -r tests/ui/demo-requirements.txt && python3 tests/ui/record_video.py'
mkdir -p "$out/$lang"
cp "$shots/video-$lang"/* "$out/$lang/"
echo "Wrote the $lang clips to $out/$lang:"
ls -l "$out/$lang"
