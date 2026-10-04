#!/usr/bin/env bash
# One disposable synthetic fixture. No application/dependency execution on the host.
# Runs with the macOS system bash 3.2 and BSD tools as well as on Linux: no flock, timeout or GNU stat.
set -euo pipefail
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
node_image='node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
# Official multi-architecture (amd64 and arm64) image indexes, resolved from Docker Hub on 2026-10-04:
# cloudflare/cloudflared 2026.9.3 and selenium/standalone-chrome 153.0 (Chrome 153.0.8010.47).
default_tunnel_image='cloudflare/cloudflared@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c'
default_browser_image='selenium/standalone-chrome@sha256:7efe71e7e4a83bdf574b26bd354690928075e8f443223d2ced16a2c208eae1d7'
gateway_lease_seconds=7200
action=${1:-help}
if [[ "$action" == help ]]; then
  cat <<'USAGE'
Usage: scripts/mobile_push_fixture.sh session [PORT]      one command: build, seed and open a trusted HTTPS
                                                           Quick Tunnel for real devices; Ctrl-C removes it all
       scripts/mobile_push_fixture.sh preflight [PORT]    the same build/seed/local checks, closed, then removed
       scripts/mobile_push_fixture.sh check               the fixture's own tests, in Docker without network
       scripts/mobile_push_fixture.sh init CANDIDATE_SHA /tmp/flux-mobile-push-NAME [PORT]
       scripts/mobile_push_fixture.sh build|up|seed|probe|inspect|matrix|worker-results|close|down STATE
       scripts/mobile_push_fixture.sh reply STATE CASE_LABEL
       scripts/mobile_push_fixture.sh mute|unmute|deny|restore STATE
       scripts/mobile_push_fixture.sh unsubscribe|revoke STATE device-N
       scripts/mobile_push_fixture.sh open-local STATE
       scripts/mobile_push_fixture.sh open-https STATE HTTPS_ORIGIN REVIEWED_CANDIDATE_SHA
       scripts/mobile_push_fixture.sh tunnel STATE cloudflare/cloudflared@sha256:DIGEST REVIEWED_CANDIDATE_SHA
       scripts/mobile_push_fixture.sh record STATE PLATFORM SCENARIO pass|fail|unverified EVIDENCE_FILENAME 'EXACT VERSIONS'
       scripts/mobile_push_fixture.sh desktop-subscribe STATE [selenium/standalone-chrome@sha256:DIGEST]
       scripts/mobile_push_fixture.sh desktop-notifications|desktop-stop STATE
Only `session` (on a commit merged to origin/main) and `tunnel` open public access.
Read docs/development/mobile-push-verification.md.
USAGE
  exit 0
fi
command -v docker >/dev/null

check_tests() {
  docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 0.5 --network none \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$repo/scripts/mobile-push:/fixture:ro,z" "$node_image" node --test /fixture/fixture.test.mjs
}
if [[ "$action" == check ]]; then check_tests; exit; fi

case "$action" in
  init) candidate=${2:?Full clean candidate SHA required}; state=${3:?Private new state directory required}; port=${4:-8232} ;;
  session|preflight)
    candidate=$(git -C "$repo" rev-parse HEAD); port=${2:-8232}
    state="/tmp/flux-mobile-push-$action-$(date +%Y%m%d-%H%M%S)-$$"
    ;;
  *) state=${2:?Private state directory required} ;;
esac
[[ "$state" =~ ^/tmp/flux-mobile-push-[a-zA-Z0-9-]+$ ]] || { echo 'Use a private direct /tmp/flux-mobile-push-NAME directory' >&2; exit 1; }
candidate_check() {
  [[ "$candidate" =~ ^[a-f0-9]{40}$ && $(git -C "$repo" rev-parse HEAD) == "$candidate" && -z $(git -C "$repo" status --porcelain) ]] || { echo 'Candidate must be the exact clean worktree HEAD' >&2; exit 1; }
}
if [[ "$action" == session ]]; then
  candidate_check
  # Public exposure needs an independently reviewed boundary. A commit on the protected main branch
  # passed that review; anything else uses the manual tunnel/open-https steps with a named review.
  git -C "$repo" merge-base --is-ancestor "$candidate" refs/remotes/origin/main 2>/dev/null || {
    echo 'session opens public access only for a commit merged to origin/main: git switch main && git pull --ff-only' >&2; exit 1; }
