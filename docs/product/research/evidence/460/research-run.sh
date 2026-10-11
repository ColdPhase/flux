#!/bin/sh
# Manual research only; not CI/check_application. No vendor accounts or model spend.
set -eu
mode=${1:?baseline or prototype required}; shift
case "$mode" in baseline|prototype) ;; *) echo "Unknown research mode" >&2; exit 2 ;; esac
case "${1:-}" in '') prepare_only=0 ;; --prepare-only) prepare_only=1 ;; *) echo "Use --prepare-only or no argument" >&2; exit 2 ;; esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository=${FLUX_RESEARCH_SOURCE_DIR:?Set FLUX_RESEARCH_SOURCE_DIR to a Flux Git repository containing pinned 97574742}
output=${FLUX_RESEARCH_OUTPUT_DIR:?Set FLUX_RESEARCH_OUTPUT_DIR to a new evidence directory}
mkdir "$output"
output=$(CDPATH= cd -- "$output" && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/flux-460-research.XXXXXX")
project="flux-research-460-$mode-$(date +%s)-$$"
started=0
research_compose() {
  docker compose -p "$project" -f "$stage/source/docker/compose.source.yaml" -f "$stage/source/docker/compose.test.yaml" -f "$script_dir/$mode-compose.yaml" --profile test --profile mcp-clients "$@"
}
compose=research_compose
cleanup() {
  status=$?
  if [ "$started" = 1 ]; then
    if [ "$status" -ne 0 ]; then research_compose logs --no-color --tail 80 db migrate api worker || true; fi
    research_compose down -v || true
    remove_project_images
  fi
  rm -rf -- "$stage"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$script_dir/prepare.py" "$repository" "$stage" "$script_dir" "$mode"
export FLUX_RESEARCH_PROBE_FILE="$script_dir/$mode-probe.ts"
export FLUX_RESEARCH_EVIDENCE_DIR="$output"
export FLUX_RESEARCH_DOCKERFILE="$script_dir/prototype-Dockerfile"
export FLUX_RESEARCH_PATCH_CONTEXT="$stage/research-patch"
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-19820}" FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-19821}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
head -c 32 /dev/urandom > "$stage/background_key"
chmod 0444 "$stage/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$stage/background_key"
export FLUX_SMTP_URL="smtp://mailpit:1025" FLUX_MAIL_FROM="Flux <flux@example.test>" FLUX_AUTH_RATE_LIMIT=false
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
. "$stage/source/scripts/test_images.sh"
printf '%s\n' "$project" > "$output/project.txt"
if [ "$prepare_only" = 1 ]; then
  # Resolves paths, images and IPAM without building, starting Docker resources or dumping secret config.
  research_compose config --quiet
  research_compose config --images > "$output/images.txt"
  echo "Pinned source/patch and Compose configuration prepared; no application/runtime probe executed."
  exit 0
fi
started=1
research_compose build migrate mcp-clients
research_compose up -d db migrate
research_compose --profile setup run --rm files-init
research_compose run --rm mcp-clients
