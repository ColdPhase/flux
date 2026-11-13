#!/bin/sh
# The first `./flux up` of a fresh checkout as an operator runs it, with NOTHING set (no FLUX_AGENT_RUNTIME in the environment and no
# docker/.env), on a host that can run the agent runtime: the launcher's own defaults must give a healthy Flux with AI on (#1438, #1441:
# AI works right after install, and every agent runs in the runtime). Every other launcher check sets FLUX_AGENT_RUNTIME itself, so a
# default the runtime's services refuse (codex,pi before they took pi: the friction audit's P1 of 2026-11-13) passed them all.
#
# Runs on an isolated copy of this checkout with its own Compose project, ports and volumes, and removes them afterwards. It needs a host
# with kernel.yama.ptrace_scope >= 1 (the launcher's host check); on another host it fails and says so. Set FLUX_FIRST_UP_PORT for
# concurrent runs. Run it under the shared Docker slot limiter.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
unset FLUX_PROJECT FLUX_AGENT_RUNTIME FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS FLUX_AGENT_RUNTIME_IDLE_DAYS FLUX_AGENT_RUNTIME_OFF_REASON FLUX_PERSONAL_RUNS
export FLUX_PORT="${FLUX_FIRST_UP_PORT:-19671}"
export FLUX_DEV_PORT=$((FLUX_PORT + 1))
export FLUX_MAILPIT_PORT=$((FLUX_PORT + 2))
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-first-up.XXXXXX")
export XDG_STATE_HOME="$work/state"
work=$(cd "$work" && pwd -P)
copy="$work/flux"
project=''

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$project" ]; then
    (cd "$copy" && FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml \
      -f docker/compose.source.runtime.yaml --profile runtime logs --no-color --tail 40 api worker runtime-manager runtime-egress runtime-install runtime-1 2>/dev/null) || true
  fi
  if [ -x "$copy/flux" ] && [ -f "$copy/docker/.env" ]; then (cd "$copy" && ./flux clean -y >/dev/null 2>&1) || true; fi
  if [ -n "$project" ]; then docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm >/dev/null 2>&1 || true; fi
  docker volume ls -q --filter "label=com.flux.checkout=$copy" | xargs -r docker volume rm >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$copy"
(cd "$here" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - 2>/dev/null) | (cd "$copy" && tar -xf -)
[ -x "$copy/flux" ] || fail "the copy is incomplete"
[ ! -e "$copy/docker/.env" ] || fail ".env was copied"
cd "$copy"

printf '== The first ./flux up, nothing set, no terminal (the default answer)\n'
./flux up </dev/null
project=$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)
[ -n "$project" ] || fail "no project name"
reason=$(sed -n 's/^FLUX_AGENT_RUNTIME_OFF_REASON=//p' docker/.env)
[ -z "$reason" ] || fail "this host cannot run the agent runtime ($reason): the check needs one that can"
runtime=$(sed -n 's/^FLUX_AGENT_RUNTIME=//p' docker/.env)
case ",$runtime," in *,pi,*) ;; *) fail "the default FLUX_AGENT_RUNTIME ($runtime) does not run API keys in pi" ;; esac

compose() { FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml -f docker/compose.source.runtime.yaml "$@"; }
for service in api worker runtime-manager runtime-egress runtime-1; do
  id=$(compose --profile runtime ps -q "$service")
  [ -n "$id" ] || fail "$service is not running after the first ./flux up"
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$id")
  case "$state" in
    'running healthy 0'|'running none 0') ;;
    *) fail "$service is $state after the first ./flux up" ;;
  esac
done
install=$(compose --profile runtime ps -aq runtime-install)
[ -n "$install" ] || fail "runtime-install did not run"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$install")" = 0 ] || fail "runtime-install exited $(docker inspect -f '{{.State.ExitCode}}' "$install")"
compose --profile runtime logs --no-color runtime-1 | grep -q '"event":"ready".*"pi":true' || fail "the runtime did not start ready for API keys in pi"
printf 'First ./flux up passed: FLUX_AGENT_RUNTIME=%s, the API, the worker and the runtime (manager, egress, slot with pi) are up and healthy.\n' "$runtime"
