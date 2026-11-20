#!/bin/sh
# OPT-IN Docker check: Flux's AI release acceptance with a REAL local model instead of a vendor account (founder direction, Hubert,
# 2026-11-09: no Claude or ChatGPT key or account; simulate with the real Claude Code and the real Codex). The stack of
# scripts/check_cli_runtime.sh (the pinned CLIs in the runtime image, driven by Flux; sign-in, refresh and usage against the vendor
# mock), with one difference: providermock forwards the CLIs' model requests to a real model (app/tests/app/support/real-model.ts),
# and answers their own web searches from a Polish fixture corpus on linkmock. Flux's production brief, tools and CLI templates are
# unchanged. docker/compose.ai-real-model.test.yaml lists every difference from production.
# The third engine is pi (#1441, RT-1: every API-key agent runs in pi in the runtime): Celina saves an API key in Connect AI, an
# OpenAI-compatible endpoint at a private address the operator allows (FLUX_AI_PRIVATE_TARGETS), and her agent's model requests go from
# pi through Flux's model gateway to that endpoint, providermock's pass-through to the same real model: nothing converted or set, only
# recorded. Production personal runs (FLUX_PERSONAL_RUNS=on, `pi` in FLUX_AGENT_RUNTIME), the production runtime image's pi.
#
# The fourth engine, `anthropic` (opt-in: FLUX_AI_ENGINES=anthropic): Ewa saves a REAL Anthropic API key in Connect AI and her agent runs in
# pi through Flux's model gateway to the real API. Every request the key pays for (pi's, and the API's flux_web_search) goes through the
# evaluation's recording proxy (support/eval-proxy.ts, docker/compose.ai-real-model-anthropic.test.yaml), which keeps each request body under
# the evidence directory and stops at the run's money cap. The key: FLUX_AI_ANTHROPIC_KEY_FILE (default ~/.config/flux-eval/anthropic.key,
# mode 600), piped into the one runner command that saves it (standard input: never an argument or an environment variable), sealed by Flux
# like any saved key; never printed, logged or written, and an evidence file that holds it is removed. FLUX_AI_ANTHROPIC_MODEL
# (claude-haiku-5-5), FLUX_AI_ANTHROPIC_MAX_USD (this run's cap, default 5), FLUX_AI_ANTHROPIC_LEDGER (each run's spend, default
# <repo>/.worktrees/ai-real-model-evidence/anthropic-spend.tsv). It needs no local model: with only `anthropic`, no model container is used.
# FLUX_AI_DRY_RUN=1 (with `anthropic` only): the same stack and steps with a made-up key, the proxy pointed at providermock's Anthropic mock and
# the key's listing and tool check at its /lists, so nothing reaches Anthropic; it proves the wiring (every scenario must run to its end),
# not a model's answers.
#
# Scenarios (app/tests/app/ai-real-model.check.ts), each on Claude Code (Ada), Codex (Bogdan), pi (Celina) and the Anthropic key (Ewa), with
# "Ask me first" off and on where it applies: map (#1555: adds thoughts and links to a space map people have open, Approve and Undo), mapedit
# (renames, moves and removes thoughts, renames the map, makes a task from a thought, on a map people have open; removing waits for Delete),
# tasks (makes tasks with title, owner and due day from a conversation, Undo, Approve; moves a due day on request; never changes who a task
# is for), task (a task given to the agent goes Doing to Done with a report, or back to its owner), blocked (a task it cannot finish ends
# Blocked with a reason), wiki (starts a page and saves its next version, Undo and Approve; answers from an old page and from a saved source
# as the upgrade converted it), decision (proposes one, answers in its discussion, Skip), files (a PDF's text, and a scan read by OCR:
# FLUX_FILE_OCR=on in the check stack), dm (C-73: finds a word in the owner's DM from the private chat with the "used AI here" line; with AI
# off by the other person nothing of the DM reaches the model, checked on what the provider was sent), summary (`/ai` summarises and makes a
# task), task (a task given to the agent: Done or handed back by "What it may do"), link (reads a page a person posted), search (Polish law,
# no link: searches and reads), injection (a page's prompt injection: C-30 and approvals), schedule (a schedule in plain words, Run now),
# ask (one agent asks another with <ask>), others (nobody else prompts an agent), picture (#1217: finds a photo and attaches it to its answer,
# fetched by the server), vision (#1217: says what a posted photo shows; the local model sees no pictures, so the shim's vision mock
# describes the scenario's photo in words, support/real-model.ts). On pi an OpenAI-compatible endpoint has no web search and is not known to see
# pictures (CA-6, AG-8): `search` and `vision` check that the agent says so instead of inventing results, and `picture` (which needs a search)
# is not run on pi. On the Anthropic key `search` uses the provider's real search (flux_web_search) and checks what Flux recorded and listed, `vision`
# shows a real vision model a red disc, and `picture` is not run (its check is on the closed world's pages). Assertions are on Flux's records and plain properties of
# the answer, never its exact text. Evidence (Flux state, the model transcript, timings) per attempt goes to FLUX_AI_EVIDENCE_DIR.
#
# The model: an OpenAI-compatible Chat Completions server (tool calls, a 64k+ context).
#   FLUX_AI_MODEL_CONTAINER (default `strata`, the llama.cpp-based server on Hubert's host): a container on this host serving on
#     FLUX_AI_MODEL_PORT (8080) with its key at FLUX_AI_MODEL_KEY_FILE (/data/state/api-key) inside. The script starts it if it is
#     stopped (only with at least FLUX_AI_MODEL_MIN_AVAILABLE_GB of RAM available, default 52), attaches it to this stack's network as
#     `flux-model`, and detaches it at the end, stopping it again if it was stopped before. Its saved preset is not changed.
#   FLUX_AI_MODEL_URL (and FLUX_AI_MODEL_KEY): any other server the stack's containers can reach; no container is managed.
#   On Hubert's host since 2026-11-20 also `flux-qwen` (Qwen3.8-27B on llama.cpp, vision via mmproj): FLUX_AI_MODEL_CONTAINER=flux-qwen
#   FLUX_AI_MODEL_KEY_FILE=/run/api-key. A running container is never stopped or restarted, only attached and detached.
# FLUX_AI_PI_MODEL: the model id the pi people type when the endpoint lists none Flux accepts (llama.cpp without --alias), default qwen-local.
# Other settings: FLUX_AI_SCENARIOS (space-separated, default all), FLUX_AI_ENGINES (claude codex pi; add or choose anthropic), FLUX_AI_ATTEMPTS (2), FLUX_AI_SEED (42), FLUX_AI_EVIDENCE_DIR,
# FLUX_TEST_PORT / FLUX_TEST_MAILPIT_PORT (18780 / 18781). Needs internet only to build the images and install the pinned Claude Code.
# Run it alone under the shared Docker lock: a local model is slow, and the run takes hours.
set -eu