fi
case "$action" in init|session|preflight) mkdir -m 700 -- "$state" ;; esac
mode_of() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1"; }
owner_of() { stat -c %u -- "$1" 2>/dev/null || stat -f %u -- "$1"; }
[[ -d "$state" && ! -L "$state" && $(mode_of "$state") == 700 && $(owner_of "$state") == $(id -u) ]] || { echo 'State directory must be owned, nonsymlinked and mode 0700' >&2; exit 1; }
lock="$state/.lock"
[[ ! -L "$lock" ]] || { echo 'Unsafe fixture lock' >&2; exit 1; }
mkdir -m 700 -- "$lock" 2>/dev/null || { echo "Another fixture command is running; if none is, remove $lock" >&2; exit 1; }
locked=1
unlock() { if [[ $locked == 1 ]]; then rmdir -- "$lock" 2>/dev/null || true; locked=0; fi; }
# Ambient application/developer settings cannot override generated fixture interpolation.
for variable in ${!MOBILE_@}; do unset "$variable"; done
node_tool() {
  docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --memory 256m --cpus 0.5 --network none --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -e MOBILE_STATE=/state -e "MOBILE_HOST_STATE=$state" -v "$repo/scripts/mobile-push:/fixture:ro,z" -v "$state:/state:z" \
    "$node_image" node /fixture/helper.mjs "$@"
}
fixture_project() {
  local project
  project=$(sed -n 's/^MOBILE_PROJECT=//p' "$state/fixture.env")
  [[ "$project" =~ ^flux-mobile-[a-f0-9]{12}$ ]] || { echo 'Invalid isolated fixture project' >&2; return 1; }
  printf '%s\n' "$project"
}
dc() {
  local project
  project=$(fixture_project)
  docker compose -p "$project" --env-file "$state/fixture.env" -f "$repo/docker/compose.mobile-push.yaml" "$@"
}
state_candidate() { candidate=$(sed -n 's/^[[:space:]]*"candidate": "\([a-f0-9]*\)",$/\1/p' "$state/state.json"); candidate_check; }
helper() { dc --profile tools run --rm -T --interactive=false --no-deps helper node /fixture/helper.mjs "$@"; }

# Exit handling: whatever this invocation started is stopped on any exit, error or interruption.
tunnel_container=''; tunnel_pid=''; close_on_exit=0; teardown_on_exit=0
teardown() {
  local project image
  node_tool close >/dev/null 2>&1 || true
  project=$(fixture_project) || return 1
  docker rm -f "$project-tunnel" >/dev/null 2>&1 || true
  dc --profile tools --profile desktop-provider down --volumes --remove-orphans --timeout 15 >"$state/cleanup.log" 2>&1
  # The candidate image is untagged and built only for this fixture. Without -f, an image that
  # another container or tag still references is kept.
  image=$(cat "$state/image-id" 2>/dev/null || true)
  if [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] && docker image inspect "$image" >/dev/null 2>&1; then
    docker image rm "$image" >>"$state/cleanup.log" 2>&1 || echo "Candidate image $image is still referenced; it was kept" >&2
  fi
}
on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ -n "$tunnel_container" ]]; then docker rm -f "$tunnel_container" >/dev/null 2>&1 || true; fi
  if [[ -n "$tunnel_pid" ]]; then wait "$tunnel_pid" 2>/dev/null || true; fi
  if [[ $close_on_exit == 1 ]]; then node_tool close >/dev/null 2>&1 || true; fi
  if [[ $teardown_on_exit == 1 ]]; then
    echo 'Stopping: tunnel closed; saving the evidence matrix and removing containers, volumes and the candidate image' >&2
    # Service output for diagnosing a failed run stays in the private state directory.
    if [[ $status != 0 ]]; then dc logs --no-color >"$state/failure-services.log" 2>&1 || true; fi
    helper matrix >/dev/null 2>&1 || true
    teardown || true
    echo "Private evidence and credentials remain in $state; delete it with: rm -rf $state" >&2
  fi
  unlock
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

