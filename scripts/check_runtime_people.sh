#!/bin/sh
# One runtime, many people (#860): separate user ids in a container with the real settings, and what people cost. Runs on any
# Linux engine, also one with ptrace_scope=0, because it runs the real supervisor code and not its main. Nothing is signed in and
# no vendor is contacted: the CLIs are the TEST ONLY fakes.
set -eu

cd "$(dirname "$0")/.."
project="flux-runtime-people-$$"
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

# The settings of docker/compose.source.yaml's runtime, on a 4 GB host's memory.
docker run -i --name "$name" --user 0:0 --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --cap-add SETGID --cap-add SETUID \
  --read-only --security-opt no-new-privileges --init --pids-limit 2048 --memory 2560m --memory-swap 2560m --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --tmpfs /dev/shm:ro,nosuid,nodev,noexec,size=4k --network none -v "$volume:/data" \
  -e FLUX_PROBE_PEOPLE="${FLUX_PROBE_PEOPLE:-500}" -e FLUX_PROBE_IDLE_MS=20000 \
  --entrypoint node "$image" --input-type=module - < scripts/agent-runtime/probe-people.mjs >> "/tmp/$project.log" 2>&1 &
probe=$!

# docker stats while the people sit idle.
until grep -q 'MEASURE idle_now' "/tmp/$project.log" 2>/dev/null || ! kill -0 "$probe" 2>/dev/null; do sleep 1; done
if grep -q 'MEASURE idle_now' "/tmp/$project.log"; then
  sleep 5
  docker stats --no-stream --format 'MEASURE docker_stats_idle mem={{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' "$name" | tee -a "/tmp/$project.log"
  sleep 5
  docker stats --no-stream --format 'MEASURE docker_stats_idle mem={{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' "$name" | tee -a "/tmp/$project.log"
fi
wait "$probe" && status=0 || status=$?
cat "/tmp/$project.log"
rm -f "/tmp/$project.log"
exit "$status"
