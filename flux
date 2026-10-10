#!/bin/sh
# Flux launcher (issue #72): one command from a fresh clone to a running Flux, all in Docker.
# Needs only POSIX sh and Docker with Compose; no host Node.js or PostgreSQL.
# Run `./flux help` for the commands.
set -eu

# --- Layout. Every repository path the launcher uses is defined here, relative to this
# file, so it works from any directory. The #76 move to app/ + docker/ changes only these.
FLUX_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
COMPOSE_MAIN="$FLUX_ROOT/docker/compose.source.yaml"
COMPOSE_DEV="$FLUX_ROOT/docker/compose.dev.yaml"
# The operator's own override (for example extra agent runtime slots); used when it exists.
COMPOSE_OVERRIDE="$FLUX_ROOT/docker/compose.override.yaml"
ENV_EXAMPLE="$FLUX_ROOT/docker/.env.example"
ENV_FILE="$FLUX_ROOT/docker/.env"
DEMO_SEED="$FLUX_ROOT/scripts/flux-demo.mjs"
MIGRATIONS_DIR="$FLUX_ROOT/app/packages/db/migrations"
APP_PACKAGE="$FLUX_ROOT/app/apps/server/package.json"
# Default output of ./flux backup and ./flux export (both ignored by git); FLUX_BACKUP_DIR overrides.
BACKUP_DIR="${FLUX_BACKUP_DIR:-$FLUX_ROOT/backups}"
EXPORT_DIR="$FLUX_ROOT/exports"
# One backup at a time per project: <prefix>-<project> is a lock directory (ignored by git).
BACKUP_LOCK_PREFIX="$FLUX_ROOT/.flux-backup-lock"
# Inside the Flux image (paths relative to its working directory).
IMAGE_EXPORT_CLI=apps/server/dist/export/cli.js
IMAGE_OPERATIONS=tooling/dist/operations.js

WAIT_TIMEOUT="${FLUX_WAIT_TIMEOUT:-300}"
OWNER_LABEL=com.flux.checkout

say() { printf '%s\n' "$*"; }
warn() { printf 'flux: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)."
  docker info >/dev/null 2>&1 || die "The Docker daemon is not reachable. Start Docker and retry."
}

# Compose for the production-mode stack (`up`, `demo`) or the hot-reload stack (`dev`).
# The image tag follows the project so parallel checkouts and `clean` stay scoped.
compose_main() {
  if [ -f "$COMPOSE_OVERRIDE" ]; then
    FLUX_IMAGE_TAG="$PROJECT" docker compose --project-directory "$FLUX_ROOT/docker" \
      --env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_MAIN" -f "$COMPOSE_OVERRIDE" "$@"
  else
    FLUX_IMAGE_TAG="$PROJECT" docker compose --project-directory "$FLUX_ROOT/docker" \
      --env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_MAIN" "$@"
  fi
}
compose_dev() {
  FLUX_IMAGE_TAG="$DEV_PROJECT" FLUX_PUBLIC_ORIGIN="$(dev_origin)" \
    FLUX_SMTP_URL="${FLUX_SMTP_URL:-smtp://mailpit:1025}" FLUX_MAIL_FROM="${FLUX_MAIL_FROM:-Flux dev <flux-dev@localhost>}" \
    docker compose --project-directory "$FLUX_ROOT/docker" --env-file "$ENV_FILE" -p "$DEV_PROJECT" \
    -f "$COMPOSE_MAIN" -f "$COMPOSE_DEV" --profile dev "$@"
}

# Reads KEY from the env file without executing it. A shell export of the same name wins,
# matching Compose precedence.
env_value() {
  eval "shell_value=\${$1-}"
  if [ -n "$shell_value" ]; then printf '%s' "$shell_value"; return; fi
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
env_file_has() { [ -f "$ENV_FILE" ] && grep -q "^$1=." "$ENV_FILE"; }

# --- Compose project names. Each checkout gets its own stable default, derived from its
# absolute path and stored in the env file as FLUX_PROJECT on first use, so two clones never
# share containers, volumes or image tags. `./flux dev` uses <project>-dev, so hot-reload work
# never touches the `up` data. A shell FLUX_PROJECT overrides it and is announced.
path_hash() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$FLUX_ROOT" | sha256sum | cut -c1-8
  elif command -v shasum >/dev/null 2>&1; then printf '%s' "$FLUX_ROOT" | shasum -a 256 | cut -c1-8
  else printf '%s' "$FLUX_ROOT" | cksum | cut -d' ' -f1
  fi
}
default_project() {
  base=$(basename -- "$FLUX_ROOT" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-' | tr -d '\n' | cut -c1-24 | sed 's/^-*//; s/-*$//')
  if [ -z "$base" ] || [ "$base" = flux ]; then printf 'flux-%s' "$(path_hash)"; else printf 'flux-%s-%s' "$base" "$(path_hash)"; fi
}
# A dangling symlink is an existing configuration path too.
env_path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

# Upgrade regular pre-#76 configuration once; moving relative links changes their target.
migrate_legacy_env() {
  legacy="$FLUX_ROOT/.env"
  [ ! -L "$legacy" ] || die "Legacy .env is a symlink and was left unchanged. Put the intended private configuration in docker/.env and remove the legacy link before continuing."
  if env_path_exists "$legacy"; then
    [ -f "$legacy" ] && [ -r "$legacy" ] || die "Legacy .env is not a readable regular file; it was left unchanged. Resolve its configuration before continuing."
    ! env_path_exists "$ENV_FILE" || die "Both .env and docker/.env exist. Keep the intended configuration in docker/.env and remove the legacy .env before continuing."
    mv "$legacy" "$ENV_FILE"
    say "Moved existing .env to docker/.env; secrets and project name are unchanged."
  elif env_path_exists "$ENV_FILE"; then
    [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || die "docker/.env exists but is not a readable regular file or a symlink to one; it was left unchanged. Resolve its configuration before continuing."
  fi
  return 0
}

resolve_project() {
  stored=''
  [ ! -f "$ENV_FILE" ] || stored=$(sed -n 's/^FLUX_PROJECT=//p' "$ENV_FILE" | tail -n 1)
  own=${stored:-$(default_project)}
  if [ -n "${FLUX_PROJECT:-}" ]; then
    PROJECT=$FLUX_PROJECT
    [ "$PROJECT" = "$own" ] || warn "NOTE: FLUX_PROJECT=$PROJECT from the environment overrides this checkout's project ($own)."
  else
    PROJECT=$own
  fi
  case "$PROJECT" in
    [a-z0-9]*) ;;
    *) die "invalid Compose project name: $PROJECT" ;;
  esac
  case "$PROJECT" in *[!a-z0-9_-]*) die "invalid Compose project name: $PROJECT (use a-z, 0-9, - and _)" ;; esac
  DEV_PROJECT="${PROJECT}-dev"
}

# --- Ownership. A small marker volume records which checkout created a project. Commands
# that start, stop or delete a project refuse one that belongs to another checkout (for
# example a copied .env), or one whose data exists without a marker, unless --force-project.
marker() { printf '%s_flux-checkout' "$1"; }
project_owner() { docker volume inspect -f "{{ index .Labels \"$OWNER_LABEL\" }}" "$(marker "$1")" 2>/dev/null || true; }
project_has_resources() {
  [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$1")" ] ||
    [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$1")" ]
}
# Owner labels are written with FLUX_ROOT (pwd -P), but compare canonically anyway: a recorded
# path that reaches this checkout through a symlink (macOS /var -> /private/var) is the same
# checkout. A different checkout still resolves to a different path, and a recorded path that
# no longer exists only matches literally.
same_checkout() {
  [ -n "$1" ] || return 1
  [ "$1" = "$FLUX_ROOT" ] && return 0
  [ "$(CDPATH='' cd -- "$1" 2>/dev/null && pwd -P)" = "$FLUX_ROOT" ]
}
check_owner() {
  owner=$(project_owner "$1")
  [ -z "$owner" ] || same_checkout "$owner" || [ "${FORCE_PROJECT:-0}" = 1 ] ||
    die "Compose project $1 belongs to another checkout ($owner). Refusing to touch it. Set a different FLUX_PROJECT in ${ENV_FILE#"$FLUX_ROOT"/}, or pass --force-project if you really mean that project."
  if [ -z "$owner" ] && [ "${FORCE_PROJECT:-0}" != 1 ] && project_has_resources "$1"; then
    die "Compose project $1 has containers or volumes but no owner record, so it may belong to another checkout or a manual setup. Refusing to touch it; pass --force-project if it is yours."
  fi
  [ "${FORCE_PROJECT:-0}" != 1 ] || [ -z "$owner" ] || same_checkout "$owner" ||
    warn "WARNING: --force-project: acting on $1, which belongs to $owner."
  return 0
}
claim_project() {
  check_owner "$1"
  same_checkout "$(project_owner "$1")" && return 0
  docker volume rm "$(marker "$1")" >/dev/null 2>&1 || true
  docker volume create --label "$OWNER_LABEL=$FLUX_ROOT" --label "com.flux.project=$1" "$(marker "$1")" >/dev/null
}
release_project() { docker volume rm "$(marker "$1")" >/dev/null 2>&1 || true; }

