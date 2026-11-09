#!/bin/sh
# OPT-IN Docker check: Flux's AI release acceptance with a REAL local model instead of a vendor account (founder direction, Hubert,
# 2026-11-09: no Claude or ChatGPT key or account; simulate with the real Claude Code and the real Codex). The stack of
# scripts/check_cli_runtime.sh (the pinned CLIs in the runtime image, driven by Flux; sign-in, refresh and usage against the vendor
# mock), with one difference: providermock forwards the CLIs' model requests to a real model (app/tests/app/support/real-model.ts),
# and answers their own web searches from a Polish fixture corpus on linkmock. Flux's production brief, tools and CLI templates are
# unchanged. docker/compose.ai-real-model.test.yaml lists every difference from production.
#
# Scenarios (app/tests/app/ai-real-model.check.ts), each on Claude Code (Ada) and Codex (Bogdan): summary (`/ai` summarises and makes a
# task), task (a task given to the agent: Done or handed back by "What it may do"), link (reads a page a person posted), search (Polish law,
# no link: searches and reads), injection (a page's prompt injection: C-30 and approvals), schedule (a schedule in plain words, Run now),
# ask (one agent asks another with <ask>), others (nobody else prompts an agent). Assertions are on Flux's records and plain properties of
# the answer, never its exact text. Evidence (Flux state, the model transcript, timings) per attempt goes to FLUX_AI_EVIDENCE_DIR.
#
# The model: an OpenAI-compatible Chat Completions server (tool calls, a 64k+ context).
#   FLUX_AI_MODEL_CONTAINER (default `strata`, the llama.cpp-based server on Hubert's host): a container on this host serving on
#     FLUX_AI_MODEL_PORT (8080) with its key at FLUX_AI_MODEL_KEY_FILE (/data/state/api-key) inside. The script starts it if it is
#     stopped (only with at least FLUX_AI_MODEL_MIN_AVAILABLE_GB of RAM available, default 52), attaches it to this stack's network as
#     `flux-model`, and detaches it at the end, stopping it again if it was stopped before. Its saved preset is not changed.
#   FLUX_AI_MODEL_URL (and FLUX_AI_MODEL_KEY): any other server the stack's containers can reach; no container is managed.
# Other settings: FLUX_AI_SCENARIOS, FLUX_AI_ENGINES (claude codex), FLUX_AI_ATTEMPTS (2), FLUX_AI_SEED (42), FLUX_AI_EVIDENCE_DIR,
# FLUX_TEST_PORT / FLUX_TEST_MAILPIT_PORT (18780 / 18781). Needs internet only to build the images and install the pinned Claude Code.
# Run it alone under the shared Docker lock: a local model is slow, and the run takes hours.
set -eu

cd "$(dirname "$0")/.."
project="flux-airm-$(date +%s)-$$"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
repo_root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
export FLUX_AI_EVIDENCE_DIR="${FLUX_AI_EVIDENCE_DIR:-$repo_root/.worktrees/ai-real-model-evidence/$stamp}"
mkdir -p "$FLUX_AI_EVIDENCE_DIR"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18780}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18781}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
background_secret_dir=$(mktemp -d)
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_AUTH_RATE_LIMIT=false
# The dev stack's VAPID keys must not leak into this run (docs/development/containers.md).
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_AGENT_RUNTIME=claude_code,codex
export FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-10-05
export FLUX_RUNTIME_MANAGER_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_RUNTIME_SECRET_1="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_IMAGE_TAG="$project"
export FLUX_CLI_TOOLS_VOLUME="$project-claude-tools"
export COMPOSE_FILE="docker/compose.source.yaml:docker/compose.source.runtime.yaml:docker/compose.test.yaml:docker/compose.cli-runtime.test.yaml:docker/compose.ai-real-model.test.yaml"
. scripts/test_images.sh
compose="docker compose -p $project --profile test --profile runtime"
installer="flux-agent-runtime-install:$project"
network="${project}_default"
model_container="${FLUX_AI_MODEL_CONTAINER-strata}"
model_started=""
model_attached=""
scenarios="${FLUX_AI_SCENARIOS:-summary task link search injection schedule ask others}"
engines="${FLUX_AI_ENGINES:-claude codex}"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  $compose logs --no-color api worker runtime-manager runtime-1 providermock linkmock > "$FLUX_AI_EVIDENCE_DIR/stack.log" 2>/dev/null || true
  if [ -n "$model_attached" ]; then docker network disconnect "$network" "$model_container" >/dev/null 2>&1 || true; fi
  if [ -n "$model_started" ]; then
    printf 'Stopping %s again (it was stopped before this run).\n' "$model_container" >&2
    docker stop "$model_container" >/dev/null 2>&1 || true
  fi
  if [ "${FLUX_AI_KEEP:-}" = 1 ]; then
    printf 'FLUX_AI_KEEP=1: kept project %s and volume %s.\n' "$project" "$FLUX_CLI_TOOLS_VOLUME" >&2
    exit "$status"
  fi
  $compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$FLUX_CLI_TOOLS_VOLUME" >/dev/null 2>&1 || true
  docker image rm -f "$installer" >/dev/null 2>&1 || true
  remove_project_images
  chmod 0600 "$background_secret_dir/background_key"
  unlink "$background_secret_dir/background_key"
  rmdir "$background_secret_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

