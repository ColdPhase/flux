#!/usr/bin/env bash
# How many Flux Compose projects fit in a Docker daemon's address pools (#744). Runs a throwaway Docker daemon
# (docker:dind, privileged, its own pools, nothing shared with the host's daemon or its projects), then creates
# Flux projects with `docker compose up --no-start api worker` until Docker refuses a network. Containers are
# created, never started; every service uses one tiny image (the network layout is what is measured).
#
#   scripts/check_address_pools.sh [compose directory] [base/prefix=size ...]
#
# The compose directory defaults to this checkout's docker/ (compose.source.yaml, and with FLUX_POOLS_RUNTIME=1
# also compose.source.runtime.yaml and the runtime profile). Each extra argument is a daemon --default-address-pool,
# for example 172.17.0.0/12=24; none means Docker's stock pools. Prints "projects: N, networks: M".
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(cd "${1:-$root/docker}" && pwd)
shift || true
dind_image=${FLUX_POOLS_DIND:-docker:29.4.1-dind}
name="flux-pools-$$"
limit=${FLUX_POOLS_LIMIT:-300}
pool_args=()
for pool in "$@"; do pool_args+=("--default-address-pool" "base=${pool%=*},size=${pool#*=}"); done
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --privileged --name "$name" -v "$dir:/compose:ro" "$dind_image" \
  dockerd --host=unix:///var/run/docker.sock ${pool_args[@]+"${pool_args[@]}"} >/dev/null
in_dind() { docker exec "$name" "$@"; }
for _ in $(seq 1 60); do in_dind docker info >/dev/null 2>&1 && break; sleep 1; done
in_dind docker info >/dev/null
# One small image for every service, under the names the Compose files use; nothing is pulled per project.
in_dind sh -c 'mkdir -p /stub && printf "FROM scratch\nCOPY x /x\n" > /stub/Dockerfile && : > /stub/x && docker build -q -t flux-stub /stub' >/dev/null
override=$(cat <<'YAML'
services:
  db: {image: flux-stub, pull_policy: never, command: [/x]}
  migrate: {image: flux-stub, pull_policy: never, command: [/x]}
  api: {image: flux-stub, pull_policy: never, command: [/x]}
  worker: {image: flux-stub, pull_policy: never, command: [/x]}
  keyring: {image: flux-stub, pull_policy: never, command: [/x]}
YAML
)
in_dind sh -c "printf '%s\n' '$override' > /stub.yaml"
files=(-f /compose/compose.source.yaml)
services=(api worker)
profile=()
if [ "${FLUX_POOLS_RUNTIME:-0}" = 1 ]; then
  files+=(-f /compose/compose.source.runtime.yaml)
  profile=(--profile runtime)
  services+=(runtime-manager runtime-egress runtime-1 runtime-2 runtime-3 runtime-4)
  in_dind sh -c "printf '%s\n' '  runtime-install: {image: flux-stub, pull_policy: never, command: [/x]}' '  runtime-manager: {image: flux-stub, pull_policy: never, command: [/x]}' \
    '  runtime-egress: {image: flux-stub, pull_policy: never, command: [/x]}' '  runtime-1: {image: flux-stub, pull_policy: never, command: [/x]}' \
    '  runtime-2: {image: flux-stub, pull_policy: never, command: [/x]}' '  runtime-3: {image: flux-stub, pull_policy: never, command: [/x]}' \
    '  runtime-4: {image: flux-stub, pull_policy: never, command: [/x]}' >> /stub.yaml"
fi
echo "daemon: $dind_image, pools: ${*:-stock}; files: ${files[*]}${profile[*]:+ ${profile[*]}}"
projects=0
error=
while [ "$projects" -lt "$limit" ]; do
  if ! out=$(in_dind env POSTGRES_PASSWORD=x FLUX_AUTH_SECRET=x FLUX_PUBLIC_ORIGIN=http://127.0.0.1 FLUX_FIXTURE_TOKEN=x FLUX_PROJECT=p \
      docker compose -p "p$projects" "${files[@]}" -f /stub.yaml ${profile[@]+"${profile[@]}"} up --no-start --pull never "${services[@]}" 2>&1); then
    error=$(printf '%s\n' "$out" | grep -m 1 -iE 'pool|subnet|overlap' || printf '%s\n' "$out" | tail -n 1)
    break
  fi
  projects=$((projects + 1))
done
networks=$(in_dind docker network ls -q --filter driver=bridge | wc -l)
echo "projects: $projects, networks: $networks (bridge networks incl. the daemon's own)"
[ -z "$error" ] || echo "stopped by: $error"
[ "$projects" -lt "$limit" ] || echo "stopped at the limit FLUX_POOLS_LIMIT=$limit"