port() { v=$(env_value FLUX_PORT); printf '%s' "${v:-8081}"; }
dev_port() { v=$(env_value FLUX_DEV_PORT); printf '%s' "${v:-5173}"; }
dev_origin() { printf 'http://127.0.0.1:%s' "$(dev_port)"; }
public_origin() { v=$(env_value FLUX_PUBLIC_ORIGIN); printf '%s' "${v:-http://127.0.0.1:$(port)}"; }

# 64 hex characters from the kernel CSPRNG: URL-safe for DATABASE_URL, no openssl needed.
random_hex() { od -An -N"${1:-32}" -tx1 /dev/urandom | tr -d ' \n'; }

# Writes KEY=value into an env file (replacing the line or appending it), via a temp file.
set_env_line() {
  file=$1 key=$2 value=$3
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print } END { if (!done) print k "=" v }' "$file" > "$file.flux-tmp"
  cat "$file.flux-tmp" > "$file" && rm -f "$file.flux-tmp"
}

# Creates the env file once, from the example, with fresh secrets. Never overwrites it.
ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    say "Using existing ${ENV_FILE#"$FLUX_ROOT"/} (never overwritten)."
    if ! env_file_has FLUX_PROJECT; then
      # Adds the missing key only, so the project name stays stable and visible.
      printf '# Added by ./flux: Compose project of this checkout.\nFLUX_PROJECT=%s\n' "$PROJECT" >> "$ENV_FILE"
    fi
    return 0
  fi
  [ -f "$ENV_EXAMPLE" ] || die "Missing $ENV_EXAMPLE"
  say "Creating ${ENV_FILE#"$FLUX_ROOT"/} with new random secrets..."
  draft="$ENV_FILE.flux-new"
  old_umask=$(umask); umask 077
  cp "$ENV_EXAMPLE" "$draft"
  umask "$old_umask"
  trap 'rm -f "$draft" "$draft.flux-tmp"' EXIT HUP INT TERM
  p="${FLUX_PORT:-8081}"
  set_env_line "$draft" FLUX_PROJECT "$PROJECT"
  set_env_line "$draft" FLUX_PORT "$p"
  set_env_line "$draft" FLUX_PUBLIC_ORIGIN "http://127.0.0.1:$p"
  set_env_line "$draft" POSTGRES_PASSWORD "$(random_hex 32)"
  set_env_line "$draft" FLUX_FIXTURE_TOKEN "$(random_hex 32)"
  set_env_line "$draft" FLUX_AUTH_SECRET "$(random_hex 32)"
  set_env_line "$draft" FLUX_DEMO_OWNER_PASSWORD "demo-$(random_hex 8)"
  set_env_line "$draft" FLUX_DEMO_PARTNER_PASSWORD "demo-$(random_hex 8)"
  # Agent runtime secrets (F-022 T3): the service secret and one secret per slot. Generated now so
  # switching FLUX_AGENT_RUNTIME on needs nothing else; unused while it is off.
  set_env_line "$draft" FLUX_RUNTIME_MANAGER_SECRET "$(random_hex 32)"
  for n in 1 2 3 4; do set_env_line "$draft" "FLUX_RUNTIME_SECRET_$n" "$(random_hex 32)"; done
  [ -z "${FLUX_MAILPIT_PORT:-}" ] || set_env_line "$draft" FLUX_MAILPIT_PORT "$FLUX_MAILPIT_PORT"
  [ -z "${FLUX_DEV_PORT:-}" ] || set_env_line "$draft" FLUX_DEV_PORT "$FLUX_DEV_PORT"

  # VAPID keys come from the pinned web-push package inside the image just built, the same
  # command operators use (docs/development/containers.md).
  # Build and generate against the draft; the real env file appears only when complete.
  final_env=$ENV_FILE
  ENV_FILE=$draft
  build_main
  keys=$(compose_main run --rm --no-deps -T migrate \
    apps/worker/node_modules/.bin/web-push generate-vapid-keys --json 2>/dev/null) || keys=''
  ENV_FILE=$final_env
  public_key=$(printf '%s' "$keys" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')
  private_key=$(printf '%s' "$keys" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')
  if [ -n "$public_key" ] && [ -n "$private_key" ]; then
    set_env_line "$draft" FLUX_VAPID_PUBLIC_KEY "$public_key"
    set_env_line "$draft" FLUX_VAPID_PRIVATE_KEY "$private_key"
    set_env_line "$draft" FLUX_VAPID_SUBJECT "mailto:admin@localhost.localdomain"
  else
    warn "VAPID key generation failed; Web Push stays unavailable until you set the three FLUX_VAPID_* values."
  fi
  mv "$draft" "$ENV_FILE"
  trap - EXIT HUP INT TERM
  BUILT=1
  say "Wrote ${ENV_FILE#"$FLUX_ROOT"/}. Keep it private; it holds the database password and signing secret."
}

build_main() {
  say "Building Flux from this checkout (the first build takes a few minutes)..."
  if [ "${FLUX_NO_CACHE:-}" = 1 ]; then compose_main build --no-cache migrate; else compose_main build migrate; fi
}

# --- Agent runtime (F-022 AIM-3, T3 #278; docs/operations/agent-runtime.md). FLUX_AGENT_RUNTIME empty,
# the default, is off: no runtime service runs. On, `up` starts the `runtime` profile. No service ever
# gets a Docker socket; the slots are a fixed pool in compose.source.yaml (more via the override).
runtime_value() { env_value FLUX_AGENT_RUNTIME | tr -d ' '; }
runtime_on() { [ -n "$(runtime_value)" ]; }
check_runtime_switch() {
  value=$(runtime_value)
  case "$value" in
    ''|claude_code|codex|claude_code,codex|codex,claude_code) ;;
    *) die "FLUX_AGENT_RUNTIME must be empty (off), claude_code, codex or claude_code,codex; it is '$value'." ;;
  esac
  case ",$value," in
    *,claude_code,*)
      [ -n "$(env_value FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS)" ] || die "FLUX_AGENT_RUNTIME includes claude_code. Running Claude Code for others needs Anthropic's Commercial Terms: agree to them with Anthropic first, then set FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=<YYYY-MM-DD> (the date you agreed) in ${ENV_FILE#"$FLUX_ROOT"/}. Flux records that statement; it does not verify it. See docs/operations/agent-runtime.md." ;;
  esac
  return 0
}
# The slot services in this project's Compose files, in number order (runtime-1 … and override slots).
runtime_slots() { compose_main --profile runtime config --services 2>/dev/null | grep -E '^runtime-[1-9][0-9]*$' | sort -t- -k2 -n | tr '\n' ' '; }
runtime_services() { printf 'runtime-manager runtime-egress runtime-install %s' "$(runtime_slots)"; }
# Adds any missing runtime secret (an older docker/.env, or a slot added by the override). Existing
# values are never changed.
ensure_runtime_secrets() {
  [ -n "$(env_value FLUX_RUNTIME_MANAGER_SECRET)" ] || set_env_line "$ENV_FILE" FLUX_RUNTIME_MANAGER_SECRET "$(random_hex 32)"
  for slot in $(runtime_slots); do
    key="FLUX_RUNTIME_SECRET_${slot#runtime-}"
    [ -n "$(env_value "$key")" ] || { set_env_line "$ENV_FILE" "$key" "$(random_hex 32)"; say "Added $key for $slot to ${ENV_FILE#"$FLUX_ROOT"/}."; }
  done
}
runtime_volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | grep -E "^${PROJECT}_runtime-([1-9][0-9]*-data|tools)\$" || true
}
# Stops and removes the runtime containers; slot volumes (and so the owners' logins) stay.
stop_runtime() {
  [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=runtime-manager")" ] || return 0
  say "FLUX_AGENT_RUNTIME is empty: stopping the agent runtime. Slot volumes and logins are kept (./flux runtime purge removes them)."
  # shellcheck disable=SC2046
  compose_main --profile runtime rm -sf $(runtime_services) >/dev/null 2>&1 || warn "Could not remove every agent runtime container."
}
# Best effort before slot volumes are deleted: each CLI signs out (the vendor ends the session where it
# can), each binding directory is deleted and each supervisor confirms an empty /data.
runtime_sign_out() {
  runtime_sign_out_result=unconfirmed
  [ -n "$(runtime_volumes | grep -- '-data$' || true)" ] || return 0
  say "Signing out the agent runtime logins first (best effort)..."
  if ! docker image inspect "flux-agent-runtime:$PROJECT" >/dev/null 2>&1 || ! docker image inspect "flux-foundation:$PROJECT" >/dev/null 2>&1; then
    warn "The runtime images are not built, so the logins cannot be signed out; they are deleted with the volumes. Owners should end those sessions in their Claude or ChatGPT account settings."
    return 0
  fi
  ensure_runtime_secrets
  # shellcheck disable=SC2046
  if ! compose_main --profile runtime up -d --no-deps runtime-manager runtime-egress $(runtime_slots) >/dev/null 2>&1; then
    warn "Could not start the agent runtime to sign out; the logins are deleted with the volumes. Owners should end those sessions in their Claude or ChatGPT account settings."
    return 0
  fi
  tries=0
  until compose_main exec -T runtime-manager node apps/runtime/dist/manager/cli.js sign-out-all; do
    tries=$((tries + 1))
    if [ "$tries" -ge 10 ]; then
      warn "Not every agent runtime login could be signed out; the files are deleted anyway. Owners should end those sessions in their Claude or ChatGPT account settings."
      return 0
    fi
    sleep 2
  done
  # A failed attempt may already have deleted a binding directory. A later empty retry
  # cannot prove that its vendor session ended, so keep that failure in owner history.
  if [ "$tries" -eq 0 ]; then runtime_sign_out_result=confirmed; fi
}

