#!/bin/sh
# OPT-IN Docker check: the answer-accuracy evaluation of Flux AI on a REAL Anthropic key (#1295, founder decision 2026-11-13). Also run as
# `scripts/check_ai_real_model.sh --eval`. It costs money: every run is capped, and the spend of all runs is kept in a ledger.
#
# 1. scripts/eval/answers/workspace.py writes the workspace (the retrieval bench's 10,000 Polish and English messages, Wiki pages, tasks with
#    discussions, decisions, maps, files, messages at ages relative to today) and ~60 questions with reference answers and gold sources.
# 2. A test stack runs Flux's production personal-runs composition (FLUX_PERSONAL_RUNS=on, web search off) with one difference: the worker's
#    Anthropic requests go through a recording proxy (app/tests/app/support/eval-proxy.ts) that passes them on unchanged and stops at the cap.
#    docker/compose.ai-eval.test.yaml lists every difference from the test stack.
# 3. app/tests/app/ai-eval.check.ts loads the workspace through the API, saves the key through Connect AI, asks every question of the
#    owner's agent (a fresh agent per question in her private chat, or /ai in a conversation), has an LLM judge grade each answer with a
#    fixed rubric, and prints the scores per category; results.json and results.md go to the evidence directory.
#
# The key: FLUX_EVAL_KEY_FILE (default ~/.config/flux-eval/anthropic.key, mode 600), read only into the environment of the two runner
# commands that need it (`-e NAME`, never on a command line); Flux seals it like any saved key. It is never printed, logged or written.
#
# Settings: FLUX_EVAL_MODEL (claude-haiku-5-5), FLUX_EVAL_JUDGE_MODEL (claude-haiku-5-5), FLUX_EVAL_QUESTIONS (ids or categories, comma
# separated; all by default), FLUX_EVAL_MAX_USD (this run's cap, default 2), FLUX_EVAL_BUDGET_USD (all runs together, default 8),
# FLUX_EVAL_LEDGER (default <repo>/.worktrees/ai-eval-evidence/spend.tsv), FLUX_EVAL_EVIDENCE_DIR, FLUX_EVAL_LABEL and FLUX_EVAL_RECORD
# (a directory, e.g. docs/product/research/evidence/1295: results-<label>.json and .md are copied there), FLUX_EVAL_TODAY (the seed's day),
# FLUX_EVAL_VARIANT (a named engine variant under evaluation, given to the API and worker as FLUX_TEST_AI_VARIANT; empty = main as it is),
# FLUX_TEST_PORT / FLUX_TEST_MAILPIT_PORT (18790 / 18791). Run it under the shared Docker slot limiter.
#
# Every agent runs in pi in the agent runtime (#1441, RT-1): runtime-egress, runtime-manager and runtime-1 join the stack, and pi's model
# requests go through the worker's model gateway, whose Anthropic upstream is the recording proxy, so the ledger and the cap see every
# request. The runtime needs a host with kernel.yama.ptrace_scope >= 1 and Landlock ABI 4; on another host runtime-1 stays unhealthy and
# the run stops before any question.
set -eu

cd "$(dirname "$0")/.."
root=$(pwd)
project="flux-aieval-$(date +%s)-$$"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
repo_root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
key_file="${FLUX_EVAL_KEY_FILE:-$HOME/.config/flux-eval/anthropic.key}"
ledger="${FLUX_EVAL_LEDGER:-$repo_root/.worktrees/ai-eval-evidence/spend.tsv}"
export FLUX_EVAL_EVIDENCE_DIR="${FLUX_EVAL_EVIDENCE_DIR:-$repo_root/.worktrees/ai-eval-evidence/$stamp}"
export FLUX_EVAL_MODEL="${FLUX_EVAL_MODEL:-claude-haiku-5-5}"
export FLUX_EVAL_JUDGE_MODEL="${FLUX_EVAL_JUDGE_MODEL:-claude-haiku-5-5}"
export FLUX_EVAL_QUESTIONS="${FLUX_EVAL_QUESTIONS:-}"
export FLUX_EVAL_LABEL="${FLUX_EVAL_LABEL:-$stamp}"
export FLUX_EVAL_SHA="$(git rev-parse --short=9 HEAD)$(git diff --quiet HEAD -- app docker scripts || echo '+changes')"
# The product code measured: the main commit this checkout stands on (the harness adds only test files and a test-only switch).
export FLUX_EVAL_PRODUCT_SHA="$(git rev-parse --short=9 "$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)")"

