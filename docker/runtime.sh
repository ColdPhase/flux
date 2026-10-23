#!/bin/sh
# Agent runtime operator script for ONE Flux release (#358; docs/operations/agent-runtime.md). It ships as the
# release asset runtime.sh next to compose.yaml, compose.runtime.yaml and env.example, and does what the
# source checkout's `./flux up`, `./flux ai on` and `./flux runtime ...` do, with `docker compose` only:
#
#   sh runtime.sh on codex|claude_code|claude_code,codex [--commercial-terms YYYY-MM-DD]
#   sh runtime.sh off        # stop the runtime services; slot volumes and logins stay
#   sh runtime.sh up         # apply the switch in .env (use it instead of `docker compose up` once it is on)
#   sh runtime.sh status
#   sh runtime.sh release runtime-<n>
#   sh runtime.sh purge [-y] # sign every CLI out, delete the slot volumes and the tools volume
#
# claude_code needs your own agreement to Anthropic's Commercial Terms with Anthropic; the date you pass
# is recorded, not verified. No Docker socket is used; the script only runs `docker compose` and `docker volume`.
# Settings: FLUX_ENV_FILE (default: .env beside this script), FLUX_WAIT_TIMEOUT (seconds, default 300).
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
env_file=${FLUX_ENV_FILE:-$here/.env}
base_file=$here/compose.yaml
runtime_file=$here/compose.runtime.yaml
wait_timeout=${FLUX_WAIT_TIMEOUT:-300}

say() { printf '%s\n' "$*"; }
warn() { printf 'runtime.sh: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

compose() {
  docker compose --env-file "$env_file" -f "$base_file" -f "$runtime_file" --profile runtime "$@"
}
env_value() { # KEY from the env file, as Compose reads it (the last assignment wins)
  [ -f "$env_file" ] || return 0
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
set_env_line() { # KEY VALUE: replace the line or append it
  awk -v k="$1" -v v="$2" 'BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print } END { if (!done) print k "=" v }' "$env_file" > "$env_file.tmp"
  cat "$env_file.tmp" > "$env_file" && rm -f "$env_file.tmp"
}
random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)."
  [ -f "$env_file" ] || die "No $env_file; follow INSTALL.md first (cp env.example .env)."
  if [ ! -f "$base_file" ] || [ ! -f "$runtime_file" ]; then die "compose.yaml and compose.runtime.yaml of ONE release must be beside this script."; fi
}
project() { p=$(env_value FLUX_PROJECT); printf '%s' "${p:-flux}"; }
switch() { env_value FLUX_AGENT_RUNTIME | tr -d ' '; }
runtime_on() { [ -n "$(switch)" ]; }
slots() { compose config --services 2>/dev/null | grep -E '^runtime-[1-9][0-9]*$' | sort -t- -k2 -n | tr '\n' ' '; }
services() { printf 'runtime-manager runtime-egress runtime-install %s' "$(slots)"; }
image_op() { compose run --rm -T migrate node tooling/dist/operations.js "$@"; }

check_switch() {
  value=$(switch)
  case "$value" in
    ''|claude_code|codex|claude_code,codex|codex,claude_code) ;;
    *) die "FLUX_AGENT_RUNTIME must be empty (off), claude_code, codex or claude_code,codex; it is '$value'." ;;
  esac
  case ",$value," in
    *,claude_code,*)
      [ -n "$(env_value FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS)" ] ||
        die "FLUX_AGENT_RUNTIME includes claude_code. Running Claude Code for others needs Anthropic's Commercial Terms: agree to them with Anthropic first, then run: sh runtime.sh on $value --commercial-terms <YYYY-MM-DD> (the date you agreed). Flux records that statement; it does not verify it." ;;
  esac
}
ensure_secrets() { # missing secrets only; existing values never change
  [ -n "$(env_value FLUX_RUNTIME_MANAGER_SECRET)" ] || set_env_line FLUX_RUNTIME_MANAGER_SECRET "$(random_hex)"
  for slot in $(slots); do
    key="FLUX_RUNTIME_SECRET_${slot#runtime-}"
    [ -n "$(env_value "$key")" ] || { set_env_line "$key" "$(random_hex)"; say "Added $key for $slot to $env_file."; }
  done
}
volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$(project)" | grep -E "^$(project)_runtime-([1-9][0-9]*-data|tools)\$" || true
}
stop_runtime() { # runtime containers only; slot volumes (and so the owners' logins) stay
  # shellcheck disable=SC2046
  compose rm -sf $(services) >/dev/null 2>&1 || warn "Could not remove every agent runtime container."
}

cmd_up() {
  check_switch
  if runtime_on; then
    ensure_secrets
    # runtime-install runs first (a no-op unless claude_code is on); the slots then start.
    # shellcheck disable=SC2046
    compose up -d --wait --wait-timeout "$wait_timeout" api worker runtime-manager runtime-egress $(slots) ||
      { compose logs --no-color --tail 60 migrate api worker runtime-install runtime-manager runtime-egress >&2 || true
        die "Flux did not become healthy. See the logs above."; }
  else
    compose up -d --wait --wait-timeout "$wait_timeout" api worker ||
      { compose logs --no-color --tail 60 migrate api worker >&2 || true; die "Flux did not become healthy. See the logs above."; }
    if [ -n "$(compose ps -aq runtime-manager 2>/dev/null)" ]; then
      say "FLUX_AGENT_RUNTIME is empty: stopping the agent runtime. Slot volumes and logins are kept (sh runtime.sh purge removes them)."
      stop_runtime
    fi
  fi
}