start_main() {
  check_runtime_switch
  if runtime_on; then ensure_runtime_secrets; fi
  [ "${BUILT:-0}" = 1 ] || build_main
  if runtime_on; then
    say "Building the agent runtime ($(runtime_value))..."
    compose_main --profile runtime build runtime-install runtime-1
  fi
  say "Migrating and starting..."
  # files-init gives the non-root API and worker their files volume; `up` then waits for
  # PostgreSQL, runs the one-shot migration and starts API and worker only if it succeeded.
  compose_main --profile setup run --rm files-init >/dev/null
  if runtime_on; then
    # runtime-install runs first (a no-op unless claude_code is on); the slots then start.
    # shellcheck disable=SC2046
    compose_main --profile runtime up -d --wait --wait-timeout "$WAIT_TIMEOUT" api worker runtime-manager runtime-egress $(runtime_slots) \
      || { compose_main --profile runtime logs --no-color --tail 60 migrate api worker runtime-install runtime-manager runtime-egress >&2 || true; die "Flux did not become healthy. See the logs above."; }
  else
    compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" api worker \
      || { compose_main logs --no-color --tail 60 migrate api worker >&2 || true; die "Flux did not become healthy. See the logs above."; }
    stop_runtime
  fi
}

# Development demo only. True only for an origin that is exactly scheme://host[:port] with
# scheme http or https, host localhost, [::1] or a valid 127.0.0.0/8 dotted quad, and a
# numeric port: no userinfo, path, query or fragment. Anything else looks like a deployment.
is_loopback_origin() {
  case "$1" in
    http://*) rest=${1#http://} ;;
    https://*) rest=${1#https://} ;;
    *) return 1 ;;
  esac
  case "$rest" in ''|*[/?#@\\%\ ]*) return 1 ;; esac
  case "$rest" in
    '[::1]') return 0 ;;
    '[::1]:'*) valid_port "${rest#\[::1\]:}"; return ;;
    *'['*|*']'*) return 1 ;;
  esac
  host=${rest%%:*}
  if [ "$host" != "$rest" ]; then valid_port "${rest#*:}" || return 1; fi
  [ "$host" = localhost ] && return 0
  loopback_ipv4 "$host"
}
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
loopback_ipv4() {
  case "$1" in *[!0-9.]*|.*|*.|*..*) return 1 ;; esac
  old_ifs=$IFS; IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$old_ifs
  [ $# -eq 4 ] && [ "$1" = 127 ] || return 1
  for octet in "$2" "$3" "$4"; do
    case "$octet" in 0?*) return 1 ;; esac  # no leading zeros (octal in some parsers)
    [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
  done
}

ensure_demo_passwords() {
  for key in FLUX_DEMO_OWNER_PASSWORD FLUX_DEMO_PARTNER_PASSWORD; do
    if ! env_file_has "$key"; then
      # Adds a missing key only; existing lines are left exactly as they are.
      printf '# Added by ./flux demo: password for a development demo account.\n%s=demo-%s\n' "$key" "$(random_hex 8)" >> "$ENV_FILE"
    fi
  done
}

print_logins() {
  url=$1
  say ""
  say "Flux demo is ready:  $url"
  say ""
  say "  Ada Kowalska (workspace owner)  ada@demo.flux.test    $(env_value FLUX_DEMO_OWNER_PASSWORD)"
  say "  Jonas Berg   (member)           jonas@demo.flux.test  $(env_value FLUX_DEMO_PARTNER_PASSWORD)"
  say ""
  say "Passwords are stored in ${ENV_FILE#"$FLUX_ROOT"/}. Demo data is for local development only."
}

cmd_up() {
  [ "$#" -eq 0 ] || die "up: unknown option $1 (up takes no options; use ./flux dev for hot reload)"
  need_docker
  claim_project "$PROJECT"
  ensure_env
  start_main
  say ""
  say "Flux is running:  $(public_origin)"
  say "Create an account there, or run ./flux demo for sample data and two logins."
}

cmd_demo() {
  target=main force=0
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      --dev) target=dev ;;
      *) die "demo: unknown option $arg (use --dev or --force)" ;;
    esac
  done
  need_docker
  [ -f "$ENV_FILE" ] || cmd_up
  if [ "$target" = dev ]; then check_owner "$DEV_PROJECT"; else claim_project "$PROJECT"; fi
  if [ "$target" = dev ]; then origin=$(dev_origin); else origin=$(public_origin); fi
  if ! is_loopback_origin "$origin" && [ "$force" != 1 ]; then
    die "demo refuses to seed $origin: it looks like a production deployment. Demo data and known passwords belong on a local development instance (use --force only if this really is a throwaway instance)."
  fi
  ensure_demo_passwords
  if [ "$target" = dev ]; then
    compose_dev ps --status running --services 2>/dev/null | grep -qx api || die "The dev stack is not running. Start it with ./flux dev."
    run_compose=compose_dev
  else
    compose_main ps --status running --services 2>/dev/null | grep -qx api || start_main
    run_compose=compose_main
  fi
  say "Seeding demo data through the public API..."
  $run_compose exec -T \
    -e FLUX_PUBLIC_ORIGIN="$origin" -e FLUX_DEMO_JSON="${FLUX_DEMO_JSON:-}" \
    -e FLUX_DEMO_OWNER_PASSWORD="$(env_value FLUX_DEMO_OWNER_PASSWORD)" \
    -e FLUX_DEMO_PARTNER_PASSWORD="$(env_value FLUX_DEMO_PARTNER_PASSWORD)" \
    api node --input-type=module - < "$DEMO_SEED"
  print_logins "$origin"
}

cmd_dev() {
  build=0 follow=0
  for arg in "$@"; do
    case "$arg" in
      --build) build=1 ;;
      -f|--follow) follow=1 ;;
      *) die "dev: unknown option $arg (use --build or --follow)" ;;
    esac
  done
  need_docker
  claim_project "$PROJECT"
  claim_project "$DEV_PROJECT"
  ensure_env
  # The dev image holds dependencies and tools; source is bind-mounted, so code edits need
  # no rebuild. Rebuild after dependency or Dockerfile changes with --build.
  if [ "$build" = 1 ] || ! docker image inspect "flux-dev:$DEV_PROJECT" >/dev/null 2>&1; then
    say "Building the development image (dependencies and tools)..."
    compose_dev build migrate
  fi
  say "Starting hot-reload development stack ($DEV_PROJECT)..."
  compose_dev up -d --wait --wait-timeout "$WAIT_TIMEOUT" api worker web mailpit \
    || { compose_dev logs --no-color --tail 60 migrate api worker web >&2 || true; die "The dev stack did not become healthy. See the logs above."; }
  say ""
  say "Flux dev is running:  $(dev_origin)   (Vite hot reload; /api proxied to tsx watch)"
  say "Mail catcher:         http://127.0.0.1:$(env_value FLUX_MAILPIT_PORT | sed 's/^$/8025/')"
  say "Logs: ./flux logs --dev [service]   Demo data: ./flux demo --dev   Stop: ./flux down"
  if [ "$follow" = 1 ]; then compose_dev logs -f api worker web; fi
}

