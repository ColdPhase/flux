#!/bin/sh
# OPT-IN Docker check (#1125): the REAL pinned Claude Code (apps/runtime/src/install/pins.ts) and Codex (docker/Dockerfile) inside
# the agent runtime image, driven by Flux (API → worker → runtime-manager → supervisor → CLI → runtime-egress /mcp), against a local
# vendor mock instead of any account or key (providermock, app/tests/app/support/cli-vendor-mock.ts). What differs from production
# is listed in docker/compose.cli-runtime.test.yaml; the runtime's egress has no way out, so no vendor host can be reached.
#
# Covered, on each engine: an /ai run and an agent task run that call Flux's MCP tools (read a conversation and a task, create a task
# and a subtask, flux_read_web), the CLIs' own texts for an over-long request, a limit and a revoked sign-in, and what Flux records for
# each; on Claude Code its own WebSearch with result addresses; on Codex the ChatGPT device sign-in through Flux's console against a
# mock issuer, a token refresh, the usage limit's reset time, and sign-out with revocation; no vendor credential in the database or
# the logs; on Codex its own web search (#1065: the standalone `web.run`, on the cached index) with result addresses; on each engine a direct-message ask with reading the web off, whose one tool the server does not define: an empty tool list, which still answers (#1155). Assertions are on Flux's side effects, never on model text.
# Not covered (needs a real account, see docs/agents/evaluation.md): the Claude plan sign-in and plan-limit texts, real model quality.
#
# Needs internet only to build the images and for Flux's own installer to download the pinned Claude Code (downloads.claude.ai,
# signature-checked). Run it alone under the shared Docker lock; set FLUX_TEST_PORT / FLUX_TEST_MAILPIT_PORT for concurrent runs.
set -eu

cd "$(dirname "$0")/.."
project="flux-clirt-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-test-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-test-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_TEST_PORT:-18096}"
export FLUX_MAILPIT_PORT="${FLUX_TEST_MAILPIT_PORT:-18097}"
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
# The runtime, as ./flux switches it on: both clients, the Commercial Terms date, and fresh secrets.
export FLUX_AGENT_RUNTIME=claude_code,codex
export FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-10-05
export FLUX_RUNTIME_MANAGER_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_RUNTIME_SECRET_1="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_IMAGE_TAG="$project"
export FLUX_CLI_TOOLS_VOLUME="$project-claude-tools"
export COMPOSE_FILE="docker/compose.source.yaml:docker/compose.source.runtime.yaml:docker/compose.test.yaml:docker/compose.cli-runtime.test.yaml"
. scripts/test_images.sh
compose="docker compose -p $project --profile test --profile runtime"
installer="flux-agent-runtime-install:$project"
# The API keys "Ada" signs in with: written into her own CLI home in the runtime, as her user. The revoked one the mock refuses.
claude_key="sk-ant-mock-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
revoked_key="sk-ant-mock-expired-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail 80 api worker runtime-manager runtime-egress runtime-install runtime-1 providermock 2>/dev/null || true
  fi
  if [ "${FLUX_CLI_RUNTIME_KEEP:-}" = 1 ]; then
    printf 'FLUX_CLI_RUNTIME_KEEP=1: kept project %s and volume %s; remove them with `docker compose -p %s down -v` and `docker volume rm`.\n' "$project" "$FLUX_CLI_TOOLS_VOLUME" "$project" >&2
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

check() { $compose run --rm --no-deps -T test node_modules/.bin/tsx tests/app/cli-runtime.check.ts "$@"; }
value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1; }
slot_cid() { $compose ps -q runtime-1; }
# Writes the API key a person signs in with into their own CLI home, as that person (their binding directory's owner).
claude_key_for() {
  cid=$(slot_cid)
  who=$(docker exec "$cid" stat -c %u:%g "/data/$1")
  docker exec -u "$who" "$cid" sh -c "umask 077; printf '%s' '$2' > /data/$1/claude/flux-mock-api-key"
}

step "1. Images, and the pinned Claude Code installed by Flux's own installer (signature-checked) into a fresh tools volume"
$compose build migrate test runtime-1
docker build --quiet --file docker/Dockerfile --target agent-runtime-install --tag "$installer" app >/dev/null
docker volume create "$FLUX_CLI_TOOLS_VOLUME" >/dev/null
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000 --tmpfs /tmp:rw,size=64m \
  -e FLUX_AGENT_RUNTIME=claude_code -v "$FLUX_CLI_TOOLS_VOLUME:/opt/flux-tools" "$installer"
