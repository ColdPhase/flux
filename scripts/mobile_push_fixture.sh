#!/usr/bin/env bash
# One disposable synthetic fixture. No application/dependency execution on the host.
set -euo pipefail
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
node_image='node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
action=${1:-help}
if [[ "$action" == help ]]; then
  cat <<'USAGE'
Usage: scripts/mobile_push_fixture.sh init CANDIDATE_SHA /tmp/flux-mobile-push-NAME [PORT]
       scripts/mobile_push_fixture.sh build|up|seed|probe|inspect|matrix|worker-results|check|close|down STATE
       scripts/mobile_push_fixture.sh reply STATE CASE_LABEL
       scripts/mobile_push_fixture.sh mute|unmute|deny|restore STATE
       scripts/mobile_push_fixture.sh unsubscribe|revoke STATE device-N
       scripts/mobile_push_fixture.sh open-local STATE
       scripts/mobile_push_fixture.sh open-https STATE HTTPS_ORIGIN REVIEWED_CANDIDATE_SHA
       scripts/mobile_push_fixture.sh tunnel STATE cloudflare/cloudflared@sha256:DIGEST REVIEWED_CANDIDATE_SHA
       scripts/mobile_push_fixture.sh record STATE PLATFORM SCENARIO pass|fail|unverified EVIDENCE_FILENAME 'EXACT VERSIONS'
       scripts/mobile_push_fixture.sh desktop-subscribe STATE selenium/standalone-chrome@sha256:DIGEST
       scripts/mobile_push_fixture.sh desktop-notifications|desktop-stop STATE
No tunnel/public exposure is started by init/build/up/check. Read docs/development/mobile-push-verification.md.
USAGE
  exit 0
fi
command -v docker >/dev/null
command -v flock >/dev/null
if [[ "$action" == init ]]; then
  candidate=${2:?Full clean candidate SHA required}; state=${3:?Private new state directory required}; port=${4:-8232}
else
  state=${2:?Private state directory required}