cmd_down() {
  [ "$#" -eq 0 ] || die "down: unknown option $1 (down takes no options and stops both stacks)"
  need_docker
  [ -f "$ENV_FILE" ] || { say "No ${ENV_FILE#"$FLUX_ROOT"/}; nothing to stop."; return 0; }
  check_owner "$PROJECT"
  check_owner "$DEV_PROJECT"
  compose_main --profile dev --profile runtime down --remove-orphans
  compose_dev down --remove-orphans
  say "Stopped $PROJECT and $DEV_PROJECT. Data volumes are kept (./flux reset removes them)."
}

cmd_logs() {
  need_docker
  if [ "${1:-}" = --dev ]; then shift; compose_dev logs -f --tail 100 "$@"; else compose_main logs -f --tail 100 "$@"; fi
}

confirm() {
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer || answer=''
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

parse_yes() {
  ASSUME_YES=0
  for arg in "$@"; do
    case "$arg" in
      -y|--yes) ASSUME_YES=1 ;;
      *) die "unknown option $arg (use -y)" ;;
    esac
  done
}

cmd_reset() {
  parse_yes "$@"
  need_docker
  [ -f "$ENV_FILE" ] || { say "No ${ENV_FILE#"$FLUX_ROOT"/}; nothing to reset."; return 0; }
  check_owner "$PROJECT"
  check_owner "$DEV_PROJECT"
  confirm "Delete ALL data (database, files, agent runtime logins) of Compose projects $PROJECT and $DEV_PROJECT?" \
    || { say "Cancelled; nothing was deleted."; return 1; }
  runtime_sign_out
  compose_main --profile dev --profile test --profile ui --profile runtime down -v --remove-orphans
  compose_dev down -v --remove-orphans
  release_project "$PROJECT"
  release_project "$DEV_PROJECT"
  say "Removed the containers and volumes of $PROJECT and $DEV_PROJECT. ${ENV_FILE#"$FLUX_ROOT"/} is kept; ./flux up starts empty."
}

# Images this checkout built: flux-* repositories tagged with one of its project names.
remove_own_images() {
  removed=0
  for image in $( { compose_main --profile test --profile ui --profile runtime config --images; compose_dev config --images; } 2>/dev/null | sort -u); do
    case "$image" in
      flux-*:"$PROJECT"|flux-*:"$DEV_PROJECT") ;;
      *) continue ;;
    esac
    if docker image inspect "$image" >/dev/null 2>&1 && docker image rm -f "$image" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done
  say "Removed $removed image(s) tagged :$PROJECT or :$DEV_PROJECT."
}

cmd_clean() {
  parse_yes "$@"
  need_docker
  [ -f "$ENV_FILE" ] || die "No ${ENV_FILE#"$FLUX_ROOT"/}; there is no project to clean."
  check_owner "$PROJECT"
  check_owner "$DEV_PROJECT"
  confirm "Remove the containers, volumes (ALL data, agent runtime logins included) and built images of $PROJECT and $DEV_PROJECT?" \
    || { say "Cancelled; nothing was removed."; return 1; }
  runtime_sign_out
  compose_main --profile dev --profile test --profile ui --profile runtime down -v --remove-orphans
  compose_dev down -v --remove-orphans
  remove_own_images
  release_project "$PROJECT"
  release_project "$DEV_PROJECT"
  # The BuildKit cache is shared by every checkout and project on this Docker host and cannot
  # be attributed to one project, so clean never prunes it; it only prints how.
  say "Base images, other projects and the shared build cache were not touched."
  say "The build cache is shared by all projects on this machine; to reclaim it yourself:"
  say "  docker system df"
  say "  docker builder prune --filter until=72h"
}

# --- Operations (issue #123): backup, restore, project export and upgrade. Everything runs in
# Docker: pg_dump/pg_restore in the pinned PostgreSQL container, the files volume through the
# `files-archive` helper (the same image, no network), and the export through the API image.
# Documented in docs/operations/.

pg_user() { v=$(env_value POSTGRES_USER); printf '%s' "${v:-flux}"; }
pg_db() { v=$(env_value POSTGRES_DB); printf '%s' "${v:-flux}"; }
db_query() { compose_main exec -T db psql -X -v ON_ERROR_STOP=1 -U "$(pg_user)" -d "$(pg_db)" -tAc "$1"; }
running_services() { compose_main ps --status running --services 2>/dev/null || true; }
is_running() { running_services | grep -qx "$1"; }
# The running writers (api, worker) separated by spaces, or failure when Compose cannot say:
# an unanswered question is never read as "nothing is running".
running_writers() {
  listed=$(compose_main ps --status running --services 2>/dev/null) || return 1
  printf '%s\n' "$listed" | grep -xE 'api|worker' | paste -sd' ' - || true
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else compose_main --profile ops run --rm --no-deps -T files-archive sha256sum < "$1" | cut -d' ' -f1
  fi
}
file_bytes() { wc -c < "$1" | tr -d ' '; }

# Highest numbered migration of this checkout: the schema its code expects.
code_schema() {
  ls "$MIGRATIONS_DIR" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)_[a-z0-9_]*\.sql$/\1/p' | sort | tail -n 1 | sed 's/^0*//'
}
app_version() { sed -n 's/^.*"version" *: *"\([^"]*\)".*$/\1/p' "$APP_PACKAGE" | head -n 1; }
# The commit of this checkout, or "unknown" outside a git work tree of its own (e.g. a copy).
git_commit() {
  top=$(git -C "$FLUX_ROOT" rev-parse --show-toplevel 2>/dev/null) || { printf unknown; return 0; }
  [ "$(CDPATH='' cd -- "$top" && pwd -P)" = "$FLUX_ROOT" ] || { printf unknown; return 0; }
  git -C "$FLUX_ROOT" rev-parse HEAD 2>/dev/null || printf unknown
}
image_ref() { printf 'flux-foundation:%s' "$PROJECT"; }
# The commit label of the built image (what is running), else this checkout's commit.
image_commit() {
  label=$(docker image inspect -f '{{ index .Config.Labels "com.flux.commit" }}' "$(image_ref)" 2>/dev/null || true)
  case "$label" in ''|'<no value>'|unknown) git_commit ;; *) printf '%s' "$label" ;; esac
}

api_health() {
  compose_main exec -T api node -e "fetch('http://127.0.0.1:8080/api/v1/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
}
# Health plus the schema the database reports; both must match this checkout.
verify_running() {
  health=$(api_health) || { warn "API health check failed: $health"; return 1; }
  expected=$(code_schema)
  printf '%s' "$health" | grep -q "\"schemaVersion\":${expected}[,}]" || { warn "API reports $health, expected schema $expected"; return 1; }
  ledger=$(image_op migration-ledger | sed -n 's/^FLUX_MIGRATIONS //p') || return 1
  files=$(image_op migration-files | sed -n 's/^FLUX_MIGRATIONS //p') || return 1
  [ -n "$files" ] && [ "$ledger" = "$files" ] || { warn "database migration ledger {$ledger} is not exactly this image's migrations {$files}"; return 1; }
  say "Health: $health (migration ledger matches this image: $ledger)"
}

# Runs app/tooling/operations.ts in this project's image (the migrate service).
image_op() { compose_main run --rm -T migrate node "$IMAGE_OPERATIONS" "$@"; }
image_op_nodb() { compose_main run --rm --no-deps -T migrate node "$IMAGE_OPERATIONS" "$@"; }
# The migration ledger stored in a pg_dump custom archive (read from the dump, not the manifest).
dump_ledger() {
  compose_main --profile ops run --rm --no-deps -T files-archive pg_restore --data-only --table=flux_schema_version -f - < "$1" |
    awk '/^COPY .*flux_schema_version/ { copy = 1; next } copy && /^\\\.$/ { copy = 0 } copy { print $1 }' | sort -n | paste -sd, -
}
manifest_ledger() { sed -n 's/^  "appliedMigrations": \[\([0-9,]*\)\],$/\1/p' "$1" | head -n 1; }

# Reads "key": value from a manifest written by write_manifest (one key per line).
manifest_value() { sed -n "s/^  \"$2\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$1" | head -n 1; }
manifest_part() { sed -n "s/^    {\"name\": \"$2\", \"bytes\": \([0-9]*\), \"sha256\": \"\([0-9a-f]*\)\"}.*\$/\1 \2/p" "$1" | head -n 1; }

# Restarts what a backup stopped; used by its trap so a failed backup never leaves Flux down.
backup_cleanup() {
  [ -z "${BACKUP_STAGING:-}" ] || rm -rf "${BACKUP_STAGING:?}"
  [ -z "${BACKUP_LOCK:-}" ] || rmdir "${BACKUP_LOCK:?}" 2>/dev/null || true
  if [ -n "${BACKUP_RESTART:-}" ]; then
    # shellcheck disable=SC2086
    compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" $BACKUP_RESTART >/dev/null 2>&1 || true
  fi
}