# `--eval`: the answer-accuracy evaluation on a real Anthropic key instead (#1295): scripts/check_ai_eval.sh.
if [ "${1:-}" = --eval ]; then shift; exec "$(dirname "$0")/check_ai_eval.sh" "$@"; fi

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
# pi runs the API-key agents (#1441); production personal runs, so a key's run goes through the worker's model gateway.
export FLUX_AGENT_RUNTIME=claude_code,codex,pi
export FLUX_PERSONAL_RUNS=on FLUX_TEST_PERSONAL_RUNS=
export FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-10-05
export FLUX_RUNTIME_MANAGER_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_RUNTIME_SECRET_1="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_IMAGE_TAG="$project"
export FLUX_CLI_TOOLS_VOLUME="$project-claude-tools"
export COMPOSE_FILE="docker/compose.source.yaml:docker/compose.source.runtime.yaml:docker/compose.test.yaml:docker/compose.cli-runtime.test.yaml:docker/compose.ai-real-model.test.yaml"
. scripts/test_images.sh
compose="docker compose --env-file /dev/null -p $project --profile test --profile runtime"
installer="flux-agent-runtime-install:$project"
network="${project}_default"
model_started=""
model_attached=""
scenarios="${FLUX_AI_SCENARIOS:-map mapedit tasks task blocked wiki decision files dm summary link search injection schedule ask others picture vision}"
engines="${FLUX_AI_ENGINES:-claude codex pi}"
has_engine() { case " $engines " in *" $1 "*) return 0;; esac; return 1; }

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for engine in $engines; do case "$engine" in claude|codex|pi|anthropic) ;; *) fail "unknown engine $engine (claude codex pi anthropic)";; esac; done
# The engines that run on the local model; with none, no model server is used at all.
local_model=""
for engine in claude codex pi; do if has_engine "$engine"; then local_model=1; fi; done
model_container="${FLUX_AI_MODEL_CONTAINER-strata}"
if [ -z "$local_model" ]; then
  # providermock still names a model server; nothing asks it.
  model_container=""; export FLUX_AI_MODEL_URL="${FLUX_AI_MODEL_URL:-http://flux-model.invalid:8080}"
