#!/bin/sh
# Visual consistency audit (#763): measures every control on every screen of the real application, in Docker only.
# Starts the Compose app on its own project and loopback port, seeds the `./flux demo` data through the public API
# (scripts/flux-demo.mjs), then runs app/tests/ui/visual_consistency_audit.py in the pinned Playwright container. That
# adds more multi-user data, visits every screen and state at 360, 390, 430, 820, 1440 and 1920 px in light and dark,
# Chromium and WebKit, and writes findings.md, findings.json, screenshots (annotated where something was flagged) and
# contact sheets to the directory given as the first argument (default: visual-audit/ in this checkout, ignored by git).
# FLUX_AUDIT_BROWSERS, FLUX_AUDIT_THEMES, FLUX_AUDIT_VIEWPORTS and FLUX_AUDIT_SCREENS narrow a run (comma-separated),
# e.g. FLUX_AUDIT_SCREENS=wiki-read,inbox FLUX_AUDIT_VIEWPORTS=360,1440 ./scripts/visual_audit.sh. It measures and
# reports; findings never fail it. Not part of check_ui.sh or check_application.sh.
set -eu

cd "$(dirname "$0")/.."
out="${1:-visual-audit}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
mkdir -p "$out"
project="flux-visual-audit-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-audit-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-audit-$$-$(date +%s)"
export FLUX_PORT="${FLUX_VISUAL_AUDIT_PORT:-18597}"
export FLUX_MAILPIT_PORT="${FLUX_VISUAL_AUDIT_MAILPIT_PORT:-18598}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-audit-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
# The audit signs four people in more than once; rate limiting is covered by the API suite.
export FLUX_AUTH_RATE_LIMIT=false
# The same throwaway test configuration as scripts/check_ui.sh, so the audit sees what the browser tests see.
# TEST ONLY: never set these in a deployment. The link card (#469) reaches the Compose link-mock as public.test.
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_TEST_PERSONAL_RUNS=anthropic-mock
export FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
export FLUX_AI_PRIVATE_TARGETS=openai-mock
export FLUX_LINK_PREVIEWS=on
export FLUX_TEST_LINK_PREVIEW_HOSTS=public.test=link-mock:8098
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
background_secret_dir=$(mktemp -d)
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"
# No push keys from a developer's docker/.env reach this run.
export FLUX_VAPID_PUBLIC_KEY='' FLUX_VAPID_PRIVATE_KEY='' FLUX_VAPID_SUBJECT=''
export FLUX_UI_SCREENSHOT_DIR="$out"
owner_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
partner_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml --profile ui"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color api | tail -60 || true
  fi
  $compose down -v >/dev/null 2>&1 || true
  remove_project_images
  chmod 0600 "$background_secret_dir/background_key"
  rm -rf "$background_secret_dir"
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
$compose run --rm -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" \
  -e FLUX_AUDIT_OUT=/screenshots -e FLUX_AUDIT_BROWSERS="${FLUX_AUDIT_BROWSERS:-}" -e FLUX_AUDIT_THEMES="${FLUX_AUDIT_THEMES:-}" \
  -e FLUX_AUDIT_VIEWPORTS="${FLUX_AUDIT_VIEWPORTS:-}" -e FLUX_AUDIT_SCREENS="${FLUX_AUDIT_SCREENS:-}" \
  ui-test python3 tests/ui/visual_consistency_audit.py
echo "Findings: $out/findings.md (screenshots in $out/shots, contact sheets in $out/sheets)"
