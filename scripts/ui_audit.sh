#!/bin/sh
# The v0.2.1 UI and UX audit (#1215, #1245), in Docker only: every route of app/apps/web/src/router.tsx in every state of #1215,
# at 16 windows (computer 1280–3440, tablets 820/1180/1024/800, phones 320–430 and landscape), light and dark, Chromium and
# WebKit, plus loading/error/Try again, focus and 200 % text, reduced motion, shortcuts, journeys checked after a reload, and the
# MOB-1…7 checks emulation can make. One command; it measures and reports, findings never fail it (a crashed phase does: exit 2,
# and the report says INCOMPLETE):
#
#   ./scripts/ui_audit.sh [out-dir]          (default: ui-audit/<commit> in this checkout, ignored by git)
#
# Starts the app on its own Compose project and loopback ports (FLUX_UIAUDIT_PORT and the next one for Mailpit; unset, the first free
# pair from 18761, so a second audit or a test suite on the same host does not collide), with throwaway VAPID keys so the server can
# push (the push offer), captures the empty server's first-run pages, seeds the `./flux demo` data (scripts/flux-demo.mjs), then runs
# app/tests/ui/ui_audit.py in the pinned Playwright container. The audit file is mounted from this checkout, so an edited harness reruns without an image build. Output: matrix.md, findings.md,
# findings.json, summary.json, shots/<engine>-<theme>-<window>/<screen>.png with <screen>.aria.yml beside it, states/, a11y/,
# keys/, journeys/, mob/ and contact sheets in sheets/. Narrow a run with FLUX_UIAUDIT_PHASES, _BROWSERS, _THEMES, _WINDOWS,
# _SCREENS (comma-separated; see the docstring of ui_audit.py). FLUX_UIAUDIT_KEEP=1 leaves the stack up afterwards and prints
# how to rerun phases against it (FLUX_UIAUDIT_REUSE=<project> reuses such a stack and its seed.json). Not part of
# check_ui.sh or check_application.sh.
set -eu