# A given server is used as it is; otherwise the container is reached on the stack's network as `flux-model`.
elif [ -n "${FLUX_AI_MODEL_URL:-}" ]; then model_container=""; else export FLUX_AI_MODEL_URL="http://flux-model:${FLUX_AI_MODEL_PORT:-8080}"; fi

# The Anthropic key (opt-in): its file, the proxy's cap, and its overlay; a dry run makes up a key and keeps everything on providermock.
dry_run="${FLUX_AI_DRY_RUN:-}"
key_file=""
key_leaked=""
ledger="${FLUX_AI_ANTHROPIC_LEDGER:-$repo_root/.worktrees/ai-real-model-evidence/anthropic-spend.tsv}"
if [ -n "$dry_run" ] && [ "$engines" != anthropic ]; then fail "FLUX_AI_DRY_RUN=1 runs the anthropic engine alone (FLUX_AI_ENGINES=anthropic)"; fi
if has_engine anthropic; then
  export COMPOSE_FILE="$COMPOSE_FILE:docker/compose.ai-real-model-anthropic.test.yaml"
  export FLUX_AI_ANTHROPIC_MODEL="${FLUX_AI_ANTHROPIC_MODEL:-claude-haiku-5-5}"
  if [ -n "$dry_run" ]; then
    key_file="$background_secret_dir/anthropic.key"
    (umask 077; printf 'sk-ant-dryrun-%s' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" > "$key_file")
    export FLUX_AI_ANTHROPIC_UPSTREAM=http://providermock:8095 FLUX_AI_PROVIDER_LISTS=http://providermock:8095 FLUX_AI_ANTHROPIC_CAP_USD=1
    # A model the mock lists and the proxy prices.
    export FLUX_AI_ANTHROPIC_MODEL=claude-sonnet-5-5
  else
    key_file="${FLUX_AI_ANTHROPIC_KEY_FILE:-$HOME/.config/flux-eval/anthropic.key}"
    [ -r "$key_file" ] || fail "no Anthropic key file at $key_file (FLUX_AI_ANTHROPIC_KEY_FILE)"
    [ "$(stat -c %a "$key_file")" = 600 ] || fail "$key_file must be mode 600"
    export FLUX_AI_ANTHROPIC_CAP_USD="${FLUX_AI_ANTHROPIC_MAX_USD:-5}"
  fi
  printf 'Anthropic key: model %s, this run may spend up to $%s%s.\n' "$FLUX_AI_ANTHROPIC_MODEL" "$FLUX_AI_ANTHROPIC_CAP_USD" "${dry_run:+ (DRY RUN: providermock, a made-up key)}"
fi
# No evidence file may hold the key: any that does is removed (the key itself is never printed). It is matched as it is sent (without a line
# ending); an empty key file matches everything and removes it all (fail closed).
scrub_key() {
  [ -n "$key_file" ] && [ -r "$key_file" ] || return 0
  for leaked in $(tr -d '\r\n' < "$key_file" | grep -rlF -f - "$FLUX_AI_EVIDENCE_DIR" 2>/dev/null); do
    rm -f "$leaked"; printf 'WARNING: %s held the key and was removed\n' "$leaked" >&2; key_leaked=1
  done
}

cleanup() {
  status=$?
  $compose logs --no-color api worker runtime-manager runtime-1 providermock linkmock $(has_engine anthropic && echo evalproxy) > "$FLUX_AI_EVIDENCE_DIR/stack.log" 2>/dev/null || true
  scrub_key
  if has_engine anthropic && [ -f "$FLUX_AI_EVIDENCE_DIR/proxy/proxy.jsonl" ]; then
    run_cost=$(grep -o '"costUsd":[0-9.e-]*' "$FLUX_AI_EVIDENCE_DIR/proxy/proxy.jsonl" | awk -F: '{ total += $2 } END { printf "%.6f", total }')
    if [ -z "$dry_run" ]; then
      mkdir -p "$(dirname "$ledger")"
      printf '%s\t%s\t%s\t%s\n' "$stamp" "$run_cost" "$FLUX_AI_ANTHROPIC_MODEL" "$(git rev-parse --short=9 HEAD)" >> "$ledger"
    fi
    printf 'The Anthropic key spent $%s in this run (provider usage, as the proxy priced it)%s.\n' "$run_cost" "${dry_run:+; DRY RUN: the mock's usage, nothing paid}"
  fi
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
  rm -f "$background_secret_dir/anthropic.key"
  rmdir "$background_secret_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

check() { $compose run --rm --no-deps -T test node_modules/.bin/tsx tests/app/ai-real-model.check.ts "$@"; }
# The model server's key reaches only this runner's environment, by name (`-e NAME` takes the value from the environment, never from argv).
check_with_key() { $compose run --rm --no-deps -T -e FLUX_AI_MODEL_KEY test node_modules/.bin/tsx tests/app/ai-real-model.check.ts "$@"; }
# The Anthropic key reaches only the step that saves it, on its standard input: never an argument, never an environment variable.
check_anthropic_connect() { $compose run --rm --no-deps -T test node_modules/.bin/tsx tests/app/ai-real-model.check.ts anthropic-connect < "$key_file"; }
slot_cid() { $compose ps -q runtime-1; }

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

step "2. The model (after the images, so a failed build never starts it)"
if [ -z "$local_model" ]; then
  printf 'No local model: the engines (%s) run on the Anthropic key.\n' "$engines"
elif [ -z "$model_container" ]; then
  [ "$FLUX_AI_MODEL_URL" != "http://flux-model:${FLUX_AI_MODEL_PORT:-8080}" ] || fail "set FLUX_AI_MODEL_URL or FLUX_AI_MODEL_CONTAINER"
  printf 'Model server: %s (given)\n' "$FLUX_AI_MODEL_URL"
else
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
  printf 'Model server: container %s (%s), reached by the stack as %s\n' "$model_container" "$(docker inspect -f '{{.Config.Image}}' "$model_container")" "$FLUX_AI_MODEL_URL"
fi

export FLUX_AI_MODEL_KEY="${FLUX_AI_MODEL_KEY:-}"

step "3. The stack, and the model on its network"
$compose up -d db migrate
if [ -n "$model_container" ]; then
  docker network connect --alias flux-model "$network" "$model_container"
  model_attached=1
fi
$compose --profile setup run --rm files-init
$compose up -d --wait api worker mailpit providermock linkmock runtime-manager runtime-egress runtime-1 $(has_engine anthropic && echo evalproxy)
$compose logs --no-color runtime-install | grep -q 'TEST ONLY: real Claude Code wrapped for the vendor mock' || fail "runtime-install did not wrap Claude Code"
if has_engine pi || has_engine anthropic; then
  waited=0
  until $compose logs --no-color worker | grep -q '"event":"model_gateway","state":"listening"'; do
    waited=$((waited + 1)); [ "$waited" -lt 60 ] || fail "the worker's model gateway did not listen"; sleep 1
  done
  $compose logs --no-color runtime-1 | grep -q '"event":"ready".*"pi":true' || fail "the runtime did not start ready for API keys in pi"
fi
# What the model server offers: its models, and whether it speaks each wire format itself (the shim uses Chat Completions either way).
[ -z "$local_model" ] || docker exec "$($compose ps -q providermock)" node -e '
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

step "4. Ada and Bogdan, a space with Polish threads, an agent each, a place in the one runtime"
out=$(check setup); printf '%s\n' "$out"
ada_binding=$(printf '%s\n' "$out" | sed -n 's/^ADA_BINDING=//p' | tail -n 1)
[ -n "$ada_binding" ] || fail "no binding for Ada"

step "5. Sign-in: Ada's Claude Code with an API key in her CLI home; Bogdan's Codex by the ChatGPT device sign-in (mock issuer); Celina's and Dariusz's API keys in Connect AI (pi); Ewa's and Filip's Anthropic key"
if has_engine claude; then
  cid=$(slot_cid)
  who=$(docker exec "$cid" stat -c %u:%g "/data/$ada_binding")
  claude_key="sk-ant-mock-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  docker exec -u "$who" "$cid" sh -c "umask 077; printf '%s' '$claude_key' > /data/$ada_binding/claude/flux-mock-api-key"
  check claude-sign-in
fi
if has_engine codex; then check codex-sign-in; fi
if has_engine pi; then check_with_key pi-connect; fi
if has_engine anthropic; then check_anthropic_connect; fi

step "6. Scenarios ($scenarios) on ($engines)"
for scenario in $scenarios; do
  for engine in $engines; do
    # A picture is found by a web search, which an OpenAI-compatible endpoint does not have (CA-6); on the Anthropic key it would be the real
    # web's, and the scenario's checks are on the closed world's pages.
    if [ "$scenario" = picture ] && { [ "$engine" = pi ] || [ "$engine" = anthropic ]; }; then continue; fi
    printf -- '-- %s on %s\n' "$scenario" "$engine"
    check scenario "$scenario" "$engine" | tee -a "$FLUX_AI_EVIDENCE_DIR/results.log"
  done
done

step "7. Results"
check table | tee "$FLUX_AI_EVIDENCE_DIR/results.md"
printf '\nEvidence: %s\n' "$FLUX_AI_EVIDENCE_DIR"
scrub_key
[ -z "$key_leaked" ] || fail "an evidence file held the Anthropic key and was removed"
if [ -n "$dry_run" ]; then
  # The mock answers in words and calls no tool, so outcomes fail; every scenario must still run to its end.
  if grep -q 'the scenario ran to its end' "$FLUX_AI_EVIDENCE_DIR/results.md"; then fail "DRY RUN: a scenario did not run to its end (see the table and evidence)"; fi
  printf 'DRY RUN passed: the stack, the key'"'"'s path through the proxy and every scenario'"'"'s steps ran against the provider mock (outcomes are not a model'"'"'s).\n'
  exit 0
fi
if grep -q '| FAIL |' "$FLUX_AI_EVIDENCE_DIR/results.md"; then fail "a scenario failed (see the table; tell a Flux bug from a model's weakness in the evidence)"; fi
printf 'AI real-model acceptance passed.\n'
