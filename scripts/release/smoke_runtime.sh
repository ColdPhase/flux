#!/usr/bin/env bash
# Exercise the agent runtime of a downloaded, digest-pinned release (#358 AC-3) in one isolated project, with the
# REAL runtime image and no vendor account: off by default; claude_code refused without the Commercial Terms
# date; switch-on with Codex; the slots' `docker inspect` limits and no engine socket; no Claude Code in the
# image and the pinned Codex in it; a slot cannot reach the database or the API; off keeps the slot volumes;
# purge (the off -> purge path) removes every runtime container and volume. A bound slot's sign-out and reuse
# need a vendor login, so they are NOT covered here (scripts/check_agent_runtime.sh covers them with fake
# CLIs against the source stack). The host needs Linux Yama ptrace_scope >= 1 (docs/operations/agent-runtime.md).
# Port defaults to 18083; set FLUX_SMOKE_RUNTIME_PORT when it is taken.
set -euo pipefail

assets=${1:?release asset directory required}
state_dir=${2:?temporary state directory required}
project=${3:?project name required}
port=${FLUX_SMOKE_RUNTIME_PORT:-18083}
mkdir -p "$state_dir"
assets=$(realpath "$assets")
state_dir=$(realpath "$state_dir")
root=$(cd "$(dirname "$0")/../.." && pwd)
env_file="$state_dir/runtime.env"

compose() { docker compose --env-file "$env_file" -f "$assets/compose.yaml" -f "$assets/compose.runtime.yaml" --profile runtime "$@"; }
runtime_sh() { FLUX_ENV_FILE="$env_file" sh "$assets/runtime.sh" "$@"; }
fail() { echo "smoke_runtime: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
runtime_containers() {
  docker ps -aq --filter "label=com.docker.compose.project=$project" |
    xargs -r docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' | grep -E '^runtime-' || true
}
runtime_volumes() { docker volume ls -q --filter "label=com.docker.compose.project=$project" | grep -E "^${project}_runtime-" || true; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --no-color --tail 40 api worker runtime-install runtime-manager runtime-egress runtime-1 2>/dev/null || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

python3 "$root/scripts/release/write_test_env.py" --source "$assets/env.example" --destination "$env_file" --port "$port"
sed -e "s/^FLUX_PROJECT=.*/FLUX_PROJECT=$project/" "$env_file" > "$env_file.new" && mv "$env_file.new" "$env_file" && chmod 600 "$env_file" # GNU and BSD sed
grep -q "^FLUX_PROJECT=$project\$" "$env_file" || fail "the environment template has no FLUX_PROJECT line"
app_image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$assets/release.json")
runtime_image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime_image"])' "$assets/release.json")
codex_tag=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime_codex"])' "$assets/release.json")

step "0. Host: Linux Yama ptrace_scope >= 1 for the slots (read in the engine's kernel with the runtime image itself)"
docker pull --quiet "$runtime_image" >/dev/null
scope=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint cat "$runtime_image" /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true)
case "$scope" in
  1|2|3) echo "kernel.yama.ptrace_scope=$scope" ;;
  *) echo "smoke_runtime: this engine's kernel has no Yama ptrace_scope of 1 or higher (got '${scope:-none}'); every slot would refuse to start. Use a Linux host with kernel.yama.ptrace_scope=1." >&2; exit 3 ;;
esac

step "1. Both Compose files are valid together; the runtime is off by default"
compose config --quiet
# The image release.json names (ghcr.io in a release; the dry run's local registry rewrites both alike).
[ "$(compose config --images | grep -cxF "$runtime_image")" -ge 1 ] || fail "no runtime image $runtime_image in the merged configuration"
! compose config --images | grep -Eq 'RELEASE_DIGEST|RUNTIME_DIGEST|:latest' || fail "marker or floating tag in the merged configuration"
runtime_sh up
[ -z "$(runtime_containers)" ] || fail "runtime containers exist while FLUX_AGENT_RUNTIME is empty: $(runtime_containers)"
runtime_sh status | grep -q "(off)" || fail "status does not say the runtime is off"
curl --fail --show-error --silent "http://127.0.0.1:$port/api/v1/health" >/dev/null