build_image() {
  docker build --label "com.flux.commit=$candidate" --iidfile "$state/image-id" -f "$repo/docker/Dockerfile" "$repo/app" >"$state/build.log" 2>&1
  local image
  image=$(cat "$state/image-id"); [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
  [[ $(docker image inspect --format '{{index .Config.Labels "com.flux.commit"}}' "$image") == "$candidate" ]]
  node_tool image "$image"
}
start_stack() { [[ -f "$state/image-id" ]]; dc up -d --wait --wait-timeout 120 db files-init migrate api worker gateway >"$state/start.log" 2>&1; }
# Starts the Quick Tunnel to the closed gateway. Its output, including the origin, stays private.
start_tunnel() {
  local image=$1 project
  [[ "$image" =~ ^cloudflare/cloudflared@sha256:[a-f0-9]{64}$ ]] || { echo 'Official digest-pinned cloudflared image required' >&2; return 1; }
  project=$(fixture_project)
  node_tool close >/dev/null
  tunnel_container="$project-tunnel"
  docker run --rm --name "$tunnel_container" --network "${project}_default" \
    --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 0.5 \
    --log-opt max-size=5m --log-opt max-file=2 "$image" tunnel --no-autoupdate --url http://gateway:8080 >"$state/tunnel.log" 2>&1 &
  tunnel_pid=$!
}
tunnel_origin() {
  local deadline=$((SECONDS + 120)) origin
  while ((SECONDS < deadline)); do
    # A Quick Tunnel hostname has several hyphenated words; api.trycloudflare.com is not one.
    origin=$(grep -Eo 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' "$state/tunnel.log" 2>/dev/null | head -n 1 || true)
    if [[ -n "$origin" ]]; then printf '%s\n' "$origin"; return 0; fi
    kill -0 "$tunnel_pid" 2>/dev/null || break
    sleep 2
  done
  echo "No Quick Tunnel origin appeared; see the private $state/tunnel.log" >&2
  return 1
}
# Recreates API/worker at the HTTPS origin while the gateway is closed, opens it and verifies TLS.
open_https() {
  local origin=$1 attempt
  node_tool boundary https "$origin" "$candidate"
  close_on_exit=1
  dc up -d --wait --wait-timeout 120 api worker gateway >"$state/origin-start.log" 2>&1
  node_tool enable "$origin"
  # A new Quick Tunnel hostname can take a short while to resolve and route.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if helper verify-origin >"$state/https-check.log" 2>&1; then cat "$state/https-check.log"; return 0; fi
    sleep 5
  done
  cat "$state/https-check.log" >&2
  return 1
}
await_inbox_item() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    helper inspect >/dev/null
    if grep -q '"event": "[a-f0-9]\{12\}"' "$state/inspection.json"; then return 0; fi
    sleep 2
  done
  echo 'The reply produced no inbox item; see the private inspection.json' >&2
  return 1
}
gateway_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $2" "$3" "http://127.0.0.1:$1$4" 2>/dev/null || true
}
local_gateway_checks() {
  local port host status
  port=$(sed -n 's/^MOBILE_PORT=//p' "$state/fixture.env"); host="127.0.0.1:$port"
  for check in "200 $host -XGET /api/v1/health" "200 $host -XGET /manifest.webmanifest" "200 $host -XGET /sw.js" \
    "401 $host -XGET /api/v1/me" "403 $host -XPOST /api/auth/sign-up/email" "403 $host -XGET /api/v1/projects/x/files" \
    "421 foreign.invalid -XGET /api/v1/health"; do
    set -- $check
    status=$(gateway_status "$port" "$2" "$3" "$4")
    [[ "$status" == "$1" ]] || { echo "Gateway check $3 $4 (Host $2) returned $status; expected $1" >&2; return 1; }
  done
  echo "Local gateway: health, manifest and service worker open; anonymous identity 401; sign-up and files 403; foreign Host 421"
}
step() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

