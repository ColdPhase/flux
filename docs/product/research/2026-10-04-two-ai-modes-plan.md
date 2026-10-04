# Two AI modes: delivery plan (#245 AC-4)

**Decision:** [F-022](../ai-modes.md), proposed 2026-10-04 and awaiting peer review.
**Evidence:** [audit and research](2026-10-04-two-ai-modes.md).
**Status:** a proposed task list for the orchestrator. No GitHub issue is created
by this document. Owners are proposals: @Zamojski5 (`claude-maurycy`) and
@PelikanFix16 (`claude-hubert` / `codex-hubert`). Each task has one implementation
owner and an independent evaluator who did not write it.

**How every coding task is verified.**

- Run the task's targeted tests and `./scripts/check_application.sh` in Docker, with
  unique `FLUX_TEST_PORT` / `FLUX_TEST_MAILPIT_PORT` and a unique Compose project.
- Use the coordinated serial heavy-test slot.
- Mocks prove regression behavior only. A real client, account or subscription
  check is recorded with date and version, or reported **unverified**.
- No fake client or subscription success.

## Order and dependencies

```text
T0 peer review of F-022 ──┬─> T1 reconcile #192/#212 ──> T6 OpenRouter PKCE
                          ├─> T2 one Connect AI entry
                          └─> T3 companion transport (server) ──> T4 companion app ──> T5 plan UX and caps ──> T10 real ChatGPT smoke
T7 real mode-1 activations (#152 AC-4)       independent
T8 Claude Code channel spike                 after T0; gated, optional
T9 provider questions (non-coding)          independent, start now
T11 issue text updates (#179)                after T0
```

## Tasks

### T0 — Independent review of F-022 (decision)

- **Owner:** @PelikanFix16 (evaluator). **Depends on:** this PR.
- **Acceptance:**
  - A review names the exact head SHA.
  - It checks the quotes against the linked sources and the two-mode mapping.
  - It checks the companion topology and the rejected paths.
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
- **Verification:** the #192 Docker suite (`w192` targets) plus
  `check_agent_setup.py`.
- **Conflict note:** this PR and #192 both edit `model-providers.md` and
  `decisions.md`. Whichever lands second rebases. The F-022 wording wins on
  PROV-4.

### T2 — One *Connect AI* entry for both modes (new issue)