fi
[[ "$state" =~ ^/tmp/flux-mobile-push-[a-zA-Z0-9-]+$ ]] || { echo 'Use a private direct /tmp/flux-mobile-push-NAME directory' >&2; exit 1; }
if [[ "$action" == init ]]; then mkdir -m 700 -- "$state"; fi
[[ -d "$state" && ! -L "$state" && $(stat -c %a "$state") == 700 && $(stat -c %u "$state") == $(id -u) ]] || { echo 'State directory must be owned, nonsymlinked and mode 0700' >&2; exit 1; }
[[ ! -L "$state/.lock" ]] || { echo 'Unsafe fixture lock' >&2; exit 1; }
exec 9>"$state/.lock"
flock -n 9 || { echo 'Another fixture command is running' >&2; exit 1; }
# Ambient application/developer settings cannot override generated fixture interpolation.
for variable in ${!MOBILE_@}; do unset "$variable"; done
node_tool() {
  docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --memory 256m --cpus 0.5 --network none --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -e MOBILE_STATE=/state -e "MOBILE_HOST_STATE=$state" -v "$repo/scripts/mobile-push:/fixture:ro" -v "$state:/state" \
    "$node_image" node /fixture/helper.mjs "$@"
}
dc() {
  local fixture_project
  fixture_project=$(sed -n 's/^MOBILE_PROJECT=//p' "$state/fixture.env")
  [[ "$fixture_project" =~ ^flux-mobile-[a-f0-9]{12}$ ]] || { echo 'Invalid isolated fixture project' >&2; return 1; }
  docker compose -p "$fixture_project" --env-file "$state/fixture.env" -f "$repo/docker/compose.mobile-push.yaml" "$@"
}
candidate_check() {
  [[ "$candidate" =~ ^[a-f0-9]{40}$ && $(git -C "$repo" rev-parse HEAD) == "$candidate" && -z $(git -C "$repo" status --porcelain) ]] || { echo 'Candidate must be the exact clean worktree HEAD' >&2; exit 1; }
}
state_candidate() { candidate=$(sed -n 's/^[[:space:]]*"candidate": "\([a-f0-9]*\)",$/\1/p' "$state/state.json"); candidate_check; }
helper() { dc --profile tools run --rm -T --no-deps helper node /fixture/helper.mjs "$@"; }
case "$action" in
  init) candidate_check; node_tool init "$candidate" "$port" ;;
  build)
    state_candidate
    docker build --label "com.flux.commit=$candidate" --iidfile "$state/image-id" -f "$repo/docker/Dockerfile" "$repo/app" >"$state/build.log" 2>&1
    image=$(cat "$state/image-id"); [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
    [[ $(docker image inspect --format '{{index .Config.Labels "com.flux.commit"}}' "$image") == "$candidate" ]]
    node_tool image "$image"
    ;;
  up) state_candidate; [[ -f "$state/image-id" ]]; dc up -d --wait --wait-timeout 120 db files-init migrate api worker gateway >"$state/start.log" 2>&1 ;;
  check)
    docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 0.5 --network none \
      --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$repo/scripts/mobile-push:/fixture:ro" "$node_image" node --test /fixture/fixture.test.mjs
    ;;
  seed|probe|inspect|reply|mute|unmute|deny|restore|unsubscribe|revoke|record|matrix)
    state_candidate
    helper "$action" "${@:3}"
    ;;
  open-local|open-https)
    state_candidate
    if [[ "$action" == open-local ]]; then
      port=$(sed -n 's/^MOBILE_PORT=//p' "$state/fixture.env"); origin="http://127.0.0.1:$port"; node_tool boundary local "$origin"
    else
      origin=${3:?Trusted HTTPS origin required}; reviewed=${4:?Independently reviewed candidate SHA required}
      [[ "$reviewed" == "$candidate" ]]; node_tool boundary https "$origin" "$reviewed"
    fi
    trap 'node_tool close >/dev/null 2>&1 || true' ERR
    dc up -d --wait --wait-timeout 120 api worker gateway >"$state/origin-start.log" 2>&1
    node_tool enable "$origin"
    if [[ "$action" == open-https ]]; then helper verify-origin; fi
    trap - ERR
    ;;
  worker-results)
    dc logs --no-color --no-log-prefix --tail 10000 worker 2>/dev/null | docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 64 --memory 128m --cpus 0.5 --network none -v "$repo/scripts/mobile-push:/fixture:ro" "$node_image" node /fixture/sanitize-worker.mjs >"$state/provider-results.jsonl"
    echo "Sanitized provider results saved in $state/provider-results.jsonl"
    ;;
  desktop-subscribe)
    state_candidate; node_tool browser-image "${3:?Digest-pinned official Selenium Chrome image required}"
    dc --profile desktop-provider up -d desktop-browser >"$state/browser-start.log" 2>&1
    dc --profile tools run --rm -T --no-deps helper node /fixture/desktop-provider.mjs subscribe
    ;;
  desktop-notifications|desktop-stop)
    state_candidate; operation=${action#desktop-}
    dc --profile tools run --rm -T --no-deps helper node /fixture/desktop-provider.mjs "$operation"
    if [[ "$action" == desktop-stop ]]; then dc --profile desktop-provider stop desktop-browser >/dev/null; fi
    ;;
  tunnel)
    state_candidate; tunnel_image=${3:?Digest-pinned official cloudflared image required}; reviewed=${4:?Independently reviewed candidate SHA required}
    [[ "$reviewed" == "$candidate" && "$tunnel_image" =~ ^cloudflare/cloudflared@sha256:[a-f0-9]{64}$ ]] || { echo 'Exact source review and official digest-pinned image required' >&2; exit 1; }
    project=$(sed -n 's/^MOBILE_PROJECT=//p' "$state/fixture.env"); [[ "$project" =~ ^flux-mobile-[a-f0-9]{12}$ ]]
    command -v timeout >/dev/null
    # The tunnel starts while gateway is closed. Its output is private; a different terminal
    # prepares the printed HTTPS origin, recreates API/worker, enables and verifies TLS.
    node_tool close >/dev/null
    flock -u 9
    cleanup_tunnel() {
      docker rm -f "$project-tunnel" >/dev/null 2>&1 || true
      node_tool close >/dev/null 2>&1 || true
    }
    trap cleanup_tunnel EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    timeout --signal=TERM --kill-after=10s 2h docker run --rm --name "$project-tunnel" --network "${project}_default" \
      --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 0.5 \
      --log-opt max-size=5m --log-opt max-file=2 "$tunnel_image" tunnel --no-autoupdate --url http://gateway:8080 >"$state/tunnel.log" 2>&1
    ;;
  close) node_tool close ;;
  down)
    node_tool close >/dev/null
    project=$(sed -n 's/^MOBILE_PROJECT=//p' "$state/fixture.env"); [[ "$project" =~ ^flux-mobile-[a-f0-9]{12}$ ]]
    docker rm -f "$project-tunnel" >/dev/null 2>&1 || true
    dc --profile tools --profile desktop-provider down --volumes --remove-orphans --timeout 15 >"$state/cleanup.log" 2>&1
    # Deliberately retain private evidence; explicit operator deletion removes credentials.
    echo "Fixture containers and volumes removed; private evidence remains in $state"
    ;;
  *) echo 'Unknown action; use help' >&2; exit 1 ;;
esac
