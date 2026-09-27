#!/bin/sh
# Flux launcher (issue #72): one command from a fresh clone to a running Flux, all in Docker.
# Needs only POSIX sh and Docker with Compose; no host Node.js or PostgreSQL.
# Run `./flux help` for the commands.
set -eu

# --- Layout. Every repository path the launcher uses is defined here, relative to this
# file, so it works from any directory. The #76 move to app/ + docker/ changes only these.
FLUX_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
COMPOSE_MAIN="$FLUX_ROOT/infra/compose.yaml"
COMPOSE_DEV="$FLUX_ROOT/infra/compose.dev.yaml"
ENV_EXAMPLE="$FLUX_ROOT/.env.example"
ENV_FILE="$FLUX_ROOT/.env"
DEMO_SEED="$FLUX_ROOT/scripts/flux-demo.mjs"

# --- Names. FLUX_PROJECT isolates containers, volumes and image tags; `./flux dev` uses
# its own project (<name>-dev) so hot-reload work never touches the `up` data.
PROJECT="${FLUX_PROJECT:-flux}"
DEV_PROJECT="${PROJECT}-dev"
WAIT_TIMEOUT="${FLUX_WAIT_TIMEOUT:-300}"

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
  FLUX_IMAGE_TAG="$PROJECT" docker compose --project-directory "$FLUX_ROOT/infra" \
    --env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_MAIN" "$@"
}
compose_dev() {
  FLUX_IMAGE_TAG="$DEV_PROJECT" FLUX_PUBLIC_ORIGIN="$(dev_origin)" \
    FLUX_SMTP_URL="${FLUX_SMTP_URL:-smtp://mailpit:1025}" FLUX_MAIL_FROM="${FLUX_MAIL_FROM:-Flux dev <flux-dev@localhost>}" \
    docker compose --project-directory "$FLUX_ROOT/infra" --env-file "$ENV_FILE" -p "$DEV_PROJECT" \
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
  set_env_line "$draft" FLUX_PORT "$p"
  set_env_line "$draft" FLUX_PUBLIC_ORIGIN "http://127.0.0.1:$p"
  set_env_line "$draft" POSTGRES_PASSWORD "$(random_hex 32)"
  set_env_line "$draft" FLUX_FIXTURE_TOKEN "$(random_hex 32)"
  set_env_line "$draft" FLUX_AUTH_SECRET "$(random_hex 32)"
  set_env_line "$draft" FLUX_DEMO_OWNER_PASSWORD "demo-$(random_hex 8)"
  set_env_line "$draft" FLUX_DEMO_PARTNER_PASSWORD "demo-$(random_hex 8)"
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

start_main() {
  [ "${BUILT:-0}" = 1 ] || build_main
  say "Migrating and starting..."
  # files-init gives the non-root API and worker their files volume; `up` then waits for
  # PostgreSQL, runs the one-shot migration and starts API and worker only if it succeeded.
  compose_main --profile setup run --rm files-init >/dev/null
  compose_main up -d --wait --wait-timeout "$WAIT_TIMEOUT" api worker \
    || { compose_main logs --no-color --tail 60 migrate api worker >&2 || true; die "Flux did not become healthy. See the logs above."; }
}

# Development demo only: a non-loopback origin looks like a real deployment.
is_loopback_origin() {
  case "$1" in
    http://127.*|http://localhost|http://localhost:*|http://\[::1\]|http://\[::1\]:*) return 0 ;;
    https://127.*|https://localhost|https://localhost:*|https://\[::1\]|https://\[::1\]:*) return 0 ;;
    *) return 1 ;;
  esac
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
  need_docker
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
  need_docker
  [ -f "$ENV_FILE" ] || { say "No ${ENV_FILE#"$FLUX_ROOT"/}; nothing to stop."; return 0; }
  compose_main --profile dev down --remove-orphans
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
  confirm "Delete ALL data (database, files) of Compose projects $PROJECT and $DEV_PROJECT?" \
    || { say "Cancelled; nothing was deleted."; return 1; }
  compose_main --profile dev --profile test --profile ui down -v --remove-orphans
  compose_dev down -v --remove-orphans
  say "Removed the containers and volumes of $PROJECT and $DEV_PROJECT. ${ENV_FILE#"$FLUX_ROOT"/} is kept; ./flux up starts empty."
}

# Images this checkout built: flux-* repositories tagged with one of its project names.
remove_own_images() {
  removed=0
  for image in $( { compose_main --profile test --profile ui config --images; compose_dev config --images; } 2>/dev/null | sort -u); do
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
  confirm "Remove the containers, volumes (ALL data) and built images of $PROJECT and $DEV_PROJECT?" \
    || { say "Cancelled; nothing was removed."; return 1; }
  compose_main --profile dev --profile test --profile ui down -v --remove-orphans
  compose_dev down -v --remove-orphans
  remove_own_images
  say "Base images, other projects and the shared build cache were not touched."
  say "To reclaim build cache as well (affects every project on this machine):"
  say "  docker system df"
  say "  docker builder prune --filter until=72h"
}

cmd_help() {
  cat <<EOF
Flux launcher. Everything runs in Docker; only sh and Docker Compose are needed.

  ./flux up              Create .env with new secrets if it is missing (never overwrites it),
                         build, migrate, start and print the URL.
  ./flux demo [--dev]    Seed demo data through the public API and print two logins.
                         Refuses non-loopback (production-looking) origins unless --force.
  ./flux dev [--build]   Hot-reload development in Docker: Vite for the web app, tsx watch
            [--follow]   for API and worker, PostgreSQL and Mailpit; separate data.
  ./flux down            Stop both stacks; keep data.
  ./flux logs [--dev] [service]   Follow logs (api, worker, web, db, migrate, mailpit).
  ./flux reset [-y]      Delete this checkout's data volumes after confirmation.
  ./flux clean [-y]      reset, plus remove the images this checkout built.
  ./flux help            This text.

Environment: FLUX_PROJECT (Compose project, default flux; dev uses <project>-dev),
FLUX_PORT (8081, used when creating .env), FLUX_DEV_PORT (5173), FLUX_MAILPIT_PORT (8025),
FLUX_NO_CACHE=1 (build without the Docker cache).
EOF
}

command=${1:-help}
[ $# -gt 0 ] && shift
case "$command" in
  up) cmd_up "$@" ;;
  demo) cmd_demo "$@" ;;
  dev) cmd_dev "$@" ;;
  down|stop) cmd_down "$@" ;;
  logs) cmd_logs "$@" ;;
  reset) cmd_reset "$@" ;;
  clean) cmd_clean "$@" ;;
  help|-h|--help) cmd_help ;;
  *) warn "unknown command: $command"; cmd_help >&2; exit 2 ;;
esac
