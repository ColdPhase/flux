# Two AI modes: delivery plan (#245 AC-4)

**Decision:** [F-022](../ai-modes.md), revised 2026-10-05 under founder direction
[#266](https://github.com/ColdPhase/flux/issues/266) and awaiting independent peer
review. **Evidence:** [agent runtime research](2026-10-05-agent-runtime.md)
(2026-10-05) and [audit and research](2026-10-04-two-ai-modes.md) (2026-10-04).
**Status:** a proposed task list for the orchestrator. No GitHub issue is created
by this document. Owners are proposals: @Zamojski5 (`claude-maurycy`) and
@PelikanFix16 (`claude-hubert` / `codex-hubert`). Each task has one implementation
owner and an independent evaluator who did not write it.

**Revision 2026-10-05.** The companion tasks (old T3–T5, T10) and the
provider-question task (old T9) are withdrawn. Mode (a)'s subscription path is now
the `runtime` transport: the owner's unmodified official CLI in a per-owner
container. Mode letters follow the founder: (a) the agent in Flux, (b) your agent
app over MCP.

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
  - The status in `decisions.md` changes to Accepted only with a link to that
    review.
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
  - Operator switch `FLUX_AGENT_RUNTIME`, empty by default; the release
    `docker/compose.yaml` does not set it.
  - `runtime-manager` (internal only, service secret) and a label-filtered Docker
    socket proxy under a Compose profile.
  - `ghcr.io/coldphase/flux-agent-runtime` image with a pinned official Codex release. Claude Code is
    not in the image: when the operator enables it, the manager runs Anthropic's
    installer at the tested version, checks the signed manifest and fills a
    read-only tools volume; `DISABLE_UPDATES=1`.
  - Connection transport `runtime` with client `claude_code` or `codex`; one runtime
    per owner (container and volume).
  - Isolation: non-root, read-only root, `cap_drop: ALL`, `no-new-privileges`,
    resource limits, tmpfs `/tmp`, own network, egress allowlist proxy.
  - Fake CLIs and the flag contract test (see [Docker test plan](#docker-test-plan)).
- **Acceptance (Docker):**
  - Switch off: no runtime service starts and the API reports the feature disabled.
  - Two owners get two runtimes. A cannot reach, start or inspect B's runtime by
    any API input.
  - From inside a runtime, the database, Redis, worker, metadata IP and another
    runtime's volume are unreachable.
  - The socket proxy refuses every Docker call outside Flux runtime labels.
  - The flag contract test passes against the pinned real CLIs.

### T4 — Claude Code sign-in console (new issue; minimum viable slice, part 2)

- **Owner:** @PelikanFix16. **Evaluator:** @Zamojski5. **Depends on:** T3.
- **Scope:** Settings → *Agent in Flux* → *Sign in with Claude Code*. xterm.js over
  a session-bound WebSocket to a PTY running only `claude auth login`. Completion
  through `claude auth status`. Display facts only. *Sign out* and *Remove runtime*.
  Settings states the operator can technically access runtime storage.
- **Acceptance (Docker, fake `claude`):**
  - The console shows the CLI's URL; a pasted code reaches the CLI prompt; the
    connection becomes signed in only after `auth status` reports it.
  - The console cannot run any other command. Another member's session cannot
    attach to it.
  - Sign out runs `claude auth logout` and wipes the credential files; Remove
    deletes the container and volume.
  - No setup-token, `auth.json` or session field exists anywhere in the UI or API.
  - Seeded-secret scan: the fake credential never appears in the database, logs,
    frames or API responses.
  - Phone-width layout of the console and the operator-access notice.

### T5 — First owner-invoked run on Claude Code (new issue; minimum viable slice, part 3)

- **Owner:** @PelikanFix16. **Evaluator:** @Zamojski5. **Depends on:** T4.
- **Scope:**
  - Per-run MCP token (owner, connection, run, place; audience Flux MCP; lifetime
    ≤ timeout) and place restriction in the MCP route.
  - `claude -p` adapter to `assistant_run.changed.v1`; final text through the
    personal-run path.
  - Read-only Flux MCP tools only; built-in tools off.
  - Caps: runs per day, one concurrent run, wall-clock timeout, max turns, max
    output bytes. Stop: SIGINT, SIGTERM, kill.
  - Agents view entry "Agent in Flux · Claude Code (your plan)".
- **Acceptance (Docker, fake `claude` making real MCP calls):**
  - A run streams progress and commits an answer only after the access recheck.
  - The run token reads only the run's place, and fails after the run ends.
  - Revoking the connection mid-run makes the next MCP call fail with 403 and ends
    the run.
  - Expired login, plan limit, hang (timeout), crash, oversized output and a
    second concurrent run each end in their own state. None falls back to an API
    key.
  - Stop records requested and acknowledged separately. A broken stream ends
    `unknown`, with no rerun.
  - A background rule cannot select a `runtime` connection.
  - A token-shaped string in CLI output is redacted from logs and errors.

### T6 — Codex in the runtime (new issue)

- **Owner:** @Zamojski5. **Evaluator:** @PelikanFix16. **Depends on:** T5.
- **Scope:** *Sign in with Codex* through `codex login --device-auth` (file
  credential store), `codex login status`, `codex logout`, and the `codex exec
  --json` adapter with `mcp_servers.flux` and `bearer_token_env_var`.
- **Acceptance:** T4 and T5's acceptance repeated with fake `codex`, plus the
  device-code expiry and "device login not enabled" states.

### T7 — Write tools and proposals in runtime runs (new issue)

- **Owner:** @Zamojski5. **Evaluator:** @PelikanFix16. **Depends on:** T5.
- **Acceptance:** a runtime run uses the same Flux MCP write tools as mode (b),
  under the same grant. Consequential changes become proposals. A fake CLI that
  calls a tool outside the grant or place is refused.

### T8 — Later runtime slices (one issue each when picked up)

- `--resume` continuations of a run.
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
  - runtime: Claude Code sign-in, one run, stop and sign-out on a real plan;
  - runtime: the same for Codex on a real ChatGPT plan;
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
  - **Login:** print a URL and wait for a pasted code (Claude), or print a device
    URL and code and poll (Codex). Write `.credentials.json` / `auth.json` into the
    volume. `auth status` then reports `claude.ai` / `chatgpt`.
  - **Run:** emit `system/init` with the MCP server status, make **real** MCP calls
    to Flux with the injected token, then emit deltas and `result` /
    `turn.completed`.
  - **Failures:** expired login, plan limit, hang, crash, SIGINT acknowledgement,
    oversized output, and a token-shaped string in output.
  - **Escape attempts:** read another runtime's path; reach the database or the
    metadata IP. Both must fail.
- **Integration tests with two owners.** A cannot sign in to, run on or see B's
  runtime. A revoked connection gets 403 mid-run. The secret-absence scan passes.
  There is no fallback to API keys.
- **Flag contract test.** Run the pinned real `claude --help` and
  `codex exec --help` in Docker (no account needed) and assert that every flag
  Flux uses exists.
- **Real-account smoke.** Manual and dated (T10), otherwise **unverified**.

## What stays unverified today

- Every real subscription, client and provider check: Claude Code and Codex in the
  runtime, mode (b) Codex and Claude Code, OpenRouter and other provider keys.
- How Anthropic and OpenAI treat a team-hosted runtime in practice. The founder
  accepted this risk ([F-022 accepted risks](../ai-modes.md#accepted-risks)); no
  vendor inquiry is planned.
- Phone/tablet behavior of the new pages. T2 and T4 include phone widths.