cd "$(dirname "$0")/.."
# The tested commit (FLUX_UIAUDIT_SHA names it when the images were built from another checkout).
sha=${FLUX_UIAUDIT_SHA:-$(git rev-parse --short=12 HEAD)}
out="${1:-ui-audit/$sha}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
mkdir -p "$out"
export FLUX_UI_SCREENSHOT_DIR="$out"
port_busy() { command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
# The app's and Mailpit's loopback ports: the ones asked for, or the first free pair from 18761 (kept in the state file for a reuse).
pick_ports() {
  audit_port="${FLUX_UIAUDIT_PORT:-}"
  if [ -z "$audit_port" ]; then
    audit_port=18761
    while { port_busy "$audit_port" || port_busy "$((audit_port + 1))"; } && [ "$audit_port" -lt 18999 ]; do audit_port=$((audit_port + 2)); done
  fi
  audit_mailpit_port="${FLUX_UIAUDIT_MAILPIT_PORT:-$((audit_port + 1))}"
  for busy in "$audit_port" "$audit_mailpit_port"; do
    if port_busy "$busy"; then echo "Port $busy is in use; set FLUX_UIAUDIT_PORT (and FLUX_UIAUDIT_MAILPIT_PORT) to free ones." >&2; exit 2; fi
  done
  export FLUX_PORT="$audit_port" FLUX_MAILPIT_PORT="$audit_mailpit_port" FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${audit_port}"
}
. scripts/test_images.sh
# FLUX_UIAUDIT_IMAGES=<tag> runs on images already built for this commit (tagged :<tag>) instead of building them; they are kept.
if [ -n "${FLUX_UIAUDIT_IMAGES:-}" ]; then export FLUX_IMAGE_TAG="$FLUX_UIAUDIT_IMAGES" FLUX_KEEP_TEST_IMAGES=1; fi
state="$out/.stack.env"
reuse="${FLUX_UIAUDIT_REUSE:-}"
if [ -n "$reuse" ] && [ -f "$state" ]; then
  # shellcheck disable=SC1090
  . "$state"
  project="$reuse"
  audit_port="${audit_port:-${FLUX_UIAUDIT_PORT:-18761}}"
  audit_mailpit_port="${audit_mailpit_port:-$((audit_port + 1))}"
else
  project="flux-uiaudit-$(date +%s)-$$"
  pick_ports
  POSTGRES_PASSWORD="flux-uiaudit-$$-$(date +%s)"
  FLUX_FIXTURE_TOKEN="fixture-uiaudit-$$-$(date +%s)"
  FLUX_AUTH_SECRET="auth-uiaudit-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  owner_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  partner_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  background_secret_dir="$out/.secrets"
  mkdir -p "$background_secret_dir"
  head -c 32 /dev/urandom > "$background_secret_dir/background_key"
  chmod 0444 "$background_secret_dir/background_key"
  FLUX_VAPID_PUBLIC_KEY='' FLUX_VAPID_PRIVATE_KEY='' FLUX_VAPID_SUBJECT=''
fi
export FLUX_PORT="$audit_port" FLUX_MAILPIT_PORT="$audit_mailpit_port" FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${audit_port}"
export POSTGRES_USER=flux POSTGRES_DB=flux POSTGRES_PASSWORD FLUX_FIXTURE_TOKEN FLUX_AUTH_SECRET FLUX_KEYRING_TOKEN FLUX_KEY_PIN_SECRET
export FLUX_SMTP_URL="smtp://mailpit:1025" FLUX_MAIL_FROM="Flux <flux@example.test>"
# The audit signs people in many times from one address; rate limiting is covered by the API suite.
export FLUX_AUTH_RATE_LIMIT=false
# The same throwaway test configuration as scripts/check_ui.sh. TEST ONLY: never set these in a deployment.
export FLUX_TEST_FAILURE_INJECTION=true FLUX_TEST_PERSONAL_RUNS=anthropic-mock FLUX_TEST_ANTHROPIC_URL=http://anthropic-mock:8090
# An API key is checked against the mock's model lists (the media scene connects Ada's AI with one).
export FLUX_TEST_PROVIDER_LISTS=http://anthropic-mock:8090
export FLUX_AI_PRIVATE_TARGETS=openai-mock FLUX_LINK_PREVIEWS=on FLUX_TEST_LINK_PREVIEW_HOSTS=public.test=link-mock:8098
export FLUX_BACKGROUND_KEY_HOST_FILE="$out/.secrets/background_key"
# Every agent on an API key runs in pi in the agent runtime (#1441, RT-1), as in scripts/check_ui.sh: the stack has the runtime with
# `pi`, and the worker's model gateway sends pi's requests to the mock provider. The runtime's supervisor needs kernel.yama.ptrace_scope >= 1.
export FLUX_AGENT_RUNTIME=pi
export FLUX_RUNTIME_MANAGER_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_RUNTIME_SECRET_1="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
compose="docker compose --env-file /dev/null -p $project -f docker/compose.source.yaml -f docker/compose.source.runtime.yaml --profile ui --profile runtime"
audit_env="-e FLUX_DEMO_OWNER_PASSWORD=$owner_password -e FLUX_DEMO_PARTNER_PASSWORD=$partner_password -e FLUX_AUDIT_OUT=/screenshots
  -e FLUX_UIAUDIT_SHA=$sha -e FLUX_UIAUDIT_BROWSERS -e FLUX_UIAUDIT_THEMES -e FLUX_UIAUDIT_WINDOWS -e FLUX_UIAUDIT_SCREENS
  -e FLUX_UIAUDIT_PARALLEL -e FLUX_UIAUDIT_STATE_WINDOWS -e FLUX_UIAUDIT_A11Y_WINDOWS -e FLUX_UIAUDIT_ANNOTATE
  -e FLUX_UIAUDIT_CHUNKS -e FLUX_UIAUDIT_TAG"
mount="-v $PWD/app/tests/ui:/work/tests/ui:ro,z"

# The Playwright container writes as root: hand the output back to the person who ran the audit.
own_output() {
  docker image inspect "flux-ui-tests:${FLUX_IMAGE_TAG:-$project}" >/dev/null 2>&1 || return 0  # nothing was built (a failed build): nothing was written, and `run` must not build it now
  $compose run --rm --no-deps -T -v "$out:/out:z" --entrypoint chown ui-test -R "$(id -u):$(id -g)" /out >/dev/null 2>&1 || true
}

cleanup() {
  status=$?
  if [ "${FLUX_UIAUDIT_KEEP:-}" = 1 ]; then
    own_output
    echo "Stack kept: $project. Rerun phases with FLUX_UIAUDIT_REUSE=$project FLUX_UIAUDIT_PHASES=... $0 $out; stop it with: docker compose -p $project down -v"
    exit $status
  fi
  if [ "$status" -ne 0 ]; then $compose logs --no-color api | tail -60 || true; fi
  own_output
  $compose down -v >/dev/null 2>&1 || true
  remove_project_images
  chmod 0600 "$out/.secrets/background_key" 2>/dev/null || true
  rm -rf "$out/.secrets" "$state"
  exit $status
}
trap cleanup EXIT HUP INT TERM

if [ -z "$reuse" ]; then
  if [ -n "${FLUX_UIAUDIT_IMAGES:-}" ]; then
    echo "Using the images tagged :$FLUX_UIAUDIT_IMAGES (no build)."
  else
    $compose build migrate ui-test runtime-1 runtime-install
  fi
  # The build above takes minutes: look again, right before the app binds its port, so two audits started together do not take the same pair.
  pick_ports
  $compose up -d db migrate
  $compose --profile setup run --rm files-init
  # Throwaway VAPID keys (the pinned command `./flux up` uses), so the server can push and the push offer can show.
  keys=$($compose run --rm --no-deps -T migrate apps/worker/node_modules/.bin/web-push generate-vapid-keys --json 2>/dev/null) || keys=""
  FLUX_VAPID_PUBLIC_KEY=$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')
  FLUX_VAPID_PRIVATE_KEY=$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')
  [ -n "$FLUX_VAPID_PUBLIC_KEY" ] && FLUX_VAPID_SUBJECT="mailto:admin@localhost.localdomain" || echo "No VAPID keys: the push offer will not show." >&2
  export FLUX_VAPID_PUBLIC_KEY FLUX_VAPID_PRIVATE_KEY FLUX_VAPID_SUBJECT
  $compose up -d --wait api worker runtime-egress runtime-manager runtime-1
  cat > "$state" <<EOF
POSTGRES_PASSWORD='$POSTGRES_PASSWORD'
FLUX_FIXTURE_TOKEN='$FLUX_FIXTURE_TOKEN'
FLUX_AUTH_SECRET='$FLUX_AUTH_SECRET'
FLUX_KEYRING_TOKEN='$FLUX_KEYRING_TOKEN'
FLUX_KEY_PIN_SECRET='$FLUX_KEY_PIN_SECRET'
FLUX_VAPID_PUBLIC_KEY='$FLUX_VAPID_PUBLIC_KEY'
FLUX_VAPID_PRIVATE_KEY='$FLUX_VAPID_PRIVATE_KEY'
FLUX_VAPID_SUBJECT='$FLUX_VAPID_SUBJECT'
owner_password='$owner_password'
partner_password='$partner_password'
audit_port='$audit_port'
audit_mailpit_port='$audit_mailpit_port'
EOF
  chmod 0600 "$state"
  echo "First run: the empty server's sign-up and sign-in..."
  # shellcheck disable=SC2086
  $compose run --rm $mount $audit_env -e FLUX_UIAUDIT_PHASES=firstrun ui-test python3 tests/ui/ui_audit.py
  echo "Seeding the ./flux demo data through the public API..."
  $compose exec -T -e FLUX_PUBLIC_ORIGIN="$FLUX_PUBLIC_ORIGIN" \
    -e FLUX_DEMO_OWNER_PASSWORD="$owner_password" -e FLUX_DEMO_PARTNER_PASSWORD="$partner_password" \
    api node --input-type=module - < scripts/flux-demo.mjs
else
  export FLUX_VAPID_PUBLIC_KEY FLUX_VAPID_PRIVATE_KEY FLUX_VAPID_SUBJECT
fi
status=0
# shellcheck disable=SC2086
$compose run --rm $mount $audit_env -e FLUX_UIAUDIT_PHASES="${FLUX_UIAUDIT_PHASES:-seed,capture,states,a11y,keys,journeys,mob,report}" \
  ui-test python3 tests/ui/ui_audit.py || status=$?
echo "UI audit of $sha (exit $status): $out/matrix.md, $out/findings.md (screenshots in $out/shots, contact sheets in $out/sheets)"
exit $status