cmd_on() {
  value=${1:-}
  [ $# -eq 0 ] || shift
  terms=
  while [ $# -gt 0 ]; do
    case "$1" in
      --commercial-terms) [ $# -ge 2 ] || die "--commercial-terms needs a date (YYYY-MM-DD)"; terms=$2; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  case "$value" in
    claude_code|codex|claude_code,codex|codex,claude_code) ;;
    *) die "usage: sh runtime.sh on codex|claude_code|claude_code,codex [--commercial-terms YYYY-MM-DD]" ;;
  esac
  if [ -n "$terms" ]; then
    printf '%s\n' "$terms" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || die "--commercial-terms must be a date, YYYY-MM-DD"
  else
    terms=$(env_value FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS)
  fi
  # Refuse before anything is written: a refused switch must leave the settings as they were.
  case ",$value," in
    *,claude_code,*)
      [ -n "$terms" ] ||
        die "claude_code needs Anthropic's Commercial Terms: agree to them with Anthropic first, then run: sh runtime.sh on $value --commercial-terms <YYYY-MM-DD> (the date you agreed). Flux records that statement; it does not verify it." ;;
  esac
  [ -z "$terms" ] || set_env_line FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS "$terms"
  set_env_line FLUX_AGENT_RUNTIME "$value"
  cmd_up
}

cmd_off() {
  set_env_line FLUX_AGENT_RUNTIME ""
  cmd_up
}

cmd_status() {
  say "FLUX_AGENT_RUNTIME: '$(switch)'$(runtime_on || printf ' (off)')"
  image_op runtime-status
  if compose ps --status running --services 2>/dev/null | grep -qx runtime-manager; then
    say "Slots as runtime-manager sees them:"
    compose exec -T runtime-manager node apps/runtime/dist/manager/cli.js slots
  else
    say "runtime-manager is not running."
  fi
}

cmd_release() {
  [ $# -eq 1 ] || die "usage: sh runtime.sh release runtime-<n>"
  case "$1" in runtime-[1-9]|runtime-[1-9][0-9]|runtime-[1-9][0-9][0-9]) ;; *) die "usage: sh runtime.sh release runtime-<n>" ;; esac
  image_op runtime-release "$1"
}

cmd_purge() {
  assume_yes=0
  for arg in "$@"; do
    case "$arg" in -y|--yes) assume_yes=1 ;; *) die "unknown option $arg (use -y)" ;; esac
  done
  if [ "$assume_yes" != 1 ]; then
    printf 'Sign out and delete EVERY agent runtime login of %s (slot volumes and the Claude Code tools volume)? [y/N] ' "$(project)"
    read -r answer || answer=''
    case "$answer" in y|Y|yes|YES) ;; *) say "Cancelled; nothing was changed."; return 1 ;; esac
  fi
  # Stop admission first, then fence it durably in the database (a retry reuses the same purge id).
  compose stop api worker >/dev/null || die "Could not stop runtime admission; cleanup was not started."
  purge_id=
  if docker volume inspect "$(project)_pgdata" >/dev/null 2>&1; then
    reply=$(image_op runtime-begin-purge) || die "Runtime cleanup admission could not be fenced. API and worker remain stopped; repair the database and retry."
    purge_id=$(printf '%s\n' "$reply" | sed -n 's/^FLUX_RUNTIME_PURGE //p')
    printf '%s\n' "$purge_id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' ||
      die "Runtime cleanup fence was not confirmed. API and worker remain stopped."
  fi
  result=unconfirmed
  if [ -n "$(volumes | grep -- '-data$' || true)" ]; then
    say "Signing out the agent runtime logins first (best effort)..."
    ensure_secrets
    # shellcheck disable=SC2046
    if ! compose up -d --no-deps runtime-manager runtime-egress $(slots) >/dev/null 2>&1; then
      warn "Could not start the agent runtime to sign out; the logins are deleted with the volumes. Owners should end those sessions in their Claude or ChatGPT account settings."
    else
      tries=0
      until compose exec -T runtime-manager node apps/runtime/dist/manager/cli.js sign-out-all; do
        tries=$((tries + 1))
        if [ "$tries" -ge 10 ]; then
          warn "Not every agent runtime login could be signed out; the files are deleted anyway. Owners should end those sessions in their Claude or ChatGPT account settings."
          break
        fi
        sleep 2
      done
      # A failed attempt may already have deleted a binding directory; a later empty retry cannot prove
      # that its vendor session ended, so only a first-try success is confirmed.
      if [ "$tries" -eq 0 ]; then result=confirmed; fi
    fi
  fi
  # shellcheck disable=SC2046
  compose rm -sf $(services) >/dev/null 2>&1 || die "Runtime containers could not all be removed; admission remains blocked. Repair and retry purge."
  for volume in $(volumes); do docker volume rm "$volume" >/dev/null || die "Could not remove $volume; is a runtime container still using it?"; done
  if [ -n "$purge_id" ]; then image_op runtime-forget "$purge_id" "$result"; fi
  say "The agent runtime of $(project) is purged. Keep FLUX_AGENT_RUNTIME= empty in $env_file (sh runtime.sh off), then sh runtime.sh up."
}

sub=${1:-}
[ $# -eq 0 ] || shift
case "$sub" in
  on|off|up|status|release|purge) need_docker ;;
  *) die "usage: sh runtime.sh on <codex|claude_code|claude_code,codex> [--commercial-terms YYYY-MM-DD] | off | up | status | release runtime-<n> | purge [-y]" ;;
esac
"cmd_$sub" "$@"