step() { printf '\n== %s\n' "$*"; }
# No evidence file may hold the key: any that does is removed (the key itself is never printed). The key is matched as it is sent (without
# a line ending), so a key file saved with CRLF still matches; an empty key file matches everything and removes it all (fail closed).
scrub_key() {
  for leaked in $(tr -d '\r\n' < "$key_file" | grep -rlF -f - "$FLUX_EVAL_EVIDENCE_DIR" 2>/dev/null); do
    rm -f "$leaked"; printf 'WARNING: %s held the key and was removed\n' "$leaked" >&2; key_leaked=1
  done
}
key_leaked=
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -r "$key_file" ] || fail "no key file at $key_file (FLUX_EVAL_KEY_FILE)"
[ "$(stat -c %a "$key_file")" = 600 ] || fail "$key_file must be mode 600"
mkdir -p "$FLUX_EVAL_EVIDENCE_DIR/proxy" "$(dirname "$ledger")"
touch "$ledger"
spent=$(awk -F '\t' '{ total += $2 } END { printf "%.4f", total }' "$ledger")
cap=$(awk -v budget="${FLUX_EVAL_BUDGET_USD:-8}" -v max="${FLUX_EVAL_MAX_USD:-2}" -v spent="$spent" \
  'BEGIN { left = budget - spent; printf "%.4f", (left < max ? left : max) }')
awk -v cap="$cap" 'BEGIN { exit !(cap >= 0.05) }' || fail "the budget is spent: \$$spent of \$${FLUX_EVAL_BUDGET_USD:-8} (ledger $ledger)"
export FLUX_EVAL_CAP_USD="$cap"
printf 'Spent so far $%s of $%s; this run may spend up to $%s. Evidence: %s\n' "$spent" "${FLUX_EVAL_BUDGET_USD:-8}" "$cap" "$FLUX_EVAL_EVIDENCE_DIR"

export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18790}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18791}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-test-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
background_secret_dir=$(mktemp -d)
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"
export FLUX_SMTP_URL="smtp://mailpit:1025" FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_AUTH_RATE_LIMIT=false
# The dev stack's VAPID keys must not leak into this run (docs/development/containers.md).
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
export FLUX_KEYRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export FLUX_KEY_PIN_SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
# Production personal runs on the owner's key, no plan CLI, no web search: the questions are about the workspace, and the cost stays bounded.
# The key's runs go to pi in the agent runtime (#1441), the production runtime image and services.
export FLUX_PERSONAL_RUNS=on FLUX_TEST_PERSONAL_RUNS= FLUX_AGENT_RUNTIME=pi FLUX_WEB_READS="${FLUX_WEB_READS:-off}"
export FLUX_IMAGE_TAG="$project"
export COMPOSE_FILE="docker/compose.source.yaml:docker/compose.source.runtime.yaml:docker/compose.test.yaml:docker/compose.ai-eval.test.yaml"
export FLUX_RUNTIME_MANAGER_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_RUNTIME_SECRET_1="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
. scripts/test_images.sh
compose="docker compose --env-file /dev/null -p $project --profile test --profile runtime"

