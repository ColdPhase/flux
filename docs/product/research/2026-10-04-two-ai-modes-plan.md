# Two AI modes: delivery plan (#245 AC-4)

**Decision:** [F-022](../ai-modes.md), revised 2026-10-05 under founder direction
[#266](https://github.com/ColdPhase/flux/issues/266) and accepted 2026-10-05 after
independent evaluation by claude-maurycy (N1–N4 applied in `ee216059`). **Evidence:** [agent runtime research](2026-10-05-agent-runtime.md)
(2026-10-05) and [audit and research](2026-10-04-two-ai-modes.md) (2026-10-04).
**Status:** a proposed task list for the orchestrator. No GitHub issue is created
by this document. Owners are proposals: @Zamojski5 (`claude-maurycy`) and
@PelikanFix16 (`claude-hubert` / `codex-hubert`). Each task has one implementation
owner and an independent evaluator who did not write it.

**Revision 2026-10-05.** The companion tasks (old T3–T5, T10) and the
provider-question task (old T9) are withdrawn. Mode (a)'s subscription path is now
the `runtime` transport: the owner's unmodified official CLI in a per-owner
runtime slot. Mode letters follow the founder: (a) the agent in Flux, (b) your agent
app over MCP. After the [review of `7a6987e7`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000291729),
T3–T6 and T10 use a fixed pool of Compose-declared slots with no Docker socket,
every CLI sign-in method, a no-local-tool read-back and the owner-consented agent
connection.

**How every coding task is verified.**

- Run the task's targeted tests and `./scripts/check_application.sh` in Docker, with
  unique `FLUX_TEST_PORT` / `FLUX_TEST_MAILPIT_PORT` and a unique Compose project.
- Use the coordinated serial heavy-test slot.
- Runtime tasks use the fake CLIs below. Mocks prove regression behavior only.
- A real client, account or subscription check is recorded with date and version,
  or reported **unverified**. No fake success is reported as real.

## Order and dependencies

```text
T0 peer review of F-022 ──┬─> T1 reconcile #192/#212 ──> T9 OpenRouter PKCE
                          ├─> T2 one Connect AI entry
                          └─> T3 runtime foundation ──> T4 Claude Code sign-in ──> T5 first owner run  (T3–T5 = minimum viable slice)
                                                                                     ├─> T6 Codex
                                                                                     ├─> T7 write tools and proposals
                                                                                     └─> T8 later runtime slices
T10 real-account and real-client checks      after T5/T6; mode (b) part independent
T11 issue text updates                       after T0
```

## Tasks

### T0 — Independent review of the revised F-022 (decision)

- **Owner:** @Zamojski5 (evaluator). **Depends on:** this PR's new head.
- **Acceptance:**
  - A review names the exact head SHA.
  - It checks the quotes against the linked sources and the two-mode mapping.
  - It checks the runtime topology, the isolation and secret rules, the rejected
    paths and the accepted-risk list.
  - The [review of `7a6987e7`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000291729)
    found blockers 1–4. A re-review of the new head checks those and the open
    should-fix findings.
  - The status in `decisions.md` changes to Accepted only with a link to that
    review.
  - **Done 2026-10-05:** the [re-review of `ccdb32e2`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6003428258)
    accepted with changes; N1–N4 were applied in `ee216059`, and the status
    changed with a link to that re-review.
- **Verification:** `python3 scripts/check_agent_setup.py`, unit tests,
  `git diff --check`.

### T1 — Reconcile PR #192 and PR #212 with F-022 (existing PRs, no new issue)

- **Owner:** the current #192 writer (Maurycy's takeover branch at `614049b3`).
  **Depends on:** T0.
- **Acceptance:**
  - After rebasing onto F-022, `git grep "through their own external client over MCP"`
    finds nothing.
  - PROV-4 matches F-022.
  - F-020 is not marked "implemented" while PROV-5 real activations and PROV-6
    real-key smoke tests are open.
  - `docs/development/ai-providers.md` cites OpenAI Services Agreement §2.2 and §3.1
    for the key path.
  - Gemini's EEA/Switzerland/UK paid-key condition is either enforced at save or
    shown and recorded as owner-attested.
  - #212 is unchanged in behavior. Its docs state that background rules use
    `server` connections only.
- **Verification:** the #192 Docker suite plus `check_agent_setup.py`.
- **Conflict note:** this PR and #192 both edit `model-providers.md` and
  `decisions.md`. Whichever lands second rebases. The F-022 wording wins on PROV-4.

### T2 — One *Connect AI* entry for both modes (new issue)

- **Owner:** @PelikanFix16 (owns the #136/#183 Agents view). **Depends on:** T0;
  coordinate with #192.
- **Acceptance (running app, phone and desktop widths):**
  - `/settings/ai` shows two sections: *Agent in Flux*, which lists AI connections,
    each use's enablement and the payer, and *Your agent app (MCP)*, which lists
    mode (b) connections and the client guide.
  - With `FLUX_AGENT_RUNTIME` off, *Agent in Flux* says the instance has not
    enabled Claude Code or Codex sign-in.
  - Details "Ways to connect" and the ✦ empty state link there.
  - The Agents view lists the person's agent in Flux next to their MCP connections,
    with the mode shown.
  - Another member never sees anyone else's connections, keys or runtime.
  - No copy says "three ways" or names a vendor that is not the selected one.
- **Verification:** Playwright in Docker for both sections, an owner-only negative
  test (a second member) and a no-AI journey with nothing connected.

### T3 — Runtime foundation (new issue; minimum viable slice, part 1)

- **Owner:** @PelikanFix16. **Evaluator:** @Zamojski5. **Depends on:** T0, and T1
  merged (connection schema).
- **Scope:**
  - Operator switch `FLUX_AGENT_RUNTIME` (empty, `claude_code`, `codex` or both),
    empty by default; the release `docker/compose.yaml` does not set it. Enabling
    `claude_code` also needs the operator's Commercial Terms statement, which Flux
    records with its date.
  - Compose profile `runtime`: `runtime-manager` (internal only, service secret, no
    database and no Docker access), `runtime-egress`, the one-shot
    `runtime-install`, and a fixed pool of slots `runtime-1` to `runtime-4` from one
    YAML anchor. Each slot has its own volume and its own `internal: true`
    network. The API, worker and manager share a `runtime-control` network; the
    API and `runtime-egress` share a `runtime-api` network; neither holds the
    database or Redis. The documented override block for an extra slot attaches
    the manager and `runtime-egress` to its network and adds its secret. **No
    service mounts a Docker or Podman socket.**
  - The supervisor in each slot: a closed request set (bind, login, status, run,
    stop, logout, release), fixed command templates, a clean CLI environment, a
    per-slot secret generated by the launcher in `docker/.env`, one serial lane,
    and a boot id. Release ends with the supervisor exiting, so the restart policy
    starts a fresh process with an empty tmpfs `/tmp`.
  - The source-built runtime image has the supervisor and a pinned
    official Codex release. Claude Code is not in the image: `runtime-install`
    downloads Anthropic's official binary at the tested version, checks the signed manifest
    and fills the tools volume, which slots mount read-only; `DISABLE_UPDATES=1`.
    Publishing `ghcr.io/coldphase/flux-agent-runtime` and release-matched operator
    assets is tracked separately in [#358](https://github.com/ColdPhase/flux/issues/358)
    with [#77](https://github.com/ColdPhase/flux/issues/77).
  - Connection transport `runtime` with client `claude_code` or `codex`; slot
    bindings in the database, with UUID binding directories (CHECK and code),
    `0700`, symlinks rejected. An operator release of a binding from the admin view
    (sign-out first, owner told), and an optional idle policy, off by default.
  - Isolation: non-root, read-only root, `cap_drop: ALL`, `no-new-privileges`,
    2 GiB memory, one CPU, 256 pids, 128 MiB tmpfs `/tmp`, rotated logs, a 256 MiB
    binding-directory check; egress only to documented vendor hosts and the Flux
    `/mcp` route.
  - Backup, restore and cleanup: `./flux backup` excludes slot volumes and the
    backup guide says why; after a restore the worker reconciles the database's
    bindings with each slot's directory through the manager; `reset` and `clean`
    include the profile and sign out first; a runtime purge step for switching off
    for good.
  - Operator guide in `docs/operations/` ([F-022 operator duties](../ai-modes.md#operator-duties)).
  - Fake CLIs and the flag contract test (see [Docker test plan](#docker-test-plan)).
- **Acceptance (Docker):**
  - Switch off: no runtime service starts and the API reports the feature disabled.
  - No Compose file in the repository mounts a Docker or Podman socket, checked by
    a test.
  - Two owners get two slots. A cannot reach, start, inspect or sign in to B's
    slot by any API input. With every slot bound, a third owner sees the
    pool-full state and can still use `server` connections and mode (b).
  - From inside a slot, the database, Redis, the worker, the API outside `/mcp`,
    the metadata IP, another slot and any non-allowlisted host are unreachable.
  - The supervisor refuses any request outside its closed set, and any command
    line, flag, path or environment value.
  - Releasing a slot signs out, deletes the binding directory, confirms `/data`
    is empty and ends with the supervisor exiting. The slot is bound again only
    after a new boot id and an empty `/data` are reported. A second owner then
    binds it with a fresh process and an empty `/tmp`.
  - The supervisor refuses to bind while `/data` holds any entry.
  - After a restore, a binding without a directory shows *Sign in again*, and a
    directory without a binding is signed out and deleted.
  - An extra slot added with the documented override is reachable by the manager
    and `runtime-egress`, and by nothing else.
  - The supervisor-stream reader and `runtime-egress` reject oversized and
    malformed input, under a fuzz test.
  - A schema test fails if a runtime table gains a column that could hold a
    token.
  - `docker inspect` shows the limits and security options on every slot.
  - `./flux backup` contains no slot volume; `./flux reset` removes them.
  - The flag contract test passes against the pinned real CLIs.
- **Implementation notes (#278, 2026-10-06), for the evaluator:**
  - The operator's release of a binding is `./flux runtime release runtime-<n>`
    (with `./flux runtime status`): Flux has no in-app instance administrator
    role, and inventing one is outside T3.
  - `runtime-install` verifies the pinned Claude Code (2.1.285, the `stable`
    channel on 2026-10-05) with Anthropic's documented manifest-signature steps
    (fingerprint `31DD DE24 … 1A7E CACE` from the setup page) instead of piping
    `install.sh`, which downloads and runs the latest binary first.
  - The `runtime` profile is in `docker/compose.source.yaml`, which `./flux`
    runs. The release `docker/compose.yaml` stays unchanged until the release
    workflow builds and publishes `ghcr.io/coldphase/flux-agent-runtime`; that
    is release engineering, recorded as a follow-up.
  - `codex` is accepted by the switch and shown as pending: Codex stays off until
    T6 records its hosts.
  - The automated checks use fake CLIs. The flag contract test against the pinned
    real CLIs is `scripts/check_runtime_cli_contract.sh`, opt-in and outside CI. It
    passed on 2026-10-06 (Claude Code 2.1.285, codex-cli 0.160.1); `--max-turns` is
    not in `claude --help` but is accepted, which T5 should keep checking.

### T4 — Claude Code sign-in console (new issue; minimum viable slice, part 2)

- **Owner:** @PelikanFix16. **Evaluator:** @Zamojski5. **Depends on:** T3.
- **Scope:** Settings → *Agent in Flux* → *Sign in to Claude Code*, with no vendor
  logos. The owner chooses Claude account, Anthropic Console or SSO; the supervisor
  runs `claude auth login`, `claude auth login --console` or
  `claude auth login --sso` in a PTY, relayed by xterm.js over a session-bound
  WebSocket. Completion through `claude auth status`. Display facts only, with an
  account-change notice. *Sign out* and *Remove runtime*. Settings states the
  operator's access, the vendor risk and the payer label before sign-in.
- **Acceptance (Docker, fake `claude`):**
  - The console offers all three methods, and each runs exactly its command. The
    pinned CLI's `auth login --help` lists no further method, or the console
    offers it too.
  - The console shows the CLI's URL; a pasted code reaches the CLI prompt; the
    connection becomes signed in only after `auth status` reports it.
  - The console cannot run any other command. Another member's session cannot
    attach to it. The PTY ends on exit, on disconnect and after 15 minutes.
  - No console frame is stored or logged.
  - Sign out runs `claude auth logout` and then deletes the credential files.
    Remove signs out first, then deletes the binding directory and frees the slot.
    A failed logout still deletes the files and tells the owner to end the session
    at the vendor.
  - No setup-token, `auth.json`, session or API-key field exists anywhere in the UI
    or API for the runtime.
  - Seeded-secret scan: the fake credential never appears in the database, logs,
    frames or API responses.
  - Phone-width layout of the console and the notices.

### T5 — First owner-invoked run on Claude Code (new issue; minimum viable slice, part 3)

- **Owner:** @PelikanFix16. **Evaluator:** @Zamojski5. **Depends on:** T4.
- **Scope:**
  - An owner-consented agent connection per `runtime` connection
    (`compute_source = 'owner_runtime'`), created on the mode (b) consent screen.
    Migrations add the value to the CHECKs of `agent_connections` and
    `agent_proposals`.
  - Per-run MCP token (`sub` and `flux_owner_user_id`, the agent connection,
    `scope`, run, place; audience Flux MCP; lifetime ≤ timeout). The MCP route
    checks that the run is still running, limits every tool to the place, and
    lists exactly the run's tools to a run token.
  - The hardened `claude -p` command from [F-022](../ai-modes.md#run), the
    `system/init` read-back, the adapter to `assistant_run.changed.v1`, and the
    final text, redacted, through the personal-run path.
  - Read-only Flux MCP tools only, named exactly; no local tool.
  - Caps: runs per day, one serial lane, wall-clock and no-event timeouts, max
    turns, MCP result size per call and per run, max answer size. Stop: SIGINT,
    SIGTERM, kill.
  - Payer label from `authMethod`; the data notice for `runtime` in the O-008
    notice and Settings.
  - Agents view entry "Agent in Flux · Claude Code · <payer label>", e.g. "your
    Claude plan" or "your Anthropic Console organization", from `authMethod`.
- **Acceptance (Docker, fake `claude` making real MCP calls):**
  - A run streams progress and commits an answer only after the access recheck.
  - The run token reads only the run's place and the agent connection's projects,
    and fails after the run ends.
  - Revoking the connection mid-run makes the next MCP call fail with 403 and ends
    the run.
  - **No local tool remains:** a fake `system/init` with any extra tool or MCP
    server stops the run with no answer. The pinned real `claude` gets the exact
    argv, and its `system/init` field names are pinned, or this is recorded as
    first verified in T10.
  - `FLUX_RUN_TOKEN` reaches the Flux MCP `Authorization` header through the
    pinned real CLI, or the run uses a `headersHelper`.
  - Expired login, plan limit, hang (both timeouts), crash, oversized output,
    oversized MCP results and a second concurrent run each end in their own state.
    None falls back to an API key.
  - Stop records requested and acknowledged separately. A broken stream ends
    `unknown`, with no rerun.
  - A background rule cannot select a `runtime` connection.
  - A token-shaped string, or the run token itself, in CLI output is redacted from
    the committed answer, logs and errors.
  - No transcript remains in the binding directory after a run.

### T6 — Codex in the runtime (new issue)

- **Owner:** @Zamojski5. **Evaluator:** @PelikanFix16. **Depends on:** T5.
- **Scope:**
  - *Sign in to Codex* with device code (`codex login --device-auth`), an OpenAI
    API key (`codex login --with-api-key`) and, if the pinned version has it, an
    Enterprise access token (`codex login --with-access-token`). Every Codex
    command gets `-c cli_auth_credentials_store=file`. Flux never sets
    `forced_login_method`. The device code is shown only to the owner and never
    persisted.
  - `codex login status`, `codex logout`, and the hardened `codex exec --json`
    command from [F-022](../ai-modes.md#run), with `--ignore-user-config`.
  - The JSONL check: any `item.*` other than an agent message, reasoning, or an
    `mcp_tool_call` to `flux` with a listed tool stops the CLI and commits
    nothing. This is the authoritative check.
  - An app-server client that may send only `initialize`, `config/read` and
    `account/rateLimits/read`. `config/read` is kept as a blocking preflight only
    if it reflects the `-c` overrides.
  - Plan-limit detection in two steps, with "unknown" for an unreadable limit.
  - The OpenAI hosts Codex needs, recorded from the pinned Codex source and added
    to `runtime-egress`.
- **Acceptance:**
  - T4 and T5's acceptance repeated with fake `codex`, plus the device-code expiry
    and "device login not enabled" states.
  - **No local tool remains:** a fake `codex` that emits a `command_execution`,
    `file_change`, web search or non-Flux MCP item is stopped at that item, and
    nothing is committed. The command passes every override:
    `features.shell_tool`, `features.unified_exec`, `features.apps`,
    `features.multi_agent`, `features.skill_mcp_dependency_install`,
    `features.hooks`, `features.goals`, `features.remote_plugin` and
    `features.memories` false; web search disabled; `tools.view_image` false; and
    Flux as the only MCP server, required, with the exact non-empty
    `enabled_tools`.
  - The pinned real `codex` (no account needed) is checked for whether
    `config/read` reflects the `-c` overrides. The result is recorded, and the
    preflight is kept or dropped to match.
  - The pinned version's default-on features are compared with the override
    list; an unknown default-on feature fails the contract test until reviewed.
  - The app-server client refuses every other method, including `command/exec`.

### T7 — Write tools and proposals in runtime runs (new issue)

- **Owner:** @Zamojski5. **Evaluator:** @PelikanFix16. **Depends on:** T5.
- **Acceptance:** a runtime run uses the same Flux MCP write tools as mode (b),
  under the same grant. Consequential changes become proposals, with the agent
  connection's `owner_runtime` compute source. A fake CLI that calls a tool
  outside the grant or place is refused.

### T8 — Later runtime slices (one issue each when picked up)

- `--resume` continuations of a run. They need a decision on where a transcript
  with project content may live, because runs keep none today.
- A per-run repository workspace with shell tools inside the sandbox.
- Optional Sign in with ChatGPT plus the official Codex app-server, inside the
  runtime.

Each needs its own acceptance criteria and evaluator. None is part of the minimum
viable slice.

### T9 — OpenRouter OAuth PKCE (new issue; `server` transport)

- **Owner:** @PelikanFix16 (#192 provider author). **Depends on:** T1.
- **Acceptance:**
  - *Connect with OpenRouter* sends the owner to OpenRouter with an S256
    challenge.
  - The callback on the Flux origin is bound to the initiating session, and its
    state is single-use with a ten-minute expiry.
  - The returned key is stored with the existing AEAD custody and never reaches
    the browser.
  - A forged or replayed callback is refused. The pasted-key path still works.
  - The UI says spend limits are managed in OpenRouter settings. Key limits at
    issuance are re-checked and recorded.
- **Verification:** Docker with a mock OpenRouter auth endpoint. A real
  OpenRouter connection is dated, or **unverified**.

### T10 — Real-account and real-client checks

- **Owner:** the owner of each slice. **Depends on:** T5 (Claude Code), T6 (Codex);
  the mode (b) part is #152 AC-4 and has no new dependency.
- **Acceptance:** dated records with versions of:
  - runtime: Claude Code sign-in with each offered method that the tester can use,
    one run, stop and sign-out on a real plan;
  - runtime: the same for Codex on a real ChatGPT plan;
  - runtime: an adversarial run on each CLI that asks it to print its credential
    file or environment, or to run a command, and finds no tool for it;
  - runtime: the real `claude auth status` JSON, the `system/init` field names,
    `FLUX_RUN_TOKEN` header expansion, and whether each CLI's logout revokes the
    refresh token at the vendor;
  - mode (b): a real Codex and a real Claude Code connection, each completing a
    grant-scoped tool call and an F-018 Start/Resume, plus one other MCP client.
  Anything not observed stays **unverified**.

### T11 — Issue text updates (orchestrator)

- **Owner:** @PelikanFix16. **Depends on:** T0.
- **Acceptance:**
  - #179's PROV-4 bullet matches F-022.
  - #152, #153 and #160 each state that they are mode (b).
  - #68 and #58 each state that they are mode (a), with #58 on `server`
    connections only.

### Optional, not scheduled

- **Claude Code channel delivery (mode (b)).** A local spike may test a channel
  plugin on a developer's own machine. Shipping waits until Channels leave
  research preview or an allowlist route is published. No inquiry is sent.

## Docker test plan

No subscription is needed for any automated test.

- **Fake CLIs.** `test/fake-claude` and `test/fake-codex` are Node binaries with the
  same argv and JSONL shapes. `FAKE_SCENARIO` selects the behavior:
  - **Login:** for each method, print a URL and wait for a pasted code (Claude),
    print a device URL and code and poll, or read a key from stdin (Codex). Write
    `.credentials.json` / `auth.json` into the binding directory. `auth status`
    then reports the method.
  - **Run:** emit `system/init` with the tools and MCP server status, make **real**
    MCP calls to Flux with the injected token, then emit deltas and `result` /
    `turn.completed`.
  - **Failures:** expired login, plan limit, hang (wall-clock and no-event),
    crash, SIGINT acknowledgement, oversized output, an extra tool in
    `system/init`, a Codex `command_execution` or other non-Flux item, and a
    token-shaped string in the answer.
  - **Escape attempts:** read another slot's path; reach the database, the API
    outside `/mcp`, another slot or the metadata IP. All must fail.
- **Integration tests with two owners.** A cannot sign in to, run on or see B's
  slot. A revoked connection gets 403 mid-run. The secret-absence scan and the
  no-token-column schema test pass. No Compose file mounts a Docker or Podman
  socket. There is no fallback to API keys.
- **Flag contract test.** Run the pinned real `claude --help` and
  `codex exec --help` in Docker (no account needed) and assert that every flag
  Flux uses exists.
- **Read-back tests.** Run the pinned real `codex app-server` `config/read` with
  Flux's overrides (no account needed) and record whether it reflects them.
  Record whether the pinned real `claude` emits `system/init` without a login.
- **Real-account smoke.** Manual and dated (T10), otherwise **unverified**.

## What stays unverified today

- Every real subscription, client and provider check: Claude Code and Codex in the
  runtime, mode (b) Codex and Claude Code, OpenRouter and other provider keys.
- How Anthropic and OpenAI treat a team-hosted runtime in practice. The agents
  record this risk under founder direction #266
  ([F-022 accepted risks](../ai-modes.md#accepted-risks)); no vendor inquiry is
  planned.
- The real `claude auth status` JSON and `system/init` field names,
  `FLUX_RUN_TOKEN` header expansion, whether `config/read` reflects `-c`
  overrides, `--restricted` together with `--mcp-config`, `--with-api-key`
  through a PTY, whether CLI logout revokes at the vendor, the Codex sandbox in an
  unprivileged container, and the OpenAI hosts Codex needs.
- Phone/tablet behavior of the new pages. T2 and T4 include phone widths.
