#!/bin/sh
# Docker check of the model gateway (#1441) with the agent runtime: an API-key request sent from inside the runtime, under a person's
# kind of user id, with only a run's gateway token, goes through runtime-egress's model port to the worker, which swaps in the key and
# sends it to a mock provider; the run is charged. Then the key is looked for everywhere in the runtime and the egress: their
# environments, every process's environment and command line, their files and their logs. It must be nowhere there (it reached the
# provider: positive control), and no log line carries the token.
#
# Source stack + the runtime overlay + the TEST ONLY fake CLIs (compose.runtime.test.yaml) + a mock provider
# (compose.model-gateway.test.yaml); the worker's fixture API key (FLUX_TEST_PERSONAL_RUNS=anthropic-mock) stands for an owner's key.
# The runtime's supervisor needs Yama ptrace_scope >= 1; on a host without it the container stays up without its supervisor, which this
# check does not need. Set FLUX_GATEWAY_TEST_PORT for concurrent runs. Removes its containers, volumes and images afterwards.
set -eu

cd "$(dirname "$0")/.."
project="flux-gateway-$(date +%s)-$$"
secret() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
export POSTGRES_USER=flux POSTGRES_DB=flux POSTGRES_PASSWORD="flux-gateway-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-gateway-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_TEST_PERSONAL_RUNS=anthropic-mock
export FLUX_TEST_ANTHROPIC_URL=http://gateway-mock:8099
export FLUX_PORT="${FLUX_GATEWAY_TEST_PORT:-18093}"
export FLUX_MAILPIT_PORT=$((FLUX_PORT + 1))
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-gateway-$(secret)"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_AGENT_RUNTIME=codex
export FLUX_RUNTIME_MANAGER_SECRET="$(secret)"
export FLUX_RUNTIME_SECRET_1="$(secret)"
export FLUX_KEYRING_TOKEN="$(secret)"
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
# The fixture "key" the worker opens for the run (packages/core/src/personal-runs/test-fixture.ts): the value looked for.
KEY=flux-test-fixture-not-a-provider-key
compose="docker compose --env-file /dev/null -p $project -f docker/compose.source.yaml -f docker/compose.source.runtime.yaml -f docker/compose.runtime.test.yaml -f docker/compose.model-gateway.test.yaml"
. scripts/test_images.sh
work=$(mktemp -d)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then $compose --profile runtime --profile test logs --no-color --tail 80 worker runtime-egress runtime-1 gateway-mock || true; fi
  $compose --profile runtime --profile test down -v >/dev/null 2>&1 || true
  remove_project_images
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1; }

$compose --profile test build test
$compose up -d --build --wait db migrate api worker
$compose --profile test up -d gateway-mock
$compose --profile runtime up -d --build runtime-egress runtime-manager runtime-1
attempt=0
until $compose logs --no-color worker | grep -q '"event":"model_gateway","state":"listening"'; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || fail "the worker's model gateway did not listen"; sleep 1
done
rt=$($compose --profile runtime ps -q runtime-1)
egress=$($compose --profile runtime ps -q runtime-egress)
[ -n "$rt" ] && [ -n "$egress" ] || fail "the runtime is not running"

out=$($compose --profile test run --rm --no-deps -T test node_modules/.bin/tsx tests/app/model-gateway-runtime.check.ts arm)
run=$(value "$out" RUN); token=$(value "$out" TOKEN); model=$(value "$out" MODEL)
[ -n "$run" ] && [ -n "$token" ] || fail "no run or token: $out"

# A process in the runtime, under an unprivileged user id like a person's CLI, with the token in its own environment variable.
probe='const t = process.env.FLUX_MODEL_GATEWAY_TOKEN; const body = JSON.stringify({ model: process.argv[1], max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
const ask = (path, headers) => fetch("http://runtime-egress:8081" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
  .then(async (r) => r.status + " " + (await r.text()));
console.log("WITH=" + await ask("/anthropic/v1/messages", { "x-api-key": t }));
console.log("WITHOUT=" + await ask("/anthropic/v1/messages", {}));
console.log("FILES=" + await ask("/anthropic/v1/files", { "x-api-key": t }));'
answer=$(docker exec -u 20001:20001 -e FLUX_MODEL_GATEWAY_TOKEN="$token" "$rt" node --input-type=module -e "$probe" "$model")
printf '%s\n' "$answer"
printf '%s\n' "$answer" | grep -q '^WITH=200 .*Hello from the provider behind the gateway' || fail "the request through the gateway did not get the provider's answer"
printf '%s\n' "$answer" | grep -q '^WITHOUT=401 .*flux_token_invalid' || fail "a request without the token was not refused"
printf '%s\n' "$answer" | grep -q '^FILES=404 ' || fail "another provider path was not refused at the egress"

charged=$($compose --profile test run --rm --no-deps -T test node_modules/.bin/tsx tests/app/model-gateway-runtime.check.ts charged "$run")
printf '%s\n' "$charged"
[ "$(value "$charged" CHARGED)" -gt 0 ] || fail "the run was not charged"
[ "$(value "$charged" INPUT)" = 40 ] || fail "the reported usage was not recorded"
seen=$($compose --profile test run --rm --no-deps -T test node -e 'fetch("http://gateway-mock:8099/seen").then((r) => r.text()).then(console.log)')
printf '%s\n' "$seen" | grep -q "$KEY" || fail "positive control: the provider never received the key"

# The key, looked for in the runtime and the egress: environments, every process's environment and command line, files, logs.
scan() { # container name
  docker inspect -f '{{ json .Config.Env }} {{ json .Config.Cmd }}' "$1" > "$work/$2.inspect"
  docker exec -u 0 "$1" sh -c 'env; for p in /proc/[0-9]*; do cat "$p/environ" "$p/cmdline" 2>/dev/null; echo; done' | tr '\0' '\n' > "$work/$2.proc"
  docker exec -u 0 "$1" sh -c 'grep -rlsF "$0" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null || true' "$KEY" > "$work/$2.files"
  docker logs "$1" > "$work/$2.log" 2>&1
  if grep -lF "$KEY" "$work/$2.inspect" "$work/$2.proc" "$work/$2.log" || [ -s "$work/$2.files" ]; then
    cat "$work/$2.files"; fail "the key is visible in $2"
  fi
  if grep -lF "$token" "$work/$2.log"; then fail "the token is in $2's log"; fi
  printf '%s: no key in its environment, %s process environments and command lines, its files or its log\n' "$2" "$(grep -c . "$work/$2.proc")"
}
scan "$rt" runtime-1
scan "$egress" runtime-egress
$compose logs --no-color worker > "$work/worker.log"
grep -q '"event":"model","run":"'"$run"'".*"chargedMicros":[1-9]' "$work/worker.log" || fail "the worker did not log the request with its charge"
if grep -qF "$KEY" "$work/worker.log" || grep -qF "$token" "$work/worker.log"; then fail "the worker logged the key or the token"; fi
echo 'Model gateway check passed: the request from the runtime reached the provider with the key, was charged, and no key is visible in the runtime or the egress.'
