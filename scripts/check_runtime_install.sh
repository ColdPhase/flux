#!/bin/sh
# Opt-in Docker check of the REAL Claude Code install path (F-022 T3, #331 m9): `runtime-install` ->
# `runtime-egress` (the installer proxy on the runtime-install network) -> downloads.claude.ai, with the
# GPG-signed manifest and SHA-256 checks and no test fakes. It needs the internet and downloads the
# pinned release (about 250 MB). It is a public download from the vendor's release bucket: no account, no
# sign-in and no credential is involved (sign-in is only ever tested against mocks, #279).
#
# It checks: the install succeeds and the binary reports the pinned version; a second run keeps it; the
# installer's proxy reaches downloads.claude.ai and nothing else (the vendor API hosts, example.com and
# plain HTTP are refused); the slots' proxy refuses downloads.claude.ai.
#
# Host load: run it alone. Set FLUX_RUNTIME_TEST_PORT for concurrent runs.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
unset FLUX_PROJECT FLUX_AGENT_RUNTIME FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS FLUX_AGENT_RUNTIME_IDLE_DAYS
export FLUX_PORT="${FLUX_RUNTIME_TEST_PORT:-19581}"
export FLUX_DEV_PORT=$((FLUX_PORT + 1))
export FLUX_MAILPIT_PORT=$((FLUX_PORT + 2))
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-runtime-install-check.XXXXXX")
work=$(cd "$work" && pwd -P)
copy="$work/flux"
project=''

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$project" ]; then
    (cd "$copy" && FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml --profile runtime logs --no-color --tail 40 runtime-egress runtime-install 2>/dev/null) || true
  fi
  if [ -x "$copy/flux" ] && [ -f "$copy/docker/.env" ]; then (cd "$copy" && ./flux clean -y >/dev/null 2>&1) || true; fi
  if [ -n "$project" ]; then
    docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm >/dev/null 2>&1 || true
  fi
  docker volume ls -q --filter "label=com.flux.checkout=$copy" | xargs -r docker volume rm >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

step "Copy the working tree (tracked and new files, no .env) to $copy"
mkdir -p "$copy"
(cd "$here" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - 2>/dev/null) | (cd "$copy" && tar -xf -)
[ -x "$copy/flux" ] || fail "the copy is incomplete"
[ ! -e "$copy/docker/.env" ] || fail ".env was copied"
cd "$copy"

env_set() {
  awk -v k="$1" -v v="$2" 'BEGIN { done = 0 } index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' docker/.env > docker/.env.tmp
  cat docker/.env.tmp > docker/.env && rm -f docker/.env.tmp
}
compose() { FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml --profile runtime "$@"; }

step "1. Start Flux with the runtime off (this writes docker/.env), then switch claude_code on"
./flux up
project=$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)
[ -n "$project" ] || fail "no project name"
env_set FLUX_AGENT_RUNTIME claude_code
env_set FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS 2026-10-05
pinned=$(sed -n "s/^  version: '\\([0-9.]*\\)',\$/\\1/p" app/apps/runtime/src/install/pins.ts | head -n 1)
[ -n "$pinned" ] || fail "no pinned Claude Code version in pins.ts"

step "2. runtime-install downloads, verifies and installs Claude Code $pinned through runtime-egress"
compose up -d runtime-egress
compose run --rm runtime-install > "$work/install-1.log" 2>&1 || { cat "$work/install-1.log"; fail "runtime-install failed"; }
grep -q "\"event\":\"installed\".*\"version\":\"$pinned\"" "$work/install-1.log" || { cat "$work/install-1.log"; fail "runtime-install did not report $pinned installed"; }
if grep -q 'test-fake' "$work/install-1.log"; then fail "the test fakes were used"; fi
tools="${project}_runtime-tools"
version=$(docker run --rm --cap-drop ALL --read-only --network none -v "$tools:/opt/flux-tools:ro" --entrypoint /opt/flux-tools/claude/bin/claude "flux-agent-runtime-install:$project" --version 2>&1) || fail "the installed claude does not run: $version"
case "$version" in *"$pinned"*) printf 'installed binary reports: %s\n' "$version" ;; *) fail "the installed claude reports '$version', expected $pinned" ;; esac

step "3. A second run keeps the verified install"
compose run --rm runtime-install > "$work/install-2.log" 2>&1 || { cat "$work/install-2.log"; fail "the second runtime-install failed"; }
grep -q "\"event\":\"kept\".*\"version\":\"$pinned\"" "$work/install-2.log" || { cat "$work/install-2.log"; fail "the second run did not keep the install"; }

step "4. The installer's proxy reaches downloads.claude.ai and nothing else"
probe='const [target] = process.argv.slice(1);
fetch(target, { signal: AbortSignal.timeout(20000) }).then((r) => { console.log("answered " + r.status); process.exit(0); },
  (e) => { console.log("refused " + (e.cause?.message ?? e.message)); process.exit(1); });'
for target in https://api.anthropic.com/ https://claude.ai/ https://example.com/ http://downloads.claude.ai/; do
  if out=$(compose run --rm --no-deps -T --entrypoint node runtime-install -e "$probe" "$target" 2>&1); then fail "the installer proxy let $target through: $out"; fi
  printf '%s -> %s\n' "$target" "$(printf '%s' "$out" | tail -n 1)"
done
out=$(compose run --rm --no-deps -T --entrypoint node runtime-install -e "$probe" https://downloads.claude.ai/claude-code-releases/stable 2>&1) || fail "control: downloads.claude.ai was refused: $out"
printf 'control: https://downloads.claude.ai/ -> %s\n' "$out"

step "5. A slot's proxy (the vendor API hosts) refuses the download host"
out=$(compose run --rm --no-deps -T --entrypoint node -e HTTPS_PROXY=http://runtime-egress-install:3128 runtime-install -e "$probe" https://downloads.claude.ai/claude-code-releases/stable 2>&1) && fail "the slots' proxy let downloads.claude.ai through: $out"
printf 'slots proxy -> downloads.claude.ai: %s\n' "$(printf '%s' "$out" | tail -n 1)"

printf '\nOK: the real install path (runtime-install -> runtime-egress -> downloads.claude.ai) passed.\n'