step "2. claude_code is refused without the Commercial Terms date and changes nothing"
if runtime_sh on claude_code 2>"$state_dir/refusal.err"; then fail "claude_code started without the Commercial Terms statement"; fi
grep -q 'Commercial Terms' "$state_dir/refusal.err" || fail "the refusal does not name the Commercial Terms"
grep -q '^FLUX_AGENT_RUNTIME=$' "$env_file" || fail "the refused switch changed FLUX_AGENT_RUNTIME"
[ -z "$(runtime_containers)" ] || fail "runtime containers exist after the refused switch"

step "3. Switch on with Codex: services run, runtime-install is a no-op, slots are free"
runtime_sh on codex
for service in runtime-manager runtime-egress runtime-1 runtime-2 runtime-3 runtime-4; do
  [ -n "$(compose ps -q --status running "$service")" ] || fail "$service is not running"
done
[ "$(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -aq runtime-install)")" = 0 ] || fail "runtime-install did not exit 0"
slots=$(runtime_sh status)
printf '%s\n' "$slots"
[ "$(printf '%s\n' "$slots" | grep -c $'^runtime-[1-4]\tboot .*\tempty')" = 4 ] || fail "the four slots are not all reported empty"
grep -q '^FLUX_RUNTIME_SECRET_4=[0-9a-f]\{64\}$' "$env_file" || fail "runtime.sh did not generate the slot secrets"

step "4. docker inspect: limits and security options on every runtime service; no engine socket, no host path"
# shellcheck disable=SC2046
docker inspect $(docker ps -q --filter "label=com.docker.compose.project=$project") > "$state_dir/inspect.json"
python3 "$root/scripts/agent-runtime/inspect.py" "$project" "$assets" < "$state_dir/inspect.json"

step "5. The images: pinned Codex in, Claude Code out"
[ "$(compose config --images | grep -c "^$runtime_image\$")" = 1 ] || fail "compose.runtime.yaml does not use the runtime image of release.json"
[ "$(compose config --images | grep -c "^$app_image\$")" = 1 ] || fail "compose.yaml does not use the application image of release.json"
codex_version=$(docker run --rm --network none --entrypoint /opt/flux-runtime/codex/bin/codex "$runtime_image" --version)
[ "$codex_version" = "codex-cli ${codex_tag#rust-v}" ] || fail "Codex reports '$codex_version', the release pins $codex_tag"
docker run --rm --network none --entrypoint sh "$runtime_image" -c '
  ! command -v claude >/dev/null 2>&1 && [ -z "$(find / -xdev \( -name claude -o -name claude-code \) -not -path "/proc/*" 2>/dev/null | head -n 1)" ] &&
  [ -z "$(ls -A /opt/flux-tools)" ]' || fail "Claude Code (or a tools directory entry) is in the runtime image"
echo "Codex $codex_version is pinned; the image holds no Claude Code and an empty /opt/flux-tools"

step "6. A slot cannot reach the database, the API, the worker or another slot"
compose exec -T runtime-1 node -e '
  const net = require("node:net");
  const targets = [["db", 5432], ["api", 8080], ["worker", 8080], ["runtime-2", 8080], ["1.1.1.1", 443]];
  let open = 0, left = targets.length;
  for (const [host, port] of targets) {
    const socket = net.connect({ host, port, timeout: 3000 });
    const done = (reached) => { socket.destroy(); if (reached) { open += 1; console.error("REACHED " + host + ":" + port); } if (--left === 0) process.exit(open ? 1 : 0); };
    socket.on("connect", () => done(true)); socket.on("error", () => done(false)); socket.on("timeout", () => done(false));
  }' || fail "a slot reached something outside its own network"
echo "runtime-1 reaches none of db, api, worker, runtime-2 or the internet"

step "7. Switch off keeps the slot volumes; off -> purge removes every runtime container and volume"
runtime_sh off
[ -z "$(runtime_containers)" ] || fail "runtime containers remain after off: $(runtime_containers)"
[ "$(runtime_volumes | grep -c -- '-data$')" = 4 ] || fail "off must keep the four slot volumes"
curl --fail --show-error --silent "http://127.0.0.1:$port/api/v1/health" >/dev/null
runtime_sh purge -y
[ -z "$(runtime_containers)" ] || fail "runtime containers remain after purge"
[ -z "$(runtime_volumes)" ] || fail "runtime volumes remain after purge: $(runtime_volumes)"
runtime_sh up
curl --fail --show-error --silent "http://127.0.0.1:$port/api/v1/health" >/dev/null
echo 'Packaged agent runtime: off by default, switch-on, isolation, off and purge passed.'