case "$action" in
  init) candidate_check; node_tool init "$candidate" "$port" ;;
  build) state_candidate; build_image ;;
  up) state_candidate; start_stack ;;
  seed|probe|inspect|reply|mute|unmute|deny|restore|unsubscribe|revoke|record|matrix)
    state_candidate
    helper "$action" "${@:3}"
    ;;
  open-local|open-https)
    state_candidate
    if [[ "$action" == open-local ]]; then
      port=$(sed -n 's/^MOBILE_PORT=//p' "$state/fixture.env"); origin="http://127.0.0.1:$port"; node_tool boundary local "$origin"
      close_on_exit=1
      dc up -d --wait --wait-timeout 120 api worker gateway >"$state/origin-start.log" 2>&1
      node_tool enable "$origin"
    else
      origin=${3:?Trusted HTTPS origin required}; reviewed=${4:?Independently reviewed candidate SHA required}
      [[ "$reviewed" == "$candidate" ]] || { echo 'The independent boundary review must name this candidate SHA' >&2; exit 1; }
      open_https "$origin"
    fi
    close_on_exit=0
    ;;
  worker-results)
    dc logs --no-color --no-log-prefix --tail 10000 worker 2>/dev/null | docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 64 --memory 128m --cpus 0.5 --network none -v "$repo/scripts/mobile-push:/fixture:ro,z" "$node_image" node /fixture/sanitize-worker.mjs >"$state/provider-results.jsonl"
    echo "Sanitized provider results saved in $state/provider-results.jsonl"
    ;;
  desktop-subscribe)
    state_candidate; node_tool browser-image "${3:-$default_browser_image}"
    dc --profile desktop-provider up -d desktop-browser >"$state/browser-start.log" 2>&1
    dc --profile tools run --rm -T --interactive=false --no-deps helper node /fixture/desktop-provider.mjs subscribe
    ;;
  desktop-notifications|desktop-stop)
    state_candidate; operation=${action#desktop-}
    dc --profile tools run --rm -T --interactive=false --no-deps helper node /fixture/desktop-provider.mjs "$operation"
    if [[ "$action" == desktop-stop ]]; then dc --profile desktop-provider stop desktop-browser >/dev/null; fi
    ;;
  tunnel)
    state_candidate; tunnel_image=${3:?Digest-pinned official cloudflared image required}; reviewed=${4:?Independently reviewed candidate SHA required}
    [[ "$reviewed" == "$candidate" ]] || { echo 'Exact source review required' >&2; exit 1; }
    # The tunnel starts while gateway is closed. Its output is private; a different terminal
    # prepares the printed HTTPS origin, recreates API/worker, enables and verifies TLS.
    close_on_exit=1
    start_tunnel "$tunnel_image"
    unlock
    deadline=$((SECONDS + gateway_lease_seconds))
    while kill -0 "$tunnel_pid" 2>/dev/null && ((SECONDS < deadline)); do sleep 5; done
    ;;
  preflight|session)
    step "Candidate $candidate; private state $state"
    node_tool init "$candidate" "$port" >/dev/null
    teardown_on_exit=1
    step 'Fixture tests (Docker, no network)'; check_tests >"$state/check.log" 2>&1 || { cat "$state/check.log" >&2; exit 1; }
    step 'Building the candidate image (a few minutes on a cold cache)'; build_image >/dev/null
    step 'Starting PostgreSQL, migrations, API, worker and the closed gateway'; start_stack
    step 'Seeding two synthetic accounts and a conversation'; helper seed >/dev/null
    step 'Probing private-endpoint, wrong-origin and fixture-command refusals'; helper probe >/dev/null
    if [[ "$action" == preflight ]]; then
      step 'Generating a reply and waiting for its inbox item'
      helper reply local-preflight >/dev/null; await_inbox_item
      origin="http://127.0.0.1:$port"
      [[ $(gateway_status "$port" "127.0.0.1:$port" -XGET /api/v1/health) == 503 ]] || { echo 'The gateway was not closed before opening' >&2; exit 1; }
      node_tool boundary local "$origin" >/dev/null
      close_on_exit=1
      dc up -d --wait --wait-timeout 120 api worker gateway >"$state/origin-start.log" 2>&1
      node_tool enable "$origin" >/dev/null
      checks=$(local_gateway_checks)
      step "$checks"
      helper matrix >/dev/null
      step 'Preflight passed; removing the fixture'
      exit 0
    fi
    step 'Starting the Quick Tunnel (public URL; the gateway stays closed until verified)'
    start_tunnel "$default_tunnel_image"
    origin=$(tunnel_origin)
    step "Opening $origin and verifying trusted TLS, manifest, service worker and anonymous refusal"
    open_https "$origin" >/dev/null
    unlock
    cat <<READY

  Flux is reachable for your devices at:  $origin
  Recipient sign-in (private, never post): cat $state/operator.md
  Open for at most two hours. Press Ctrl-C here to close it and remove everything.

  In a second terminal:
    state=$state
    ./scripts/mobile_push_fixture.sh inspect "\$state"            # devices that turned on notifications
    ./scripts/mobile_push_fixture.sh reply "\$state" iphone-locked  # sends one push to every subscribed device
    ./scripts/mobile_push_fixture.sh record "\$state" iphone locked-display pass photo.jpg 'MODEL; iOS X.Y; Safari X.Y'
  Steps per device: docs/development/mobile-push-verification.md ("Real-device session").

READY
    deadline=$((SECONDS + gateway_lease_seconds))
    while kill -0 "$tunnel_pid" 2>/dev/null && ((SECONDS < deadline)); do sleep 5; done
    kill -0 "$tunnel_pid" 2>/dev/null || { echo "The tunnel stopped; see the private $state/tunnel.log" >&2; exit 1; }
    step 'The two-hour lease ended'
    ;;
  close) node_tool close ;;
  down) teardown; echo "Fixture containers, volumes and candidate image removed; private evidence remains in $state" ;;
  *) echo 'Unknown action; use help' >&2; exit 1 ;;
esac
