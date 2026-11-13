#!/bin/sh
# TEST ONLY (#1125): `runtime-install` of scripts/check_cli_runtime.sh. The check already installed the pinned, signature-checked
# Claude Code into the tools volume with Flux's own installer (on a network with the internet; this stack has none). Here the
# installed binary is checked against the hash the installer verified, and `bin/claude` becomes the mock wrapper (wrap.c, as `claude`).
set -eu
tools=/opt/flux-tools/claude
version=$(node -e "import('/opt/flux-runtime/apps/runtime/dist/install/pins.js').then((m) => console.log(m.CLAUDE_CODE.version))")
binary="$tools/versions/$version/claude"
[ -x "$binary" ] || { echo "Claude Code $version is not installed in the tools volume" >&2; exit 1; }
[ "$(sha256sum "$binary" | cut -d' ' -f1)" = "$(cat "$tools/versions/$version/.verified")" ] || { echo "Claude Code $version does not match its verified hash" >&2; exit 1; }
# The static wrapper (wrap.c) starts `bin/claude-real`, the verified binary: one program file the CLI's sandbox domain may execute (#1437).
ln -sfn "../versions/$version/claude" "$tools/bin/claude-real"
cp /opt/flux-cli-mock/wrap "$tools/bin/.claude-wrapper"
chmod 0755 "$tools/bin/.claude-wrapper"
mv -f "$tools/bin/.claude-wrapper" "$tools/bin/claude"
echo "{\"event\":\"installed\",\"client\":\"claude_code\",\"version\":\"$version\",\"warning\":\"TEST ONLY: real Claude Code wrapped for the vendor mock\"}"