# backup_to DIR [keep-stopped]: writes DIR/flux-backup-<project>-<UTC>.tar and sets BACKUP_ARCHIVE.
# API and worker are stopped while the database is dumped and the files volume is archived, so
# both show one point in time; they are restarted afterwards unless keep-stopped is given.
backup_to() {
  mkdir -p "$1"
  out=$(CDPATH='' cd -- "$1" && pwd -P)
  BACKUP_LOCK="$BACKUP_LOCK_PREFIX-$PROJECT"
  mkdir "$BACKUP_LOCK" 2>/dev/null \
    || die "Another backup or upgrade of $PROJECT is running (lock ${BACKUP_LOCK#"$FLUX_ROOT"/}). If none is, remove that directory and retry."
  BACKUP_STAGING='' BACKUP_RESTART=''
  trap 'status=$?; backup_cleanup; exit $status' EXIT HUP INT TERM
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  # A random suffix keeps two backups of the same second apart; nothing is ever overwritten.
  name="flux-backup-$PROJECT-$stamp-$(random_hex 4)"
  [ ! -e "$out/$name.tar" ] || die "$out/$name.tar already exists; nothing was written."
  BACKUP_STAGING="$out/.$name.partial"
  old_umask=$(umask); umask 077; mkdir "$BACKUP_STAGING" || die "Could not create $BACKUP_STAGING."; umask "$old_umask"
  # One answered question about what runs, before anything is stopped: an unanswered one is
  # never read as "nothing runs", or the writers would stay down after the backup.
  listed=$(compose_main ps --status running --services 2>/dev/null) \
    || die "Could not check which Flux services are running (docker compose ps failed). Nothing was stopped or written."
  writers=''
  for service in api worker; do if printf '%s\n' "$listed" | grep -qx "$service"; then writers="$writers $service"; fi; done
  db_was_running=0; if printf '%s\n' "$listed" | grep -qx db; then db_was_running=1; fi
  if [ -n "$writers" ]; then say "Stopping$writers so the database and files are captured at one point in time..."; fi
  stop_ok=1
  stop_error=$(compose_main stop api worker 2>&1 >/dev/null) || stop_ok=0
  still='' inspected=1
  still=$(running_writers) || inspected=0
  # Restart exactly what was running before and is stopped now; never start anything else. When
  # the state after the stop is unknown, bring back what was running before (starting a running
  # service is a no-op).
  if [ "$inspected" = 1 ]; then
    for service in $writers; do case " $still " in *" $service "*) ;; *) BACKUP_RESTART="$BACKUP_RESTART $service" ;; esac; done
  else
    BACKUP_RESTART=$writers
    die "Could not check whether API and worker stopped (docker compose ps failed). No backup was written; restarting what was running before."
  fi
  if [ "$stop_ok" != 1 ] || [ -n "$still" ]; then
    die "Could not confirm that API and worker are stopped (still running: ${still:-none}; stop $( [ "$stop_ok" = 1 ] && echo succeeded || echo failed)). No backup was written.${stop_error:+ ($(printf '%s' "$stop_error" | tail -n 1))}"
  fi
  compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" db >/dev/null 2>&1 || die "The database of $PROJECT did not start."
  schema=$(db_query 'SELECT max(version) FROM flux_schema_version') || die "Could not read the schema version of $PROJECT."
  applied=$(db_query "SELECT coalesce(string_agg(version::text, ',' ORDER BY version), '') FROM flux_schema_version") \
    || die "Could not read the migration ledger of $PROJECT."
  pg_version=$(compose_main exec -T db pg_dump --version | sed 's/^pg_dump (PostgreSQL) //')
  # The identity provider's offline refresh tokens (auth_idp_standing, F-024 S4) stay out of every backup: a restored
  # instance has none, so each person who signs in through the provider signs in again.
  say "Dumping the database (schema $schema, PostgreSQL $pg_version)..."
  compose_main exec -T db pg_dump -U "$(pg_user)" -d "$(pg_db)" --format=custom --compress=6 \
    --exclude-table-data=auth_idp_standing > "$BACKUP_STAGING/database.dump" \
    || die "pg_dump failed; no backup was written."
  say "Archiving the files volume..."
  compose_main --profile ops run --rm --no-deps -T files-archive tar -C /data/files -czf - . > "$BACKUP_STAGING/files.tar.gz" \
    || die "Archiving the files volume failed; no backup was written."
  cp "$ENV_FILE" "$BACKUP_STAGING/flux.env"
  if [ -n "$writers" ] && [ "${2:-}" != keep-stopped ]; then
    say "Restarting$writers..."
    # shellcheck disable=SC2086
    compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" $writers >/dev/null || die "Flux did not become healthy after the backup."
  elif [ -z "$writers" ] && [ "$db_was_running" = 0 ]; then
    compose_main stop db >/dev/null 2>&1 || true
  fi
  BACKUP_RESTART=''
  write_manifest "$BACKUP_STAGING" "$stamp" "$schema" "$pg_version" "$applied" > "$BACKUP_STAGING/manifest.json"
  (cd "$BACKUP_STAGING" && tar -cf archive.tar manifest.json database.dump files.tar.gz flux.env)
  chmod 600 "$BACKUP_STAGING/archive.tar"
  # ln refuses an existing name, so an archive is never replaced.
  ln "$BACKUP_STAGING/archive.tar" "$out/$name.tar" || die "$out/$name.tar already exists; nothing was written."
  printf '%s  %s\n' "$(sha256_of "$out/$name.tar")" "$name.tar" > "$out/$name.tar.sha256"
  rm -rf "${BACKUP_STAGING:?}"
  BACKUP_STAGING=''
  rmdir "$BACKUP_LOCK" 2>/dev/null || true
  BACKUP_LOCK=''
  trap - EXIT HUP INT TERM
  BACKUP_ARCHIVE="$out/$name.tar"
  say "Backup written: $BACKUP_ARCHIVE ($(file_bytes "$BACKUP_ARCHIVE") bytes, schema $schema)"
  say "It holds all data and the secrets of ${ENV_FILE#"$FLUX_ROOT"/}: keep it private and copy it off this machine."
}

write_manifest() {
  dir=$1
  image_id=$(docker image inspect -f '{{.Id}}' "$(image_ref)" 2>/dev/null || printf unknown)
  dirty=false
  if [ "$(git_commit)" != unknown ] && ! git -C "$FLUX_ROOT" diff --quiet HEAD 2>/dev/null; then dirty=true; fi
  pg_image=$(compose_main config --images 2>/dev/null | grep '^postgres@' | head -n 1)
  cat <<EOF
{
  "format": "flux-backup",
  "formatVersion": 1,
  "createdAt": "$(printf '%s' "$2" | sed 's/^\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z$/\1-\2-\3T\4:\5:\6Z/')",
  "project": "$PROJECT",
  "schemaVersion": $3,
  "appliedMigrations": [$5],
  "appVersion": "$(app_version)",
  "appCommit": "$(image_commit)",
  "checkoutDirty": $dirty,
  "image": "$image_id",
  "postgresImage": "$pg_image",
  "postgresVersion": "$4",
  "consistency": "api and worker stopped during dump and files archive",
  "parts": [
    {"name": "database.dump", "bytes": $(file_bytes "$dir/database.dump"), "sha256": "$(sha256_of "$dir/database.dump")"},
    {"name": "files.tar.gz", "bytes": $(file_bytes "$dir/files.tar.gz"), "sha256": "$(sha256_of "$dir/files.tar.gz")"},
    {"name": "flux.env", "bytes": $(file_bytes "$dir/flux.env"), "sha256": "$(sha256_of "$dir/flux.env")"}
  ]
}
EOF
}

# Keeps the newest N archives of this project in DIR (by modification time; archives are
# never modified after they are written).
prune_backups() {
  dir=$1 keep=$2
  pattern="^flux-backup-$PROJECT-[0-9]\{8\}T[0-9]\{6\}Z-[0-9a-f]*\.tar\$"
  # shellcheck disable=SC2012
  ls -t "$dir" 2>/dev/null | grep "$pattern" | tail -n +$((keep + 1)) | while read -r old; do
    rm -f "${dir:?}/${old:?}" "${dir:?}/${old:?}.sha256"
    say "Removed old backup $dir/$old"
  done
}

positive_int() { case "$1" in ''|*[!0-9]*|0) return 1 ;; esac; }