check() { $compose run --rm --no-deps -T test node_modules/.bin/tsx tests/app/ai-real-model.check.ts "$@"; }
slot_cid() { $compose ps -q runtime-1; }

step "0. The model"
if [ -n "${FLUX_AI_MODEL_URL:-}" ]; then
  model_container=""
  printf 'Model server: %s (given)\n' "$FLUX_AI_MODEL_URL"
else
  [ -n "$model_container" ] || fail "set FLUX_AI_MODEL_URL or FLUX_AI_MODEL_CONTAINER"
  docker inspect "$model_container" >/dev/null 2>&1 || fail "no container $model_container (set FLUX_AI_MODEL_CONTAINER or FLUX_AI_MODEL_URL)"
  if [ "$(docker inspect -f '{{.State.Running}}' "$model_container")" != true ]; then
    available=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1048576 }' /proc/meminfo)
    [ "$available" -ge "${FLUX_AI_MODEL_MIN_AVAILABLE_GB:-52}" ] ||
      fail "only ${available} GB of RAM available; $model_container needs ${FLUX_AI_MODEL_MIN_AVAILABLE_GB:-52} (FLUX_AI_MODEL_MIN_AVAILABLE_GB)"
    docker start "$model_container" >/dev/null
    model_started=1
  fi
  printf 'Waiting for %s to serve its model (a first load can take minutes)...\n' "$model_container"
  waited=0
  until [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$model_container")" = healthy ]; do
    [ "$(docker inspect -f '{{.State.Running}}' "$model_container")" = true ] || fail "$model_container stopped while loading (docker logs $model_container)"
    waited=$((waited + 5)); [ "$waited" -lt 3600 ] || fail "$model_container is not healthy after an hour"
    sleep 5
  done
  # The server's own local key (not a vendor credential): never printed.
  FLUX_AI_MODEL_KEY=$(docker exec "$model_container" sh -c "cat '${FLUX_AI_MODEL_KEY_FILE:-/data/state/api-key}'" 2>/dev/null | tr -d '\r\n')
  export FLUX_AI_MODEL_KEY
  export FLUX_AI_MODEL_URL="http://flux-model:${FLUX_AI_MODEL_PORT:-8080}"
  printf 'Model server: container %s (%s), reached by the stack as %s\n' "$model_container" "$(docker inspect -f '{{.Config.Image}}' "$model_container")" "$FLUX_AI_MODEL_URL"
fi

step "1. Images, and the pinned Claude Code installed by Flux's own installer (signature-checked) into a fresh tools volume"
$compose build migrate test runtime-1
docker build --quiet --file docker/Dockerfile --target agent-runtime-install --tag "$installer" app >/dev/null
docker volume create "$FLUX_CLI_TOOLS_VOLUME" >/dev/null
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000 --tmpfs /tmp:rw,size=64m \
  -e FLUX_AGENT_RUNTIME=claude_code -v "$FLUX_CLI_TOOLS_VOLUME:/opt/flux-tools" "$installer"