# The versions under test, offline (the model requests below carry them too: the mock's journal records each client's user agent).
docker run --rm --network none --read-only --user 1000:1000 --tmpfs /tmp:rw,size=64m -e HOME=/tmp -v "$FLUX_CLI_TOOLS_VOLUME:/opt/flux-tools:ro" \
  --entrypoint sh "flux-agent-runtime-cli-mock:$project" -c 'readlink /opt/flux-tools/claude/bin/claude; /opt/flux-cli-mock/codex --version'

# The supervisor refuses a host with kernel.yama.ptrace_scope 0 (RT-3). This check must not change the host, so there it starts the
# unchanged supervisor main through a TEST ONLY entry that reads that one file as 1 (app/tests/cli-runtime/supervisor-yama0.mjs).
scope=$(docker run --rm --network none --entrypoint cat "flux-agent-runtime-cli-mock:$project" /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true)
if [ "$scope" != 1 ] && [ "$scope" != 2 ] && [ "$scope" != 3 ]; then
  printf 'NOTE: this host has kernel.yama.ptrace_scope=%s; the supervisor starts through the TEST ONLY entry that reads it as 1.\n' "${scope:-none}"
  export FLUX_CLI_SUPERVISOR_ENTRY=/opt/flux-cli-mock/supervisor-yama0.mjs
fi

step "2. The stack: Flux, the runtime with the real CLIs, the vendor mock; runtime-egress without a way out"
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker mailpit providermock linkmock runtime-manager runtime-egress runtime-1
$compose logs --no-color runtime-install | grep -q 'TEST ONLY: real Claude Code wrapped for the vendor mock' || fail "runtime-install did not wrap Claude Code"
check wait-ready

step "3. Ada and Bo, a space with a conversation, an agent each, a place in the one runtime"
out=$(check setup); printf '%s\n' "$out"
ada_binding=$(value "$out" ADA_BINDING)
[ -n "$ada_binding" ] || fail "no binding for Ada"

step "4. Claude Code: Ada signed in with an API key; Flux reads it from the CLI's own status"
claude_key_for "$ada_binding" "$claude_key"
check claude-check

step "5. Claude Code /ai: read the conversation, create a task, read a page (Flux MCP through runtime-egress)"
check ai claude

step "6. Claude Code's own WebSearch: recorded before its results are read; flux_read_web reads a result"
check claude-search

step "7. Claude Code agent task run: the task's discussion, a subtask, the agent's report"
check task claude

step "8. Claude Code API errors with the CLI's own texts: an over-long prompt, a 429 (#1129)"
check error claude context
check error claude limit

step "9. Claude Code with a revoked key: the run and Settings say sign in again; a good key and a status check set it right"
claude_key_for "$ada_binding" "$revoked_key"
check revoked claude
claude_key_for "$ada_binding" "$claude_key"
check claude-check

step "10. Codex: ChatGPT device sign-in through Flux's console against the mock issuer"
check codex-sign-in

step "11. Codex /ai with Flux's tools, plain tools from Flux's model catalog (#1127); the access token refreshed"
check ai codex

step "12. Codex's own web search (#1065): web.run on the cached index; its results recorded; flux_read_web reads a result"
check codex-search

step "13. Codex agent task run"
check task codex

step "14. Codex API errors with the CLI's own texts: context window, the usage limit with its reset time (#1129)"
check error codex context
check error codex limit

step "14b. An empty tool list (#1155): a direct-message ask with reading the web off, so the server defines no tool for it"
FLUX_WEB_READS=off $compose up -d --wait api worker
check empty-tools claude
check empty-tools codex
$compose up -d --wait api worker

step "15. Codex with its sign-in revoked at the issuer: the refresh fails; the run and Settings say sign in again"
check revoked codex

step "16. Codex sign-out: its own logout revokes the token at the issuer; Flux deletes the login"
check codex-sign-out

step "17. No vendor credential in the database or any service log; runtime-egress opened no tunnel"
out=$(check no-secret "$claude_key" "$revoked_key"); printf '%s\n' "$out" | grep -v '^CREDENTIALS='
$compose logs --no-color > "$background_secret_dir/logs.txt" 2>/dev/null
[ -s "$background_secret_dir/logs.txt" ] || fail "control: no logs were read"
for credential in $(value "$out" CREDENTIALS); do
  if grep -qF "$credential" "$background_secret_dir/logs.txt"; then rm -f "$background_secret_dir/logs.txt"; fail "a service log holds a vendor credential"; fi
done
if $compose logs --no-color runtime-egress | grep -q '"event":"tunnel"'; then rm -f "$background_secret_dir/logs.txt"; fail "runtime-egress opened a tunnel to a vendor"; fi
rm -f "$background_secret_dir/logs.txt"
printf 'no credential in the database or the logs; no tunnel\n'
check summary

printf '\nCLI runtime check passed: the real Claude Code and Codex of the runtime image against the vendor mock.\n'
