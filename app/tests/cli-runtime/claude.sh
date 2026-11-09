#!/bin/sh
# TEST ONLY (#1125, scripts/check_cli_runtime.sh): the REAL pinned Claude Code from the tools volume, with its model host the local
# mock (app/tests/app/support/cli-vendor-mock.ts). A Claude plan sign-in cannot be faked (its OAuth hosts are fixed in the binary), so
# a person is signed in with an API key the check writes into their own CLI home; without that file the CLI is signed out, and Flux's
# sign-out deletes it with the rest of the home. The supervisor's argv and environment reach it unchanged otherwise.
real=__REAL__
key="${CLAUDE_CONFIG_DIR:-/nonexistent}/flux-mock-api-key"
if [ -r "$key" ]; then ANTHROPIC_API_KEY=$(cat "$key"); export ANTHROPIC_API_KEY; fi
export ANTHROPIC_BASE_URL=http://providermock:8095/cli/anthropic
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}providermock" no_proxy="${no_proxy:+$no_proxy,}providermock"
exec "$real" "$@"