docker run --rm --network none --read-only --user 1000:1000 --tmpfs /tmp:rw,size=64m -e HOME=/tmp -v "$FLUX_CLI_TOOLS_VOLUME:/opt/flux-tools:ro" \
  --entrypoint sh "flux-agent-runtime-cli-mock:$project" -c 'readlink /opt/flux-tools/claude/bin/claude; /opt/flux-cli-mock/codex --version' | tee "$FLUX_AI_EVIDENCE_DIR/versions.txt"
scope=$(docker run --rm --network none --entrypoint cat "flux-agent-runtime-cli-mock:$project" /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true)
if [ "$scope" != 1 ] && [ "$scope" != 2 ] && [ "$scope" != 3 ]; then
  printf 'NOTE: this host has kernel.yama.ptrace_scope=%s; the supervisor starts through the TEST ONLY entry that reads it as 1.\n' "${scope:-none}"
  export FLUX_CLI_SUPERVISOR_ENTRY=/opt/flux-cli-mock/supervisor-yama0.mjs
fi

step "2. The stack, and the model on its network"
$compose up -d db migrate
if [ -n "$model_container" ]; then
  docker network connect --alias flux-model "$network" "$model_container"
  model_attached=1
fi
$compose --profile setup run --rm files-init
$compose up -d --wait api worker mailpit providermock linkmock runtime-manager runtime-egress runtime-1
$compose logs --no-color runtime-install | grep -q 'TEST ONLY: real Claude Code wrapped for the vendor mock' || fail "runtime-install did not wrap Claude Code"
# What the model server offers: its models, and whether it speaks each wire format itself (the shim uses Chat Completions either way).
docker exec "$($compose ps -q providermock)" node -e '
const url = process.env.FLUX_CLI_REAL_MODEL_URL, key = process.env.FLUX_CLI_REAL_MODEL_KEY;
const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {}) };
const ask = async (path, body) => { const started = Date.now(); try { const r = await fetch(url + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
  const text = await r.text(); return { path, status: r.status, ms: Date.now() - started, body: text.slice(0, 400) }; } catch (e) { return { path, error: String(e) }; } };
(async () => {
  const models = await ask("/v1/models");
  const model = (() => { try { return JSON.parse(models.body).data[0].id; } catch { return "local"; } })();
  const out = [models,
    await ask("/v1/chat/completions", { model, max_tokens: 64, temperature: 0, messages: [{ role: "user", content: "Odpowiedz jednym słowem: stolica Polski?" }] }),
    await ask("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "Odpowiedz jednym słowem: stolica Polski?" }] }),
    await ask("/v1/responses", { model, max_output_tokens: 64, input: "Odpowiedz jednym słowem: stolica Polski?" })];
  console.log(JSON.stringify(out, null, 2));
})();' | tee "$FLUX_AI_EVIDENCE_DIR/model-probe.json"
check wait-ready

step "3. Ada and Bogdan, a space with Polish threads, an agent each, a place in the one runtime"
out=$(check setup); printf '%s\n' "$out"
ada_binding=$(printf '%s\n' "$out" | sed -n 's/^ADA_BINDING=//p' | tail -n 1)
[ -n "$ada_binding" ] || fail "no binding for Ada"

step "4. Sign-in: Ada's Claude Code with an API key in her CLI home; Bogdan's Codex by the ChatGPT device sign-in (mock issuer)"
cid=$(slot_cid)
who=$(docker exec "$cid" stat -c %u:%g "/data/$ada_binding")
claude_key="sk-ant-mock-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
docker exec -u "$who" "$cid" sh -c "umask 077; printf '%s' '$claude_key' > /data/$ada_binding/claude/flux-mock-api-key"
check claude-sign-in
check codex-sign-in

step "5. Scenarios ($scenarios) on ($engines)"
for scenario in $scenarios; do
  for engine in $engines; do
    printf -- '-- %s on %s\n' "$scenario" "$engine"
    check scenario "$scenario" "$engine" | tee -a "$FLUX_AI_EVIDENCE_DIR/results.log"
  done
done

step "6. Results"
check table | tee "$FLUX_AI_EVIDENCE_DIR/results.md"
printf '\nEvidence: %s\n' "$FLUX_AI_EVIDENCE_DIR"
if grep -q '| FAIL |' "$FLUX_AI_EVIDENCE_DIR/results.md"; then fail "a scenario failed (see the table; tell a Flux bug from a model's weakness in the evidence)"; fi
printf 'AI real-model acceptance passed.\n'
