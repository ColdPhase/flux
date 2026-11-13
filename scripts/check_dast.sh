#!/bin/sh
# Dynamic security test (#838, wave 5): OWASP ZAP against the running application, in Docker only.
#
# Starts the Compose app on its own project and loopback port with the `./flux demo` data (two people: Ada, the owner, and Jonas, a
# member), signs both in through the public API, and describes the API as OpenAPI from the test deployment's own route listing
# (scripts/dast/prepare.py: every route with its body and query schemas, real ids of the demo data as examples). ZAP then runs:
#   1. the baseline scan of the web app, signed out (passive: headers, cookies, the SPA shell, its assets, with the AJAX spider);
#   2. the API scan, ACTIVE and AUTHENTICATED, once as Ada and once as Jonas (their session cookie goes on every request; so does
#      the Origin header every state-changing call needs).
# Reports go to the directory given as the first argument (default dast-reports/ in this checkout, ignored by git): baseline.*,
# api-ada.*, api-jonas.* (html and json) and summary.md. scripts/dast/summarize.py applies the recorded triage
# (scripts/dast/zap-rules.conf: every recorded false positive carries its reason) and exits 10 when a Medium or higher alert is
# left to triage, 2 when a report is missing or unusable.
#
# A manual acceptance step before a release, not a PR check (a full active scan takes tens of minutes). The stack is a TEST
# DEPLOYMENT (FLUX_FIXTURE_TOKEN with FLUX_TEST_FAILURE_INJECTION=true) only because the route listing exists there; its other
# differences (isolated test workspaces, the failure-injection header) are not scanned: /api/v1/test/ is left out of the OpenAPI
# document. The rate limits are OFF in this stack (FLUX_AUTH_RATE_LIMIT=false): an active scan sends thousands of requests a minute
# from one session and would be answered 429 for most of them, so it would test the limiter instead of the application. The limits
# are covered by tests/app/api-rate-limit-core.test.ts and the API suite.
# FLUX_DAST_PORT / FLUX_DAST_MAILPIT_PORT pick the loopback ports; FLUX_DAST_PEOPLE narrows the API scans (default "ada jonas");
# FLUX_DAST_SKIP_BASELINE=1 skips the baseline scan, FLUX_DAST_SKIP_API=1 the API scans (a quick check of the pages' headers).
# FLUX_DAST_ONLY, a regular expression, limits the API scans to the paths it matches (one change's routes, e.g. '/photo|/pictures/').
# The v0.2.1 routes are in the listing like every other: file previews (with a real file and the frame headers they need, C-60),
# profile photo and space icon uploads (raw bytes, F-039/F-040), receipt readers, search, model lists, calls, and videos (C-61: a sent
# video's playback route and a stored file read by byte range, the poster of a staged video, the file limits). The API offers its call
# routes only with a LiveKit server, so this stack runs one (docker/compose.live.yaml, a throwaway key; FLUX_DAST_LIVEKIT_TCP_PORT,
# FLUX_DAST_LIVEKIT_UDP_PORT and FLUX_DAST_LIVEKIT_TURN_PORT pick its media ports). One change's routes, for example:
# FLUX_DAST_ONLY='/preview|/photo|/icon|/pictures/|/receipts|/search|model-list|/ai-model-lists|/calls|/live-sessions|/files|/personal-assistant/model'.
set -eu

cd "$(dirname "$0")/.."
out="${1:-dast-reports}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
mkdir -p "$out"
chmod 0777 "$out"
project="flux-dast-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-dast-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-dast-$$-$(date +%s)"
export FLUX_PORT="${FLUX_DAST_PORT:-18599}"
export FLUX_MAILPIT_PORT="${FLUX_DAST_MAILPIT_PORT:-18600}"
# ZAP runs in the API container's network namespace and reaches it as http://127.0.0.1:8080 (a plain-http origin is allowed only on
# loopback); the Origin check and the cookies agree with that name.
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:8080"
export FLUX_AUTH_SECRET="auth-dast-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_TEST_FAILURE_INJECTION=true
# A test stack's enforced Content-Security-Policy allows eval for the browser test driver; ZAP is not one, so it scans the policy that ships (#979).
export FLUX_TEST_CSP_EVAL=false
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
background_secret_dir=$(mktemp -d)
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"
# Calls need a LiveKit server for their routes to exist; this one's key is made for the run and its media ports are the run's own.
export FLUX_LIVEKIT_API_KEY="dast$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_LIVEKIT_API_SECRET="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_LIVEKIT_PUBLIC_IP=127.0.0.1 FLUX_LIVEKIT_DOMAIN=localhost
export FLUX_LIVEKIT_ICE_TCP_PORT="${FLUX_DAST_LIVEKIT_TCP_PORT:-18601}"
export FLUX_LIVEKIT_ICE_UDP_PORT="${FLUX_DAST_LIVEKIT_UDP_PORT:-18602}"
export FLUX_LIVEKIT_TURN_UDP_PORT="${FLUX_DAST_LIVEKIT_TURN_PORT:-18603}"
# No push keys from a developer's docker/.env reach this run.
export FLUX_VAPID_PUBLIC_KEY='' FLUX_VAPID_PRIVATE_KEY='' FLUX_VAPID_SUBJECT=''
ada_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
jonas_password="demo-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# ZAP 2.17.0, pinned by digest (ghcr.io/zaproxy/zaproxy:stable on 2026-11-08).
zap_image="ghcr.io/zaproxy/zaproxy@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af"
. scripts/test_images.sh
compose="docker compose --env-file /dev/null -p $project -f docker/compose.source.yaml -f docker/compose.live.yaml"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$status" -ne 10 ]; then
    $compose logs --no-color api | tail -60 || true
  fi
  $compose down -v >/dev/null 2>&1 || true
  remove_project_images
  rm -f "$out"/cookie-*
  chmod 0600 "$background_secret_dir/background_key" 2>/dev/null || true
  rm -rf "$background_secret_dir"
  exit $status
}
trap cleanup EXIT HUP INT TERM