cmd_backup() {
  out_dir=$BACKUP_DIR keep=''
  while [ $# -gt 0 ]; do
    case "$1" in
      -o|--output) [ $# -ge 2 ] || die "backup: $1 needs a directory"; out_dir=$2; shift 2 ;;
      --keep) { [ $# -ge 2 ] && positive_int "$2"; } || die "backup: --keep needs a positive number"; keep=$2; shift 2 ;;
      *) die "backup: unknown option $1 (use --output DIR, --keep N)" ;;
    esac
  done
  need_docker
  [ -f "$ENV_FILE" ] || die "No ${ENV_FILE#"$FLUX_ROOT"/}; there is nothing to back up."
  check_owner "$PROJECT"
  docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1 || die "Compose project $PROJECT has no database volume; there is nothing to back up."
  backup_to "$out_dir"
  [ -z "$keep" ] || prune_backups "$(dirname -- "$BACKUP_ARCHIVE")" "$keep"
}

# Unpacks and checks an archive into $RESTORE_DIR: format, part sizes and SHA-256 checksums.
open_archive() {
  [ -f "$1" ] || die "restore: no such archive: $1"
  RESTORE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/flux-restore.XXXXXX")
  trap 'rm -rf "${RESTORE_DIR:?}"' EXIT HUP INT TERM
  tar -xf "$1" -C "$RESTORE_DIR" manifest.json database.dump files.tar.gz flux.env 2>/dev/null \
    || die "restore: $1 is not a Flux backup (expected manifest.json, database.dump, files.tar.gz and flux.env)."
  manifest="$RESTORE_DIR/manifest.json"
  { [ "$(manifest_value "$manifest" format)" = flux-backup ] && [ "$(manifest_value "$manifest" formatVersion)" = 1 ]; } \
    || die "restore: $1 has an unknown manifest format."
  for part in database.dump files.tar.gz flux.env; do
    expected=$(manifest_part "$manifest" "$part")
    [ -n "$expected" ] || die "restore: the manifest does not list $part."
    actual="$(file_bytes "$RESTORE_DIR/$part") $(sha256_of "$RESTORE_DIR/$part")"
    [ "$actual" = "$expected" ] || die "restore: $part does not match its checksum in the manifest; the archive is damaged or was changed. Nothing was restored."
  done
  case "$(manifest_value "$manifest" schemaVersion)" in ''|*[!0-9]*) die "restore: the manifest has no valid schemaVersion." ;; esac
  grep -q '^  "appliedMigrations": \[' "$manifest" || die "restore: the manifest has no appliedMigrations; it was written by an older ./flux. Nothing was restored."
}

# Writes a missing .env from the archive's copy, as this checkout's project. FLUX_PORT,
# FLUX_PUBLIC_ORIGIN, FLUX_DEV_PORT and FLUX_MAILPIT_PORT from the shell replace the archived ones.
env_from_archive() {
  draft="$ENV_FILE.flux-new"
  old_umask=$(umask); umask 077; cp "$1" "$draft"; umask "$old_umask"
  set_env_line "$draft" FLUX_PROJECT "$PROJECT"
  for key in FLUX_PORT FLUX_PUBLIC_ORIGIN FLUX_DEV_PORT FLUX_MAILPIT_PORT; do
    eval "value=\${$key-}"
    [ -z "$value" ] || set_env_line "$draft" "$key" "$value"
  done
  mv "$draft" "$ENV_FILE"
  say "Wrote ${ENV_FILE#"$FLUX_ROOT"/} from the backup (same secrets, so sessions and push subscriptions stay valid)."
}

archived_env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

cmd_restore() {
  archive='' migrate=0 revoke_agents=0 ASSUME_YES=0
  for arg in "$@"; do
    case "$arg" in
      --migrate) migrate=1 ;;
      --revoke-agent-connections) revoke_agents=1 ;;
      -y|--yes) ASSUME_YES=1 ;;
      -*) die "restore: unknown option $arg (use --migrate, --revoke-agent-connections, -y)" ;;
      *) [ -z "$archive" ] || die "restore: only one archive"; archive=$arg ;;
    esac
  done
  [ -n "$archive" ] || die "usage: ./flux restore <archive.tar> [--migrate] [--revoke-agent-connections] [-y]"
  need_docker
  open_archive "$archive"
  manifest="$RESTORE_DIR/manifest.json"
  from_schema=$(manifest_value "$manifest" schemaVersion)
  from_version=$(manifest_value "$manifest" appVersion)
  from_commit=$(manifest_value "$manifest" appCommit)
  to_schema=$(code_schema) to_version=$(app_version) to_commit=$(git_commit)
  say "Backup of $(manifest_value "$manifest" project) taken $(manifest_value "$manifest" createdAt): schema $from_schema, Flux $from_version ($from_commit)."
  say "This checkout: schema $to_schema, Flux $to_version ($to_commit)."
  if [ "$from_schema" -gt "$to_schema" ]; then
    die "restore: the backup has schema $from_schema, newer than this checkout's $to_schema. Check out the Flux version that wrote it (commit $from_commit) and restore there."
  fi
  mismatch=''
  [ "$from_version" = "$to_version" ] || mismatch="${mismatch:+$mismatch, }version $from_version -> $to_version"
  if [ "$from_commit" != unknown ] && [ "$to_commit" != unknown ] && [ "$from_commit" != "$to_commit" ]; then
    mismatch="${mismatch:+$mismatch, }commit $from_commit -> $to_commit"
  fi
  if [ -n "$mismatch" ] && [ "$migrate" != 1 ]; then
    die "restore: the backup was written by another Flux version ($mismatch). Restore it with the matching checkout, or pass --migrate to restore here and migrate it forward."
  fi
  check_owner "$PROJECT"
  had_data=0; if project_has_resources "$PROJECT"; then had_data=1; fi
  claim_project "$PROJECT"
  if [ -f "$ENV_FILE" ]; then
    say "Keeping the existing ${ENV_FILE#"$FLUX_ROOT"/}."
    if [ "$(archived_env_value "$RESTORE_DIR/flux.env" FLUX_AUTH_SECRET)" != "$(env_value FLUX_AUTH_SECRET)" ]; then
      warn "NOTE: FLUX_AUTH_SECRET differs from the backup: everyone must sign in again. The backup's .env is in the archive (flux.env)."
    fi
    if [ "$(archived_env_value "$RESTORE_DIR/flux.env" FLUX_VAPID_PUBLIC_KEY)" != "$(env_value FLUX_VAPID_PUBLIC_KEY)" ]; then
      warn "NOTE: the VAPID keys differ from the backup: devices must turn push notifications on again."
    fi
  else
    env_from_archive "$RESTORE_DIR/flux.env"
  fi
  build_main
  # The exact migration ledger (#118) of the dump, checked against the manifest and this image
  # before anything is replaced.
  from_ledger=$(dump_ledger "$RESTORE_DIR/database.dump") || die "restore: could not read the migration ledger from the dump. Nothing was restored."
  [ "$from_ledger" = "$(manifest_ledger "$manifest")" ] \
    || die "restore: the dump's migration ledger {$from_ledger} differs from the manifest's {$(manifest_ledger "$manifest")}. Nothing was restored."
  [ "${from_ledger##*,}" = "$from_schema" ] \
    || die "restore: the manifest's schemaVersion $from_schema is not the highest version of its migration ledger {$from_ledger}. Nothing was restored."
  if [ "$migrate" = 1 ]; then gate=$(image_op_nodb migration-gate "$from_ledger" --migrate); else gate=$(image_op_nodb migration-gate "$from_ledger"); fi \
    || die "restore: refused before replacing any data: $(printf '%s' "$gate" | sed -n 's/^FLUX_MIGRATION_GATE refused //p')"
  say "Migrations: $(printf '%s' "$gate" | sed -n 's/^FLUX_MIGRATION_GATE ok //p')."
  if [ "$had_data" = 1 ]; then
    confirm "Replace ALL data (database and files) of Compose project $PROJECT with this backup? The current data is deleted." \
      || { say "Cancelled; nothing was changed."; return 1; }
  fi
  say "Replacing the data of $PROJECT..."
  compose_main --profile ops --profile setup down -v --remove-orphans >/dev/null 2>&1
  compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" db >/dev/null || die "The new database did not start."
  # pg_dump pins an empty search_path; functions written before 0022 that call others
  # unqualified (search_keys, #114) then fail while COPY fills generated columns. The dump is
  # our own, checksummed archive, so it is replayed with the public schema on the path.
  compose_main exec -T db pg_restore --no-owner --no-privileges -f - < "$RESTORE_DIR/database.dump" > "$RESTORE_DIR/database.sql" \
    || die "pg_restore could not read the dump. Nothing was restored into the new database."
  sed "s/pg_catalog\.set_config('search_path', '', false)/pg_catalog.set_config('search_path', 'public, pg_catalog', false)/g" "$RESTORE_DIR/database.sql" |
    compose_main exec -T db psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U "$(pg_user)" -d "$(pg_db)" >/dev/null \
    || die "Restoring the database failed. The archive is unchanged; fix the cause and run ./flux restore again."
  compose_main --profile ops run --rm --no-deps -T files-archive tar -C /data/files -xzf - < "$RESTORE_DIR/files.tar.gz" \
    || die "Restoring the files volume failed; run ./flux restore again."
  compose_main --profile setup run --rm files-init >/dev/null
  if [ "$from_schema" != "$to_schema" ] || [ "$migrate" = 1 ]; then say "Migrating from ledger {$from_ledger}..."; fi
  compose_main run --rm migrate || die "The migration after restore failed. See the output above; the archive is unchanged."
  # A restored GitHub token/binding cannot resurrect provider authority or queued work.
  image_op revoke-github-access || die "Revoking restored GitHub authorization failed; API and worker were not started."
  # Agent connections and OAuth tokens come back as they were at backup time: one revoked
  # after the backup is live again. --revoke-agent-connections ends all of them.
  if [ "$revoke_agents" = 1 ]; then
    image_op revoke-agent-access || die "Revoking agent connections failed; API and worker were not started."
  else
    access=$(image_op agent-access | sed -n 's/^FLUX_AGENT_ACCESS //p')
    if [ -n "$access" ] && [ "${access%% *}" != 0 ]; then
      warn "NOTE: ${access%% *} agent connection(s) are active as of the backup. A connection or token revoked after the backup was taken is active again."
      warn "      Review them on /connect-agent (GET /api/v1/agent-connections), or run ./flux restore again with --revoke-agent-connections to end them all."
    fi
  fi
  compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" api worker \
    || { compose_main logs --no-color --tail 60 api worker >&2 || true; die "Flux did not become healthy after the restore."; }
  # Slot volumes are not in the backup and were not replaced; the worker reconciles the restored
  # bindings with them at its start (F-022: Sign in again, or sign out and delete an unbound directory).
  if runtime_on; then
    # shellcheck disable=SC2046
    compose_main --profile runtime up -d runtime-manager runtime-egress $(runtime_slots) >/dev/null || warn "The agent runtime did not start after the restore; run ./flux up."
  fi
  verify_running || die "The restored instance failed its health or schema check."
  say "Restored $archive into $PROJECT: $(public_origin)"
}

