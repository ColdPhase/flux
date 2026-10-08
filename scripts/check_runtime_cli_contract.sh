#!/bin/sh
# OPT-IN, never in CI: the flag contract check of the agent runtime against the pinned REAL CLIs
# (F-022 Docker test plan, "Flag contract test"; T3 #278). No account or subscription is needed.
#
# It builds the release runtime image (Codex rust-v0.160.1, downloaded by checksum) and the installer
# image, installs Claude Code at the pinned version from Anthropic's GPG-signed release manifest into a
# throwaway volume (exactly what runtime-install does), then runs apps/runtime/dist/contract/check-flags.js:
# every flag and subcommand of the fixed command templates must appear in the CLIs' own help. It then
# runs apps/runtime/dist/contract/check-auth.js in `--network none` (T4 #279): the sign-in, status and
# sign-out assertion table (golden `--help` texts, status JSON keys, exit codes, stdout vs stderr, the
# `code#state` paste rule, the device-code banner against a loopback mock issuer) against the real CLIs.
# The same table runs against the fakes in the normal checks, so a fake cannot drift from the vendor.
# No account, no login and no network: nothing here may sign in.
#
# Needs internet access to github.com and downloads.claude.ai and about 0.6 GB of disk; it removes its
# image tags and volume afterwards. Run it alone under the shared Docker lock and record the dated
# result (versions and output) on the PR. Until it has run, the real-CLI contract is UNVERIFIED.
set -eu

cd "$(dirname "$0")/.."
tag="fluxcontract$$"
volume="fluxcontract-tools-$$"
cleanup() {
  status=$?
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm -f "flux-agent-runtime-install:$tag" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

docker build --file docker/Dockerfile --target agent-runtime-install --tag "flux-agent-runtime-install:$tag" app
docker volume create "$volume" >/dev/null
harden="--read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000"
# shellcheck disable=SC2086
docker run --rm $harden --tmpfs /tmp:rw,size=64m -e FLUX_AGENT_RUNTIME=claude_code \
  -v "$volume:/opt/flux-tools" "flux-agent-runtime-install:$tag"
# shellcheck disable=SC2086
docker run --rm $harden --network none --tmpfs /tmp:rw,size=64m \
  -v "$volume:/opt/flux-tools:ro" "flux-agent-runtime-install:$tag" node apps/runtime/dist/contract/check-flags.js
# shellcheck disable=SC2086
docker run --rm $harden --network none --tmpfs /tmp:rw,size=64m \
  -v "$volume:/opt/flux-tools:ro" "flux-agent-runtime-install:$tag" \
  node apps/runtime/dist/contract/check-auth.js /opt/flux-tools/claude/bin/claude /opt/flux-runtime/codex/bin/codex