cleanup() {
  status=$?
  $compose logs --no-color api worker evalproxy runtime-egress runtime-1 > "$FLUX_EVAL_EVIDENCE_DIR/stack.log" 2>/dev/null || true
  scrub_key
  if [ -f "$FLUX_EVAL_EVIDENCE_DIR/proxy/proxy.jsonl" ]; then
    run_cost=$(grep -o '"costUsd":[0-9.e-]*' "$FLUX_EVAL_EVIDENCE_DIR/proxy/proxy.jsonl" | awk -F: '{ total += $2 } END { printf "%.6f", total }')
    printf '%s\t%s\t%s\t%s\t%s\n' "$stamp" "$run_cost" "$FLUX_EVAL_MODEL" "$FLUX_EVAL_SHA" "$FLUX_EVAL_LABEL" >> "$ledger"
    printf 'This run spent $%s (provider usage); all runs: $%s\n' "$run_cost" "$(awk -F '\t' '{ total += $2 } END { printf "%.4f", total }' "$ledger")"
  fi
  if [ "${FLUX_EVAL_KEEP:-}" = 1 ]; then printf 'FLUX_EVAL_KEEP=1: kept project %s.\n' "$project" >&2; exit "$status"; fi
  $compose down -v --remove-orphans >/dev/null 2>&1 || true
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

check() { $compose run --rm --no-deps -T test node_modules/.bin/tsx tests/app/ai-eval.check.ts "$@"; }
# The key enters only this runner's environment, by name: `-e NAME` takes the value from the subshell's environment, never from argv.
check_with_key() (
  FLUX_EVAL_ANTHROPIC_KEY=$(tr -d '\r\n' < "$key_file")
  export FLUX_EVAL_ANTHROPIC_KEY
  $compose run --rm --no-deps -T -e FLUX_EVAL_ANTHROPIC_KEY test node_modules/.bin/tsx tests/app/ai-eval.check.ts "$@"
)

step "1. The workspace and the questions (scripts/eval/answers/workspace.py, pinned Python, no network)"
docker run --rm --network none -u "$(id -u):$(id -g)" -v "$root/scripts/eval:/eval:ro,z" -v "$FLUX_EVAL_EVIDENCE_DIR:/out:z" \
  python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f \
  python3 -I /eval/answers/workspace.py --out /out/eval-seed.json ${FLUX_EVAL_TODAY:+--today "$FLUX_EVAL_TODAY"}

step "2. Images and the stack (production personal runs in pi in the agent runtime, the recording proxy, cap \$$cap)"
$compose build migrate test runtime-1 runtime-install
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker mailpit evalproxy
# The runtime: its supervisor marks itself ready only on a host that meets its requirements (ptrace_scope, Landlock).
printf 'Host: kernel %s, kernel.yama.ptrace_scope=%s\n' "$(uname -r)" "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none)"
$compose up -d --wait runtime-egress runtime-manager runtime-1 || fail "the agent runtime did not start (it needs kernel.yama.ptrace_scope >= 1 and Landlock ABI 4)"
attempt=0
until $compose logs --no-color worker | grep -q '"event":"model_gateway","state":"listening"'; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || fail "the worker's model gateway did not listen"; sleep 1
done
check wait-ready

step "3. The workspace, loaded through the API and dated"
check seed

step "4. Connect AI: the owner saves her key; her agents run on $FLUX_EVAL_MODEL"
check_with_key connect

step "5. The questions, one run each (${FLUX_EVAL_QUESTIONS:-all})"
check ask

step "6. The judge ($FLUX_EVAL_JUDGE_MODEL, fixed rubric)"
check_with_key judge

step "7. Results"
check report | tee "$FLUX_EVAL_EVIDENCE_DIR/summary.txt"
# A run the provider failed (an outage, an authentication error) measures the provider, not Flux: it is never recorded as a result.
if grep -q '^PROVIDER FAILURES' "$FLUX_EVAL_EVIDENCE_DIR/summary.txt"; then fail "the provider failed some runs (see summary.txt); run again"; fi
# Nor is a run in which some questions were never asked (the cap stopped it, or asking failed): its accuracy is over fewer questions.
if grep -q '^INCOMPLETE' "$FLUX_EVAL_EVIDENCE_DIR/summary.txt"; then fail "some questions were not asked (see summary.txt); run again"; fi
scrub_key
[ -z "$key_leaked" ] || fail "an evidence file held the key; nothing is recorded"
if [ -n "${FLUX_EVAL_RECORD:-}" ]; then
  mkdir -p "$FLUX_EVAL_RECORD"
  cp "$FLUX_EVAL_EVIDENCE_DIR/results.json" "$FLUX_EVAL_RECORD/results-$FLUX_EVAL_LABEL.json"
  cp "$FLUX_EVAL_EVIDENCE_DIR/results.md" "$FLUX_EVAL_RECORD/results-$FLUX_EVAL_LABEL.md"
  printf 'Recorded results-%s.{json,md} in %s\n' "$FLUX_EVAL_LABEL" "$FLUX_EVAL_RECORD"
fi
printf '\nEvidence: %s\n' "$FLUX_EVAL_EVIDENCE_DIR"
