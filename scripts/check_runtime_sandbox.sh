#!/bin/sh
# The per-run sandbox of the CLIs' own tools (#1437, RT-5) in a container with the runtime's real settings (docker/compose.source.yaml's
# runtime: root with six capabilities, read-only root, no-new-privileges, the /tmp and /scratch tmpfs, memory, CPU and pid limits), on any
# Linux engine with Landlock, also one with ptrace_scope=0: it runs the real supervisor code with the real sandbox and the TEST ONLY fake
# CLIs (scripts/agent-runtime/probe-sandbox.mjs). No network: the network side is step 9e of scripts/check_agent_runtime.sh.
set -eu

cd "$(dirname "$0")/.."
project="flux-runtime-sandbox-$$"
image="flux-agent-runtime-test:$project"
volume="$project-data"
name="$project-probe"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm -f "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker build --quiet --target agent-runtime-test -f docker/Dockerfile -t "$image" app >/dev/null
docker volume create "$volume" >/dev/null
docker run -i --name "$name" --user 0:0 --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --cap-add SETGID --cap-add SETUID \
  --read-only --security-opt no-new-privileges --init --pids-limit 2048 --memory 2560m --memory-swap 2560m --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --tmpfs /dev/shm:ro,nosuid,nodev,noexec,size=4k \
  --tmpfs /scratch:rw,nosuid,nodev,size=1g,mode=0711 --network none -v "$volume:/data" \
  --entrypoint node "$image" --input-type=module - < scripts/agent-runtime/probe-sandbox.mjs