- **Owner:** @PelikanFix16 (owns the #136/#183 Agents view). **Depends on:** T0;
  coordinate with #183 and #192.
- **Acceptance (running app, desktop and phone width):**
  - `/settings/ai` shows two sections: *Your agent app (MCP)*, which lists mode-1
    connections and the client guide, and *Agent in Flux*, which lists AI
    connections, each use's enablement and the payer.
  - Details "Ways to connect" and the ✦ empty state link there.
  - The background-suggestions page links to the connections instead of hosting
    them.
  - The Agents view lists the person's agent in Flux next to their MCP connections,
    with the mode shown.
  - Another member never sees anyone else's connections or keys.
  - No copy says "three ways" or names a vendor that is not the selected one.
- **Verification:** Playwright in Docker for both sections, an owner-only negative
  test (a second member) and a no-AI journey with nothing connected.

### T3 — Companion transport, server side (new issue)

- **Owner:** @Zamojski5. **Depends on:** T0, and T1 merged (connection schema).
- **Scope:**
  - Add `transport` (`server` | `companion`) to AI connections and a
    `companion_devices` record (owner, connection, name, first/last seen,
    revoked).
  - Add OAuth scope `flux.compute.serve` with audience bound to the companion
    endpoint.
  - Add an outbound-only WebSocket endpoint for companions.
  - Add a worker `companion` dispatch in the runtime port, with lease, fencing
    generation, idempotency key, cancel request/acknowledgement, reconnect by run
    ID, bounded *Waiting for your computer* (default two minutes) and fail-closed
    offline.
  - Background rules refuse `companion` connections.
- **Acceptance (Docker integration tests with a fake companion container):**
  - Success streams deltas into the run and commits a proposal only after the
    access recheck.
  - An offline companion ends *Your computer isn't connected* with no fallback.
  - Cancel reaches the companion and the run records both request and
    acknowledgement.
  - A disconnect mid-stream ends `unknown` and keeps the reservation; no automatic
    rerun.
  - A duplicate or late result after a new lease generation is rejected.
  - A revoked device token is refused at the next frame.
  - Another owner's companion can never receive or answer the run.
  - The companion token cannot call any project API.
  - No provider token is ever accepted by Flux (secret-absence scan of DB rows,
    logs and frames).

### T4 — Flux companion app with the ChatGPT plan connection (new issue)

- **Owner:** @Zamojski5. **Depends on:** T3.
- **Scope:** `app/apps/companion`, a Node CLI the owner runs on their computer.
  - Flux pairing (OAuth 2.1, PKCE, loopback).
  - *Continue with ChatGPT* through OpenAI's Sign in with ChatGPT plan usage:
    `dynamic_agent_client`, `127.0.0.1` callback, persisted `ext_agent_host_id`,
    OS keychain or `0600` storage, serialized refresh.
  - `POST /v1/responses` with `store:false, stream:true`; abort on cancel;
    reconnect.
  - Sign-out calls the revocation endpoint and deletes the tokens.
  - No content logging by default.
- **Acceptance (Docker, with a mock OpenAI authorization server and a mock
  Responses stream):**
  - Sign-in stores tokens only on the companion side, with mode `0600`.
  - Refresh is serialized under concurrent runs.
  - Plan limit (`subscription_sharing_usage_limit_exceeded`), 401/expired, revoked
    and network loss map to the port's closed result set.
  - Cancel aborts within one second of the frame.
  - The companion rejects requests for another connection or owner.
  - Tokens never appear in Flux, in frames or in logs (seeded-token scan).
- **Real check:** the companion signs in with a real ChatGPT account and completes
  one run, dated with the Codex/OpenAI versions. This is T10. Until then the
  ChatGPT plan is **unverified**.
- **Gate:** the operator switch for companion connections stays off by default
  until T9's OpenAI answer, or until independent peer acceptance of the recorded
  inference that a local open-source companion is within SIWC's open-source scope.

### T5 — Plan connection UX, consent and token caps (new issue)

- **Owner:** @Zamojski5. **Depends on:** T3, T4; uses T2's page.
- **Acceptance (running app):**
  - Adding a ChatGPT plan connection shows the pairing steps and the companion's
    state (online, last seen).
  - Consent names the payer: "Runs use your ChatGPT plan (account …)".
  - Daily token cap and per-run token ceiling are required to enable a use.
  - Runs show *Using ChatGPT plan* and a *Manage usage* link.
  - Plan limit, expired sign-in and offline computer each show their own state
    and next step.
  - The Claude row explains: "Anthropic doesn't allow other apps to use Claude
    plans. Use your own Claude Code (Your agent app), or an Anthropic API key or
    OpenRouter here."
  - Nothing switches payer.
- **Verification:** Playwright in Docker with the fake companion. Cap-exhaustion
  and payer-label tests. No-AI continuation with the companion offline.

### T6 — OpenRouter OAuth PKCE (new issue)

- **Owner:** @PelikanFix16 (#192 provider author). **Depends on:** T1.
- **Acceptance:**
  - *Connect with OpenRouter* sends the owner to OpenRouter with an S256
    challenge.
  - The callback on the Flux origin is bound to the initiating session, and its
    state is single-use with a ten-minute expiry.
  - The returned key is stored with the existing AEAD custody and never reaches
    the browser.
  - A forged or replayed callback is refused.
  - The pasted-key path still works.
  - The UI says spend limits are managed in OpenRouter settings. Key limits at
    issuance are re-checked and recorded.
- **Verification:** Docker with a mock OpenRouter auth endpoint. A real
  OpenRouter connection is dated, or **unverified**.

### T7 — Real mode-1 activations (existing #152 AC-4, #160)

- **Owner:** #152's owner (@PelikanFix16). **Depends on:** nothing new.
- **Acceptance:** dated records with versions of a real Codex (`codex mcp add …
  --url`, `codex mcp login`) and a real Claude Code (`claude mcp add --transport
  http`, `claude mcp login`) connection, each completing a grant-scoped tool call
  and an F-018 Start/Resume. One other MCP client is used as a smoke test.
  Audience-bound tokens are verified: a Flux token presented with a wrong
  `resource` is refused.
- **Verification:** real clients against a reachable Flux, plus the existing Docker
  MCP suite.

### T8 — Claude Code channel delivery spike (optional, gated; new issue only after T0)

- **Owner:** @Zamojski5. **Depends on:** T0, #153's addressed-request inbox.
- **Acceptance:** a local stdio channel plugin delivers one Flux addressed request
  into a running Claude Code and returns the reply through Flux MCP tools. The test
  uses `--dangerously-load-development-channels` on the developer's own machine
  only. The record covers capability results (delivery, permission relay,
  offline), the 2026-07-28 negotiation caveat and the allowlist requirement. Flux
  copy never tells users to use the development flag. Shipping waits for an
  allowlist route (T9).
- **Verification:** a dated local record. The default product state remains *pull
  at checkpoint*.

### T9 — Provider questions (non-coding; start now)

- **Owner:** @Zamojski5.
- **Questions:**
  - **OpenAI interest form:**
    - Does a self-hosted, open-source, multi-user Flux whose tokens stay in each
      owner's local companion fit "open-source projects"?
    - May a self-hosted Flux server hold SIWC tokens itself?
    - Which plans are eligible?
  - **Anthropic sales:**
    - May an open-source companion drive the person's unmodified Claude Code
      (`claude -p` / Agent SDK) with their own login for Flux requests?
    - Can a Flux channel plugin be added to the Anthropic channel allowlist?
- **Acceptance:** the questions are sent and dated, and the answers (or no answer)
  are recorded in the research document. F-022 is amended only through review.

### T10 — Real ChatGPT-plan smoke test

- **Owner:** @Zamojski5. **Depends on:** T4, T5.
- **Acceptance:** one dated run on a real ChatGPT plan covers sign-in, run, cancel,
  plan-limit display (if it can be observed) and sign-out with revocation. Record
  the account plan type, versions and the observed usage display. Anything not
  observed stays **unverified**.

### T11 — Issue text updates (orchestrator)

- **Owner:** @Zamojski5. **Depends on:** T0.
- **Acceptance:**
  - #179's PROV-4 bullet matches F-022.
  - #152, #153 and #160 each state that they are mode 1.
  - #68 and #58 each state that they are mode 2, with #58 on `server` connections
    only.

## What stays unverified today

- Every real subscription, client and provider check: ChatGPT plan, Codex, Claude
  Code, OpenRouter and other provider keys.
- OpenAI's answer on SIWC scope for a self-hosted, multi-user Flux.
- Anthropic's answer on a companion driving Claude Code, and the Channels allowlist.
- Phone/tablet behavior of the new pages: T2 and T5 include it, and #20 device
  evidence remains separate.