cmd_export() {
  target='' as='' output=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --as) [ $# -ge 2 ] || die "export: --as needs an e-mail address"; as=$2; shift 2 ;;
      -o|--output) [ $# -ge 2 ] || die "export: $1 needs a file name"; output=$2; shift 2 ;;
      -*) die "export: unknown option $1 (use --as EMAIL, --output FILE)" ;;
      *) [ -z "$target" ] || die "export: only one project"; target=$1; shift ;;
    esac
  done
  [ -n "$target" ] || die "usage: ./flux export <project id or exact name> [--as EMAIL] [--output FILE]"
  need_docker
  [ -f "$ENV_FILE" ] || die "No ${ENV_FILE#"$FLUX_ROOT"/}; start Flux with ./flux up first."
  check_owner "$PROJECT"
  is_running api || die "Flux is not running; start it with ./flux up."
  if [ -n "$output" ]; then dir=$(dirname -- "$output"); else dir=$EXPORT_DIR; fi
  mkdir -p "$dir"
  EXPORT_PARTIAL="$dir/.flux-export-$$.partial"
  EXPORT_LOG="$dir/.flux-export-$$.log"
  trap 'rm -f "${EXPORT_PARTIAL:?}" "${EXPORT_LOG:?}"' EXIT HUP INT TERM
  if [ -n "$as" ]; then set -- "$target" --as "$as"; else set -- "$target"; fi
  if ! compose_main exec -T api node "$IMAGE_EXPORT_CLI" "$@" > "$EXPORT_PARTIAL" 2> "$EXPORT_LOG"; then
    grep -v '^FLUX_EXPORT_FILE ' "$EXPORT_LOG" >&2 || true
    die "export failed; nothing was written."
  fi
  grep -v '^FLUX_EXPORT_FILE ' "$EXPORT_LOG" || true
  [ -n "$output" ] || output="$dir/$(sed -n 's/^FLUX_EXPORT_FILE //p' "$EXPORT_LOG")"
  mv "$EXPORT_PARTIAL" "$output"
  say "Export written: $output ($(file_bytes "$output") bytes, sha256 $(sha256_of "$output"))"
}

upgrade_failed() {
  warn ""
  warn "UPGRADE FAILED: $1"
  # Whatever failed, stop the writers and confirm it before recommending a restore: a restore
  # replaces the data, so anything the new version accepted since it started would be lost.
  stop_error=$(compose_main stop api worker 2>&1 >/dev/null) || true
  still='' inspected=1
  still=$(running_writers) || inspected=0
  warn "Your data from before the upgrade is in $UPGRADE_ARCHIVE (schema $UPGRADE_FROM_SCHEMA, commit $UPGRADE_FROM_COMMIT)."
  if [ "$inspected" != 1 ]; then
    warn "Could not check whether API and worker stopped (docker compose ps failed${stop_error:+; stop: $(printf '%s' "$stop_error" | tail -n 1)}). Treat them as running: they may still accept work that is NOT in that backup."
    warn "Stop them (docker compose -p $PROJECT stop api worker), confirm with docker compose -p $PROJECT ps, and check what they accepted before you restore."
  elif [ -n "$still" ]; then
    warn "Could not stop $still${stop_error:+ ($(printf '%s' "$stop_error" | tail -n 1))}. It may still accept work that is NOT in that backup."
    warn "Stop it first (docker compose -p $PROJECT stop api worker) and check what it accepted before you restore."
  elif [ -n "${UPGRADE_STARTED_AT:-}" ]; then
    warn "API and worker of the new version ran from $UPGRADE_STARTED_AT until this failure and are stopped now."
    warn "Anything people saved in that time is NOT in that backup; restoring it discards that work. Back it up first if you need it:"
    warn "  ./flux backup --output '$(dirname -- "$UPGRADE_ARCHIVE")'"
  else
    warn "API and worker stayed stopped since that backup, so nothing was written after it."
  fi
  warn "To go back:"
  warn "  cd '$FLUX_ROOT'"
  if [ "$UPGRADE_FROM_COMMIT" != unknown ]; then
    warn "  git -C '$FLUX_ROOT' checkout $UPGRADE_FROM_COMMIT"
  else
    warn "  check out the Flux version you ran before (its commit was not recorded)"
  fi
  warn "  # Pre-layout versions read root .env; move the same private configuration back first."
  warn "  if [ ! -f app/package.json ] && { [ -e docker/.env ] || [ -L docker/.env ]; }; then"
  warn "    [ ! -L docker/.env ] && [ -f docker/.env ] || { echo 'docker/.env is not a regular configuration file; preserve its target as a private root .env before restore.' >&2; exit 1; }"
  warn "    [ ! -e .env ] && [ ! -L .env ] && mv docker/.env .env || { echo 'Both env paths exist; choose the intended configuration before restore.' >&2; exit 1; }"
  warn "  fi"
  warn "  ./flux restore '$UPGRADE_ARCHIVE'"
  warn "Or fix the cause in this checkout and run ./flux restore '$UPGRADE_ARCHIVE' --migrate to retry the upgrade."
  exit 1
}

# The second half of an upgrade, after the backup (and, with --pull, in the pulled launcher).
upgrade_apply() {
  UPGRADE_ARCHIVE=$1 UPGRADE_FROM_SCHEMA=$2 UPGRADE_FROM_COMMIT=$3
  to_schema=$(code_schema)
  say "Building the new version (schema $to_schema, commit $(git_commit))..."
  build_main || upgrade_failed "the build failed"
  compose_main --profile setup run --rm files-init >/dev/null || upgrade_failed "preparing the files volume failed"
  say "Migrating from schema $UPGRADE_FROM_SCHEMA to $to_schema..."
  compose_main run --rm migrate || upgrade_failed "the migration failed"
  # From here the new version may accept work, even if a later check fails.
  UPGRADE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" api worker \
    || { compose_main logs --no-color --tail 60 api worker >&2 || true; upgrade_failed "Flux did not become healthy"; }
  verify_running || upgrade_failed "the health or schema check failed"
  say ""
  say "Upgraded $PROJECT from schema $UPGRADE_FROM_SCHEMA to $to_schema: $(public_origin)"
  say "The backup from before the upgrade stays in $UPGRADE_ARCHIVE."
}