$compose build migrate
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker
echo "Seeding the ./flux demo data through the public API..."
$compose exec -T -e FLUX_PUBLIC_ORIGIN="$FLUX_PUBLIC_ORIGIN" \
  -e FLUX_DEMO_OWNER_PASSWORD="$ada_password" -e FLUX_DEMO_PARTNER_PASSWORD="$jonas_password" \
  api node --input-type=module - < scripts/flux-demo.mjs
python3 scripts/dast/prepare.py --api "http://127.0.0.1:$FLUX_PORT" --origin "$FLUX_PUBLIC_ORIGIN" --server "$FLUX_PUBLIC_ORIGIN" \
  --fixture-token "$FLUX_FIXTURE_TOKEN" --out "$out" \
  --person "ada=ada@demo.flux.test:$ada_password" --person "jonas=jonas@demo.flux.test:$jonas_password" --only "${FLUX_DAST_ONLY:-}"
cp scripts/dast/zap-rules.conf "$out/zap-rules.conf"

api_container=$($compose ps -q api)
# ZAP's own proxy listens on 8090 (-P): 8080 is the API's, in the namespace they share.
# `z` relabels the reports directory for the container on an SELinux host, so a directory outside this checkout (such as an evidence
# folder in the home directory) is readable by ZAP too; elsewhere it changes nothing.
zap() { tool=$1; shift; docker run --rm --network "container:$api_container" --user zap -v "$out:/zap/wrk:rw,z" "$zap_image" "$tool" -P 8090 "$@"; }
# Every request carries the Origin the API checks; a signed-in scan adds the person's session cookie. ZAP splits this string at
# spaces, so neither value has any.
replacer() {
  index=0
  for pair in "$@"; do
    printf -- '-config replacer.full_list(%s).description=%s -config replacer.full_list(%s).enabled=true -config replacer.full_list(%s).matchtype=REQ_HEADER -config replacer.full_list(%s).matchstr=%s -config replacer.full_list(%s).regex=false -config replacer.full_list(%s).replacement=%s ' \
      "$index" "dast-${pair%%=*}" "$index" "$index" "$index" "${pair%%=*}" "$index" "$index" "${pair#*=}"
    index=$((index + 1))
  done
}
# ZAP exits 0 (clean), 1 (failures), 2 (warnings) or 3 (the scan itself failed): only 3 stops the run; the reports decide the rest.
scan() {
  label=$1; shift
  code=0
  "$@" || code=$?
  if [ "$code" -gt 2 ]; then echo "dast: the $label scan failed (ZAP exit $code)" >&2; exit 2; fi
}

reports=""
if [ "${FLUX_DAST_SKIP_BASELINE:-0}" != 1 ]; then
  echo "ZAP baseline scan, signed out..."
  scan baseline zap zap-baseline.py -t "$FLUX_PUBLIC_ORIGIN/" -c /zap/wrk/zap-rules.conf -m 3 -j -I \
    -r baseline.html -J baseline.json -z "$(replacer "Origin=$FLUX_PUBLIC_ORIGIN")"
  reports="$out/baseline.json"
fi
for person in $([ "${FLUX_DAST_SKIP_API:-0}" = 1 ] || echo "${FLUX_DAST_PEOPLE:-ada jonas}"); do
  echo "ZAP active API scan, signed in as $person..."
  cookie=$(cat "$out/cookie-$person")
  scan "API ($person)" zap zap-api-scan.py -t /zap/wrk/openapi.json -f openapi -c /zap/wrk/zap-rules.conf -I \
    -r "api-$person.html" -J "api-$person.json" \
    -z "$(replacer "Origin=$FLUX_PUBLIC_ORIGIN" "Cookie=$cookie") -config scanner.threadPerHost=4 -config scanner.maxRuleDurationInMins=3"
  reports="$reports $out/api-$person.json"
done
rm -f "$out"/cookie-*
# shellcheck disable=SC2086
python3 scripts/dast/summarize.py --rules scripts/dast/zap-rules.conf --out "$out" $reports
