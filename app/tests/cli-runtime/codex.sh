#!/bin/sh
# TEST ONLY (#1125, scripts/check_cli_runtime.sh): the REAL pinned Codex of the runtime image, with its vendor hosts pointed at the
# local mock (app/tests/app/support/cli-vendor-mock.ts): the model and ChatGPT backend by `-c` (`openai_base_url`, `chatgpt_base_url`),
# sign-in by `--experimental_issuer`, token refresh and revocation by Codex's own override variables. The supervisor's argv and
# environment reach it unchanged otherwise. `codex exec` reads `openai_base_url` only after its subcommand (observed 2026-11-09).
mock=http://providermock:8095
real=/opt/flux-cli-mock/codex
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}providermock" no_proxy="${no_proxy:+$no_proxy,}providermock"
export CODEX_REFRESH_TOKEN_URL_OVERRIDE="$mock/cli/auth/oauth/token" CODEX_REVOKE_TOKEN_URL_OVERRIDE="$mock/cli/auth/oauth/revoke"
model="openai_base_url=\"$mock/cli/openai/v1\""
backend="chatgpt_base_url=\"$mock/cli/chatgpt/backend-api/\""
device=0
for a do [ "$a" = --device-auth ] && device=1; done
if [ "${1:-}" = exec ]; then
  shift
  set -- exec -c "$model" -c "$backend" "$@"
else
  set -- -c "$model" -c "$backend" "$@"
fi
[ "$device" = 1 ] && set -- "$@" --experimental_issuer "$mock/cli/auth"
exec "$real" "$@"