cmd_upgrade() {
  pull=0 ASSUME_YES=0 out_dir=$BACKUP_DIR
  while [ $# -gt 0 ]; do
    case "$1" in
      --pull) pull=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -o|--output) [ $# -ge 2 ] || die "upgrade: $1 needs a directory"; out_dir=$2; shift 2 ;;
      *) die "upgrade: unknown option $1 (use --pull, --output DIR, -y)" ;;
    esac
  done
  need_docker
  [ -f "$ENV_FILE" ] || die "No ${ENV_FILE#"$FLUX_ROOT"/}; for a first installation use ./flux up."
  check_owner "$PROJECT"
  docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1 || die "Compose project $PROJECT has no data yet; use ./flux up."
  if [ "$pull" = 1 ] && [ "$(git_commit)" = unknown ]; then die "upgrade --pull needs a git checkout; update the files yourself and run ./flux upgrade."; fi
  compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" db >/dev/null || die "The database of $PROJECT did not start."
  from_schema=$(db_query 'SELECT max(version) FROM flux_schema_version') || die "Could not read the schema version of $PROJECT."
  from_commit=$(image_commit)
  if [ "$pull" = 1 ]; then plan="pull the new version with git"; else plan="build this checkout (schema $(code_schema))"; fi
  confirm "Upgrade $PROJECT (schema $from_schema): back up, $plan, migrate and restart? API and worker stay stopped from the backup until the new version runs." \
    || { say "Cancelled; nothing was changed."; return 1; }
  backup_to "$out_dir" keep-stopped
  if [ "$pull" = 1 ]; then
    UPGRADE_ARCHIVE=$BACKUP_ARCHIVE UPGRADE_FROM_SCHEMA=$from_schema UPGRADE_FROM_COMMIT=$from_commit
    say "Pulling the new version..."
    git -C "$FLUX_ROOT" pull --ff-only || upgrade_failed "git pull --ff-only failed"
    # The pull may have replaced this script: continue in the new launcher.
    if [ "$FORCE_PROJECT" = 1 ]; then exec "$FLUX_ROOT/flux" --force-project _upgrade-apply "$BACKUP_ARCHIVE" "$from_schema" "$from_commit"; fi
    exec "$FLUX_ROOT/flux" _upgrade-apply "$BACKUP_ARCHIVE" "$from_schema" "$from_commit"
  fi
  upgrade_apply "$BACKUP_ARCHIVE" "$from_schema" "$from_commit"
}

# ./flux runtime status | release runtime-<n> | purge [-y]  (F-022 T3; docs/operations/agent-runtime.md)
cmd_identity() {
  sub=${1:-}
  [ $# -gt 0 ] && shift
  [ "$sub" = link ] || die "usage: ./flux identity link <userId> --subject <sub> --reason \"<why>\" [--allow-sso]"
  need_docker
  [ -f "$ENV_FILE" ] || die "No ${ENV_FILE#"$FLUX_ROOT"/}; start Flux with ./flux up first."
  check_owner "$PROJECT"
  # Operator re-key (#315): refused in SSO-only mode unless --allow-sso is given; every run is audited.
  compose_main exec -T api node apps/server/dist/identity/cli.js link "$@"
}

cmd_runtime() {
  sub=${1:-status}
  [ $# -gt 0 ] && shift
  need_docker
  [ -f "$ENV_FILE" ] || die "No ${ENV_FILE#"$FLUX_ROOT"/}; start Flux with ./flux up first."
  check_owner "$PROJECT"
  case "$sub" in
    status)
      [ $# -eq 0 ] || die "runtime status takes no options"
      say "FLUX_AGENT_RUNTIME: '$(runtime_value)'$(runtime_on || printf ' (off)')"
      image_op runtime-status
      if compose_main --profile runtime ps --status running --services 2>/dev/null | grep -qx runtime-manager; then
        say "Slots as runtime-manager sees them:"
        compose_main exec -T runtime-manager node apps/runtime/dist/manager/cli.js slots
      else
        say "runtime-manager is not running."
      fi ;;
    release)
      [ $# -eq 1 ] || die "usage: ./flux runtime release runtime-<n>"
      case "$1" in runtime-[1-9]|runtime-[1-9][0-9]|runtime-[1-9][0-9][0-9]) ;; *) die "usage: ./flux runtime release runtime-<n>" ;; esac
      image_op runtime-release "$1" ;;
    purge)
      parse_yes "$@"
      confirm "Sign out and delete EVERY agent runtime login of $PROJECT (slot volumes and the Claude Code tools volume)?" \
        || { say "Cancelled; nothing was changed."; return 1; }
      runtime_sign_out
      # shellcheck disable=SC2046
      compose_main --profile runtime rm -sf $(runtime_services) >/dev/null 2>&1 || true
      for volume in $(runtime_volumes); do docker volume rm "$volume" >/dev/null || die "Could not remove $volume; is a runtime container still using it?"; done
      if docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; then image_op runtime-forget "$runtime_sign_out_result"; fi
      say "The agent runtime of $PROJECT is purged. Set FLUX_AGENT_RUNTIME= (empty) in ${ENV_FILE#"$FLUX_ROOT"/} so ./flux up keeps it off." ;;
    *) die "usage: ./flux runtime status | release runtime-<n> | purge [-y]" ;;
  esac
}

cmd_help() {
  cat <<EOF
Flux launcher. Everything runs in Docker; only sh and Docker Compose are needed.

  ./flux up              Create docker/.env with new secrets if it is missing (never overwrites it),
                         build, migrate, start and print the URL.
  ./flux demo [--dev]    Seed demo data through the public API and print two logins.
                         Refuses non-loopback (production-looking) origins unless --force.
  ./flux dev [--build]   Hot-reload development in Docker: Vite for the web app, tsx watch
            [--follow]   for API and worker, PostgreSQL and Mailpit; separate data.
  ./flux down            Stop both stacks; keep data.
  ./flux logs [--dev] [service]   Follow logs (api, worker, web, db, migrate, mailpit).
  ./flux reset [-y]      Delete this checkout's data volumes after confirmation.
  ./flux clean [-y]      reset, plus remove the images this checkout built.
  ./flux backup [--output DIR] [--keep N]
                         Stop API and worker, write a timestamped archive (database dump, files
                         volume, .env, manifest with checksums) to backups/, restart them.
  ./flux restore <archive> [--migrate] [--revoke-agent-connections] [-y]
                         Check the archive, confirm, replace this project's data with it, migrate
                         and run health and schema checks. Refuses another Flux version unless
                         --migrate. --revoke-agent-connections ends every agent connection and
                         OAuth token from the backup (they need connecting again).
  ./flux export <project> [--as EMAIL] [--output FILE]
                         Write a project's JSON-plus-files bundle to exports/ (as the workspace
                         owner by default; the account needs project.manage).
  ./flux upgrade [--pull] [-y]
                         Back up, (git pull,) build this checkout, migrate and check health; on
                         failure print the restore instructions.
  ./flux runtime status | release runtime-<n> | purge [-y]
                         Agent runtime (FLUX_AGENT_RUNTIME): show slots and bindings, release one slot's
                         binding (its owner is signed out and told), or sign out and delete every login.
  ./flux help            This text.

Commands that start, stop, back up, restore or delete refuse a Compose project that belongs to another
checkout; --force-project overrides that check.

Environment: FLUX_PROJECT (Compose project; default flux-<dir>-<hash of this checkout's path>,
stored in docker/.env on first use; dev uses <project>-dev),
FLUX_PORT (8081, used when creating .env), FLUX_DEV_PORT (5173), FLUX_MAILPIT_PORT (8025),
FLUX_NO_CACHE=1 (build without the Docker cache), FLUX_BACKUP_DIR (default backups/).
Operations guide: docs/operations/README.md.
EOF
}

FORCE_PROJECT=0
for arg in "$@"; do
  shift
  if [ "$arg" = --force-project ]; then FORCE_PROJECT=1; else set -- "$@" "$arg"; fi
done
command=${1:-help}
[ $# -gt 0 ] && shift
case "$command" in
  _is-loopback-origin) is_loopback_origin "${1:-}"; exit ;;  # used by scripts/check_flux_cli.sh
  help|-h|--help) ;;
  *) migrate_legacy_env
     resolve_project
     # Recorded as an image label and in backup manifests (issue #123).
     FLUX_GIT_COMMIT=${FLUX_GIT_COMMIT:-$(git_commit)}; export FLUX_GIT_COMMIT ;;
esac
case "$command" in
  up) cmd_up "$@" ;;
  demo) cmd_demo "$@" ;;
  dev) cmd_dev "$@" ;;
  down|stop) cmd_down "$@" ;;
  logs) cmd_logs "$@" ;;
  reset) cmd_reset "$@" ;;
  clean) cmd_clean "$@" ;;
  backup) cmd_backup "$@" ;;
  restore) cmd_restore "$@" ;;
  export) cmd_export "$@" ;;
  upgrade) cmd_upgrade "$@" ;;
  runtime) cmd_runtime "$@" ;;
  identity) cmd_identity "$@" ;;
  _upgrade-apply) upgrade_apply "$@" ;;  # continues ./flux upgrade --pull in the pulled launcher
  help|-h|--help) cmd_help ;;
  *) warn "unknown command: $command"; cmd_help >&2; exit 2 ;;
esac
