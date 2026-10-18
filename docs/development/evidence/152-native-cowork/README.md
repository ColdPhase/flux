# Native co-work composition, 2026-10-18

Author-run evidence for the bounded existing #152/#160 continuation, based on
`edd37bd4fee9b520697a45d9d47a6b8b814ffafd`. This is not independent approval or
completion of either parent issue. [Selected output](runs.txt) preserves the
subtest outcomes; bulk logs remain outside the repository.

## Sources and results

| Tested source | Selected check | Result |
| --- | --- | --- |
| `d271ac448b7c1aecf90c6974ef84923ef100390c` | Docker build, typecheck, lint | Pass |
| Same | `mcp-cowork-actions.test.ts` + `mcp-cowork-requests.test.ts`, `2026-07-28` | 6 passed, 0 failed/skipped/cancelled |
| Same | Same API suites, `2025-06-18` | 6 passed, 0 failed/skipped/cancelled |
| Same | Default native contract | 13 passed, 2 failed (including parent), 0 skipped/cancelled |
| `f4a30c4cf2e758f8c485683889db3af0788ed309` | Default native contract | 13 passed, 2 failed (including parent), 0 skipped/cancelled; addressed-review subtest passed |
| `469ee89882cb550e8d3fc4d559446600bf41b9e8` | Docker build, typecheck, lint | Pass (9 existing lint warnings, 0 errors) |
| Same | Native contract + onboarding, default Codex mode | 22 passed, 0 failed/skipped/cancelled/todo; 99.842 seconds |
| Same | Same fixtures, `FLUX_TEST_CODEX_MODERN=1` | 22 passed, 0 failed/skipped/cancelled/todo; 108.908 seconds |

The first failure was a fixture error: deferral returned request version 2, but
the subsequent claim used the original send's version 1. The assertion observed
no claimed state. `f4a30c4c` uses the returned deferral version and reports domain
errors directly. Its new addressed-review subtest passed in 17.232 seconds.
An existing desktop Codex step separately offered no Flux tools, before reaching
the domain call; its stderr reported unavailable keyring/DBus and refusal to
reread credentials through file fallback. That entire default lane remained failed;
its modern lane was not run by the fail-fast driver.

For the final run, `469ee898` sets the supported
`mcp_oauth_credentials_store = "file"` in each disposable Codex home before
native registration/login. The pinned `rust-v0.160.1` configuration schema admits
this setting; the [official configuration reference](https://developers.openai.com/codex/config-reference/)
also lists file/auto/keyring (checked 2026-10-18). Credentials still come from
the real Flux OAuth flow. No token is supplied, inspected or logged. Both final
lanes ran independently; neither failure was hidden by an automatic retry.

API evidence remains tied to `d271ac44`: the later changes affect the native
fixture and its native-client home helper only. Relevant API code/tests,
dependencies and Compose configuration are unchanged. The final documentation
and evidence commit changes no application/test behavior.

## Execution and pins

All application commands used Docker and the trusted
`docker/compose.source.yaml:docker/compose.test.yaml` setup/cleanup from
`scripts/check_mcp_clients.sh`, with unique Compose projects and host ports
18685/18686. The temporary targeted driver selected these commands, rather than
claiming the entire maintained script or application suite was run:

```sh
# First run, in each explicitly selected protocol era:
$compose run --rm -e FLUX_TEST_MCP_PROTOCOL="$protocol" test sh -c 'exec node_modules/.bin/tsx --test --test-concurrency=1 tests/app/mcp-cowork-actions.test.ts tests/app/mcp-cowork-requests.test.ts'
# Final native driver: build migrate and mcp-clients, then these two independent lanes:
$compose run --rm mcp-clients sh -c 'node apps/runtime/dist/install/main.js && exec node_modules/.bin/tsx --test --test-concurrency=1 tests/app/e2e/mcp-clients.e2e.ts tests/app/e2e/mcp-onboarding.e2e.ts'
$compose run --rm -e FLUX_TEST_CODEX_MODERN=1 mcp-clients sh -c 'node apps/runtime/dist/install/main.js && exec node_modules/.bin/tsx --test --test-concurrency=1 tests/app/e2e/mcp-clients.e2e.ts tests/app/e2e/mcp-onboarding.e2e.ts'
```

Codex is the real checksummed `rust-v0.160.1` binary plus its pinned code-mode
host from `docker/Dockerfile`. Claude Code is the real 2.1.285 linux-x64-musl
binary, installed using the existing signed-manifest verifier, reporting SHA-256
`7b4414af1bc06eb6d91730759bd01c4c02a4976d0b8526237e9a6d8c33eaf102`.
The external model endpoint alone is scripted; no real vendor account/key/spend
is used. Native mode flags do not by themselves prove a negotiated protocol
version; the two API-era runs are separate explicit evidence.

The final driver exited 0. All three disposable projects were removed with
volumes; their own image tags were removed (4, 2 and 2 respectively). Final
project-prefix checks found no remaining containers, volumes, networks or tags.
The ordinary Flux demo and user's Qwen service were preserved. The foundation
unit run passed 153 tests; agent setup/link/size and whitespace checks also pass.

## What this proves and leaves open

The new native subtest passed in 15.573 seconds (default) and 15.681 seconds
(modern): a Codex sender addresses the other owner's Claude while its other
task retains a live unit. Inbox reads and `busy`/`after_step` deferral preserve
that unit's exact state/version/generation/lease. A third connection, sharing
the sender's agent identity, receives none of the recipient's inbox. Claude
records its observation, parks that task with a checkpoint, then claims and
resolves the review with a persisted native result. A native task-version update
stales the first verdict; existing standing grants cover one fresh review.
Native command retries/repeated intent checks establish exactly two requests,
two verdicts and the expected standing-use debits. Existing five-connection
checkpoint/reconnect, quiet renewal, shared-domain and revocation checks remain.

These are sequential fresh native processes with real OAuth/transport and
scripted tool selection. A retained database lease does not prove an active
client was interrupted safely. Integrated Start/Resume, complete orientation
and changed-plan reanalysis, trusted-playbook model obedience, an active/idle
adapter's scheduling and wake, zero idle model calls, and integrated parent
acceptance remain unverified here. The separate activation-adapter work is not
claimed by this batch. No permissions, product contracts or acceptance criteria
were weakened; no new issue was created.
