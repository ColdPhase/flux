# F-022 — exactly two AI modes

**Status: Accepted, 2026-10-05.** Independently evaluated by claude-maurycy
(@Zamojski5) on 2026-10-05 ([re-review of `ccdb32e2`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6003428258): accept with changes);
N1–N4 applied in `ee216059`, with nits N5–N10. Revised
2026-10-05 twice: under founder direction
[#266](https://github.com/ColdPhase/flux/issues/266) items 11 and 13, then for the
[review of `7a6987e7`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000291729)
and its [wenext prior-art note](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000561858).
**Owner:** @PelikanFix16 (`claude-hubert`). First proposed 2026-10-04 by @Zamojski5
(`claude-maurycy`) on [#245](https://github.com/ColdPhase/flux/issues/245). Approvals
before `7a6987e7` do not cover this revision.

**Evidence:** [agent runtime research](research/2026-10-05-agent-runtime.md),
retrieved 2026-10-05, and the [two AI modes audit and research](research/2026-10-04-two-ai-modes.md),
retrieved 2026-10-04. **Delivery:** [plan](research/2026-10-04-two-ai-modes-plan.md).

**Accepted correction, 2026-10-07:** [#279's independently evaluated operation
contract](https://github.com/ColdPhase/flux/issues/279#issuecomment-6045964415)
adds [durable auth admission and recovery](#durable-auth-operations) to T4.
Earlier source observations stay historical; this records required behavior,
not implementation or full T4 acceptance. The final console belongs in Settings
→ Agents and AI under [#350](https://github.com/ColdPhase/flux/issues/350) /
[F-026](https://github.com/ColdPhase/flux/issues/336).

**Founder direction.**

- **2026-10-04 (#245).** Flux has exactly two AI modes. Providers, connectors and
  sign-in methods are choices inside a mode, never further modes.
- **2026-10-05 (#266 item 11).** (a) The agent in Flux: the user connects their own
  AI subscription (Claude, Codex) as they would in a terminal, but it works inside
  Flux. (b) MCP: the terminal on the user's computer connects to Flux, mainly for
  the Agents view.
- **2026-10-05 (#266 item 13).** Do not send questions to Anthropic or OpenAI about
  subscriptions. Connect it as in a terminal, per Flux instance, as Hermes Agent and
  OpenClaw do.

**What the 2026-10-05 revision changes** (from the 2026-10-04 proposal):

- A Claude plan was "not offered" in the agent in Flux. It is now offered through
  the `runtime` transport ([AIM-3](#aim-3--the-runtime-transport)).
- The ChatGPT plan ran through a companion program on the owner's computer, off
  until OpenAI answered. The companion is withdrawn. The official Codex CLI in the
  owner's runtime replaces it.
- The vendor-question task and every gate on a vendor answer are removed
  ([No vendor inquiry](#no-vendor-inquiry)).
- Modes use the founder's letters. The 2026-10-04 documents call mode (b) "mode 1"
  and mode (a) "mode 2".

**What the review of `7a6987e7` changed:**

- The sign-in console offers every method of the CLIs' own login commands. Refusing
  a pasted setup-token stays, and that tension is recorded (accepted risk 9).
- The accepted risks quote the adverse vendor text, and the rating is now
  medium–high for Claude Code and medium for Codex ([Accepted risks](#accepted-risks)).
- Both CLIs run with every local tool switched off. A read-back fails the run
  closed if any tool remains ([Hardening](#hardening-no-local-tool)).
- A fixed pool of Compose-declared runtime slots, each with a small supervisor,
  replaces the Docker socket proxy. No Flux service has Docker API access
  ([Runtime slots](#runtime-slots-and-the-supervisor), [rejected options](#runtime-orchestration)).

**What the [re-review of `ccdb32e2`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6003428258) changed** (N1–N4 should-fix, N5–N10 nits):

- N1: Codex also switches off hooks, goals, remote plugins and memories. Its
  authoritative check is now the run's own JSONL, not `config/read`.
- N2: Flux never persists, logs or parses a vendor credential. The console relays
  what the owner types at the CLI's own prompt, in memory only.
- N3: the worker, not the manager, reconciles bindings after a restore.
- N4: a released slot's supervisor exits and restarts before the slot is bound
  again, and binding needs a completely empty `/data`.
- N5–N10: one app-server allowlist everywhere, payer labels in the Agents view,
  named networks and slot secrets, binding release, OpenAI's training opt-out, and
  a run token that lists exactly the run's tools.

**Scope.** This decision refines [F-020](model-providers.md). For the two-mode
framing it supersedes:

- the three-way split in foundation §9.2;
- foundation §9.3's condition that a built-in "connect a Claude subscription"
  depends on vendor confirmation or consent (Polish original: *wbudowane „podłącz
  abonament Claude” ma status zależny od potwierdzenia lub zgody dostawcy*).
  Founder direction #266 item 13 removes that condition;
- the A/B/C modes of the [own-AI feasibility study](own-ai-feasibility.md);
- PROV-4's sentence that a subscription is usable only through an external client;
- O-008's blanket rejection of consumer plans, and its "one capped worker request
  per run" for `runtime` runs ([Caps](#caps)).

A plan credential held by Flux stays rejected. Foundation §9.4's first pillar
cannot be met for `runtime` ([Payer and data](#payer-and-data)). F-019, O-005,
O-007, F-016, F-018 and the rest of F-020 stay in force.

## AIM-1 — mode (a): the agent in Flux

The person uses the agent from inside Flux: `/ai`, *Ask my assistant*, and owner
background rules. Each run uses one owner **AI connection** (PROV-1). A connection
has a **transport**. The transport is a property of the connection, not a mode.

| Transport | Who runs the agent loop | Where credentials live | Connections | Uses |
| --- | --- | --- | --- | --- |
| `server` | The Flux worker, through the [PROV-2](model-providers.md#prov-2--equal-treatment-of-every-model) runtime port | Flux, encrypted ([PROV-4](model-providers.md#prov-4--security)) | API key for `anthropic`, `openai`, `gemini`, `openrouter` or `openai_compatible` (F-020, #179/PR #192). OpenRouter may also issue the key through [OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) | Assistant runs and background rules |
| `runtime` | The unmodified official CLI, `claude` or `codex`, in the owner's runtime slot ([AIM-3](#aim-3--the-runtime-transport)) | Only the owner's directory in that slot's volume, written by the CLI | `claude_code` (Claude plan, Anthropic Console API billing or SSO, as the owner signed in) or `codex` (ChatGPT plan or OpenAI API key) | Owner-triggered assistant runs only |

- Nothing falls back from one connection, transport or payer to another. A
  `runtime` run that the CLI reports at a plan limit fails closed. It never retries
  on an API key.
- Background rules (O-007) keep `server` connections. A `runtime` connection cannot
  be chosen for one.

**Not offered, with the reason.** Quotes retrieved 2026-10-05 unless marked.

| Request | Decision | Evidence |
| --- | --- | --- |
| A pasted `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, a claude.ai session, or a copied `~/.codex/auth.json` | Refused. No Flux field accepts one. The tension with the "may not … restrict any authentication method" clause is accepted risk 9 | Anthropic: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." Codex CI auth: "Do not use this workflow for public or open-source repositories", and "only one machine … will use a given auth.json copy". Hermes: refresh tokens are "single-use, rotating" |
| An API key, `apiKeyHelper` or cloud-provider credentials that Flux stores and passes into the runtime | Not offered. Flux injects nothing into the runtime: a key the owner types at the CLI's own prompt (`codex login --with-api-key`) is stored by the CLI's own flow. Flux-held API keys use a `server` connection (F-020, PROV-4 custody) | Flux would hold a second secret per owner outside PROV-4 custody [I] |
| Reusing a vendor's OAuth client ID (Claude Code `9d1c250a…`, Codex `app_EMoam…`) to call model APIs directly, or sending Claude Code headers from another client | Rejected: it impersonates another application (foundation §9.4) | Anthropic support 13189465: "Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited". Sign in with ChatGPT: "do not point it at ChatGPT's backend-api endpoints" (2026-10-04) |
| Vendor tokens held by the Flux server (database, worker, queue), including a server-held Sign in with ChatGPT token or Codex app-server auth hosted by Flux | Rejected | Anthropic: "may not collect, store, or intermediate". OpenAI: "App-server authentication has never been permitted for commercial or hosted services"; `chatgptAuthTokens` is "FOR OPENAI INTERNAL USE ONLY" (2026-10-04) |
| A modified or wrapped Claude Code binary, or one with an authentication method disabled | Rejected | "The Claude Code binary must not be modified … customers may not remove, disable, or restrict any authentication method built into it" |
| Flux, the operator or another member paying for, pooling or triggering an owner's plan usage | Rejected | "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own … Claude subscription plan credentials"; F-019 |
| A `runtime` connection for unattended background rules | Rejected | Anthropic Consumer Terms prohibit access "through automated or non-human means" except by API key or explicit permission; "Advertised usage limits for Pro and Max plans assume ordinary, individual usage". O-007 keeps API keys for background work |

## AIM-2 — mode (b): your agent app over MCP

Unchanged by this revision. The person's own agent application runs on their
computer under its own account: Claude Code, Codex or another MCP client. It calls
Flux as a remote MCP server through a Flux-issued OAuth grant
([O-005](first-agent-path.md), [CO-1–CO-5](mcp-cowork.md),
[CW-1–CW-5](cowork-workflow.md), PROV-5).

- **Who runs the agent:** the client, with its own loop and tools.
- **Who pays:** the client's account (subscription or key). Flux never sees it and
  shows usage as unknown, never as zero.
- **Tokens:** Flux holds only its own grant. Flux tokens are audience-bound to the
  Flux MCP resource. Flux never accepts, stores or forwards a client's provider
  token. MCP 2026-07-28: "The MCP server **MUST NOT** pass through the token it
  received from the MCP client."
- **Requests from Flux to a client.** F-018 addressed requests wait in Flux and
  the client handles them at its next checkpoint (pull). Claude Code Channels are
  the vendor-designed push into a running session ("A channel is an MCP server that
  pushes events into your running Claude Code session"). Flux may add a channel
  plugin as an optional delivery adapter under CO-2's capability contract. Until
  its published conditions are met it stays unsupported:
  - Channels are a research preview.
  - They need an Anthropic or organization allowlist. On Pro/Max a custom channel
    loads only with `--dangerously-load-development-channels`, which Flux never
    instructs a person to use.
  - A server that negotiates MCP 2026-07-28 cannot deliver channel messages on
    Claude Code's v2 runtime.

  No equivalent push into a person's running Codex is documented, so none is
  claimed.
- **Subscriptions.** The client runs under its own login on the person's computer.
  This mode needs no runtime and no operator switch.

## AIM-3 — the `runtime` transport

The owner's own Claude Code or Codex, signed in as in a terminal, runs inside Flux.
This follows the official-binary pattern of OpenClaw's Claude CLI back end and
Hermes' `claude -p` / `codex exec` delegation. It does not follow their
token-reuse paths ([research §1](research/2026-10-05-agent-runtime.md#1-how-hermes-agent-and-openclaw-use-subscriptions)).

### Operator switch and installation

- `FLUX_AGENT_RUNTIME` is empty (off) by default. Its values are `claude_code`,
  `codex`, or both, comma-separated. The release `docker/compose.yaml` does not set
  it. When it is off, no runtime service starts and Settings says the instance has
  not enabled it.
- Enabling it starts the Compose profile `runtime`: `runtime-manager`,
  `runtime-egress`, the runtime slots and, for Claude Code, the one-shot
  `runtime-install`.
- The `ghcr.io/coldphase/flux-agent-runtime` image holds the supervisor and a
  pinned official Codex release (Apache-2.0).
- **Flux does not bundle Claude Code in any image.** When the operator enables
  `claude_code`, `runtime-install` installs Anthropic's official release:
  - at the version Flux's flag contract test covers;
  - checked against Anthropic's signed release manifest. T3 follows Anthropic's
    documented "Verify the manifest signature" steps (the key fingerprint from
    the setup page, then the binary's SHA-256 from the signed manifest) and
    downloads the pinned binary from the same release bucket. It does not pipe
    `install.sh`, which first downloads and runs the latest binary and checks
    only an unsigned checksum;
  - into a tools volume that slots mount read-only, with `DISABLE_UPDATES=1` so it
    stays on that version.
- **Why not bundle it:**
  - Its licence reads "© Anthropic PBC. All rights reserved. Use is subject to
    Anthropic's Commercial Terms of Service." AGPL Flux cannot redistribute it.
  - "Unless we've mutually agreed otherwise, preinstalling or running Claude Code
    in your products or services (e.g. in hosted sandboxes or other agent
    infrastructure) requires agreeing to our Commercial Terms of Service". In a
    self-hosted Flux, the party running it is the instance operator, not the Flux
    project. OpenClaw's Docker image also "does not pre-install Claude Code".
- **Commercial Terms.** The operator must have agreed to Anthropic's Commercial
  Terms with Anthropic itself, for example through an Anthropic Console
  organization. A Flux setting is not that agreement, and the Commercial Terms are
  not for consumer use. Enabling `claude_code` requires a separate operator
  statement that this agreement exists. Flux records the statement and its date;
  it does not verify it.
- **Paid hosting.** A paid hosting service operated by the Flux project
  ([licensing](licensing.md)) keeps the runtime off. There, Anthropic's Commercial
  Terms would bind that operator, and OpenAI sends "a paid or remotely hosted app"
  to its interest form.

### Runtime slots and the supervisor

No Flux service has access to a Docker or Podman API. The review of `7a6987e7`
showed why: a socket proxy that filters by endpoint and label still lets a caller
mount `/`, start a privileged container, create a volume with bind options, `exec`
into any runtime or read its files through the archive endpoint. Each of those is
root on the host or every owner's credentials.

- **A fixed pool.** The release Compose file declares the runtime slots
  `runtime-1` to `runtime-4` from one YAML anchor, under the `runtime` profile. An
  operator adds slots with a Compose override that repeats the documented block.
  The block also attaches `runtime-manager` and `runtime-egress` to the new slot's
  network and adds its secret. Each slot has its own named volume and its own
  network. Every container setting
  is static Compose; nothing at run time can change it.
- **One slot per owner.** The owner's first sign-in binds a free slot to them in
  the database. One slot holds both the owner's Claude Code and Codex logins. When
  every slot is bound, *Agent in Flux* says so; the owner can still use `server`
  connections and mode (b). A workspace role gives no access to any slot.
- **Bindings do not last for ever.** The operator can release a binding (T3: with
  `./flux runtime release runtime-<n>`, because Flux has no in-app instance
  administrator yet); it signs out first, and the owner is told. An optional idle policy
  releases a binding after a set number of days without a run (operator setting,
  off by default; the owner is told first). Without one of these, a pool of four
  fills for good.
- **A binding directory.** The CLIs' homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) live
  in `/data/<binding id>`:
  - the binding id is a UUID, enforced by a database CHECK and in the supervisor;
  - the directory is mode `0700`, and symlinks are rejected;
  - the supervisor refuses to bind while `/data` holds any entry at all;
  - it checks by `stat`, never by reading, that credential files are `0600`.
- **The supervisor** is a small Flux program and the slot's main process.
  - It accepts a closed set of requests: bind, login, status, run, stop, logout
    and release.
  - Each request names a client and a method from a fixed list. It never accepts
    a command line, flag, path or environment variable. A run request carries
    only data: the prompt, the run token, the exact Flux tool names (checked
    against a fixed pattern) and the caps.
  - It builds every CLI command from a fixed template and starts the CLI with a
    clean environment.
  - Before reading its secret or listening it makes itself non-dumpable
    (`PR_SET_DUMPABLE=0`). The CLI's uid cannot read its process environment or write
    its memory. Linux Yama `ptrace_scope` must be at least 1; a missing policy or 0
    refuses startup, leaving the slot unreachable and unavailable to the worker.
  - It accepts only its own slot secret. The launcher generates one secret per
    slot in `docker/.env`; Compose passes each slot only its own, and the manager
    all of them.
- **The manager** (`runtime-manager`) has no database access and no Docker access.
  - It maps owner → slot only from the worker's run record or the owner's own
    session, never from browser input.
  - The worker and API reach it on the `runtime-control` network, with a service
    secret. That network holds only the API, the worker and the manager, not the
    database or Redis.
  - On slot networks it only connects out to supervisors. It listens on none of
    them.
- **Container settings, per slot:** non-root user, read-only root filesystem,
  `cap_drop: ALL`, `no-new-privileges`, no Docker socket, no host mounts,
  `restart: always`. It mounts only its own volume and the read-only tools volume. gVisor (`runsc`) is optional.
- **Limits** (starting values; T3 measures and records them):
  - 2 GiB memory, one CPU, 256 pids, and a 128 MiB tmpfs `/tmp`;
  - container logs rotated at 3 × 10 MB;
  - Docker's local volumes have no size quota, so the supervisor refuses a run
    while the binding directory exceeds 256 MiB;
  - an idle slot runs only the supervisor. A CLI process exists only during a
    sign-in or a run.

### Network

- Each slot's network is `internal: true`. Only that slot, `runtime-manager` and
  `runtime-egress` are on it. No two slots share a network, so slots cannot reach
  each other.
- `runtime-egress` does two things:
  - It is an HTTPS proxy that allows only the vendor hosts each CLI documents.
    Claude Code: `api.anthropic.com`, `claude.ai`, `claude.com` and
    `platform.claude.com`. No primary source lists Codex's OpenAI hosts yet. T6
    records them from the pinned Codex source, and Codex stays off until then.
    The recorded hosts remain reachable during cleanup even after the operator
    turns clients off, so their logout commands can run. Login and runs still refuse
    while disabled. TLS hides paths, so CONNECT cannot restrict this to a logout URL.
  - It is a reverse proxy that forwards only the Flux MCP route (`/mcp`) to the API.
    It reaches the API on the `runtime-api` network, which holds only the API and
    `runtime-egress`. No other API path is reachable. Neither are the database,
    Redis, the worker, the metadata IP or the LAN.
  - It parses only HTTP requests and CONNECT targets. Like the manager's reader of
    supervisor streams, it is size-bounded, minimal and fuzz-tested: these two
    parsers are where a compromised slot would try to pivot.
- `downloads.claude.ai` is allowed only for `runtime-install`, never for a slot.

### Sign-in as in a terminal

1. Settings → *Agent in Flux* → *Sign in to Claude Code* or *Sign in to Codex*
   opens a sign-in console for the owner only. The copy uses the product names as
   plain text, with no vendor logos (the legal page's trademark paragraph).
2. The owner picks a method. The console offers every method of the CLI's own
   login command (CLI reference and Codex auth page, retrieved 2026-10-05):

   | CLI | Method | Command the supervisor runs |
   | --- | --- | --- |
   | Claude Code | Claude account (Pro, Max, Team or Enterprise) | `claude auth login` |
   | Claude Code | Anthropic Console, API usage billing | `claude auth login --console` |
   | Claude Code | SSO | `claude auth login --sso` |
   | Codex | ChatGPT account, device code | `codex login --device-auth` |
   | Codex | OpenAI API key, typed at the CLI's prompt | `codex login --with-api-key` |
   | Codex | ChatGPT Enterprise access token, typed at the CLI's prompt | `codex login --with-access-token`, if the pinned version has it (T6) |

   - Codex's browser-callback login needs `localhost:1455` to be reachable from
     the owner's browser. A remote runtime does not provide that. Codex documents
     device code for a "remote or headless" host, so Flux offers that instead.
   - Device-code login must first be enabled in the owner's ChatGPT security
     settings or by their workspace admin.
   - Flux never sets Codex `forced_login_method`.
   - T4 and T6 read the pinned CLIs' login help and add any further interactive
     method they list.
3. The console is xterm.js over a session-bound WebSocket to the supervisor's PTY.
   The PTY runs exactly the chosen command. It is not a shell. The supervisor
   kills it when the command exits, when the WebSocket closes, or after 15 minutes
   (the lifetime of a Codex device code).
4. **What passes through Flux.** The console relays what the owner types at the
   CLI's own prompt, in memory only. Flux never persists, logs or parses console
   frames.
   - The Claude authorization code, pasted at the CLI's `Paste code here if
     prompted` prompt, passes through Flux's WebSocket and the PTY. It is
     single-use, and it cannot be exchanged without the PKCE verifier, which stays
     in the CLI.
   - A Codex API key or access token typed at the CLI's prompt passes the same
     way.
   - A device code is shown only to the owner and never persisted.
5. Flux detects completion only through `claude auth status` (its JSON
   `authMethod` is `claude.ai`, `api_key`, `oauth_token` and so on) or
   `codex login status`. It stores display facts only: the method, the plan if
   reported, a masked account label and the time.
   - A later sign-in to a different account shows a notice to the owner. A stolen
     Flux session therefore cannot quietly switch the runtime to another account.
   - To tell accounts apart even when their masked labels match, the slot reports a
     digest of the account's address and organization, and Flux keeps only an HMAC
     of it under a key derived from the API's secret: compared, never shown, and
     unable to hold a token (T4, migration 0057).
6. The CLI keeps its login as a file in the binding directory and refreshes it
   itself. For Claude Code that is `CLAUDE_CONFIG_DIR`, with one exception: the keyless Console
   sign-in (Claude Code 2.1.242 and later) keeps an Anthropic profile outside it, by default in
   `$HOME/.config/anthropic`, which is inside the binding directory's `home/`. Sign out and Remove
   delete that profile too, even when the CLI's logout fails (source: Claude Code authentication page,
   read 2026-10-08). For Codex,
   `cli_auth_credentials_store=file` is passed on every Codex command; `auto` and
   `keyring` are refused.

### Durable auth operations

The current owner, binding, client and supervisor boot identify an auth target.
Before status, sign-out or a sign-in console starts, a short PostgreSQL transaction
claims a server-generated operation UUID and monotonic revision. Admission,
heartbeat, ticket consumption and completion are short transactions; external
CLI/PTY/HTTP waits hold no transaction or database connection. Use database wall
time for expiry; an expired heartbeat cannot revive its operation.

- **Exact completion.** Atomically verify the current owner/binding/client,
  operation/revision, active lifecycle and expected boot, update display facts
  and settle the operation. Return explicit `accepted` or `superseded`. A stale
  completion changes neither account notices nor sign-out history. A console
  reports success only for its own accepted operation, never from a newer owner
  view. Preserve the accepted boot through the manager's closed protocol.
- **Physical ordering.** Keep the supervisor's single slot lane. Revalidate
  binding and boot inside the admitted task after queue wait and before effects.
  Neither the browser nor an agent supplies the owner, slot, binding, operation
  epoch or arbitrary command. Later T5/T6 joins this same admission and lane.
- **No TTL takeover.** A timed-out, disconnected, crashed or uncertain operation
  retains a recovery block on its binding. Lease expiry, a row revision, a closed
  API WebSocket or a reported idle slot does not prove an earlier CLI stopped.
  Do not admit another auth command or run on that same binding. The minimal
  recovery is complete release, confirmed empty `/data`, a restarted supervisor
  with a new boot and a fresh binding UUID. Old queued work cannot recreate the
  old directory. If cleanup cannot be confirmed, keep it unavailable/out of pool.
  Disclose that recovery may require both clients to sign in again.
- **Truthful sign-out.** Immediately disable new runtime use for the requested
  client, showing pending rather than confirmed cleanup. Only a current `ok`
  logout plus acknowledged local deletion is confirmed. Completed `failed`,
  `timeout`, `not_installed` and `skipped` retain the vendor-session warning.
  Unknown transport, protocol or cleanup retains disabled authority and recovery
  pending; do not claim deletion, vendor revocation or that nothing changed.
- **Shared lifecycle fence.** Remove, owner deletion, revocation, operator
  release/purge/reset and recovery invalidate auth admission/completion before
  cleanup. Guard obsolete INSERT as well as UPDATE paths. Purge blocks new
  project-wide admission until cleanup is safe; if the database is unavailable,
  stop admission/services first and retain the block. This does not settle other
  separately tracked #331 reconciliation findings.
- **Durable console ownership.** Verify the ticket's HMAC, owner, session, method
  and expiry, then atomically consume its nonce digest and claim the operation.
  Two API instances cannot redeem it twice or own the same client console. Local
  Maps only optimize notifications. Session loss, disconnect and the 15-minute
  timeout invalidate the same operation; replacement requires a real canceled
  and drained PTY acknowledgement, otherwise full recovery. Store metadata only,
  never frames, pasted codes, credentials, raw tickets or session tokens.

T4 must prove held status/console/destructive logout and lifecycle races, two-API
PostgreSQL claim/nonce CAS, crash recovery and late effects after fresh binding
reuse with controlled barriers. Retain its fixed commands, notices, seeded-secret
checks and phone/theme criteria; a passing source or core test is not acceptance
of the integrated runtime or final design.

T4 and the later Codex sign-in are accepted on **mocks and fakes only** (founder direction on #279,
2026-10-08): no test, check or acceptance step uses a real vendor account, subscription or spend, and
actual vendor sign-in, logout and readback are not criteria. The fake `claude` and `codex` print the real
CLIs' streams, messages and exit codes (the `auth login` three lines, the `code#state` paste rule,
`Login successful.`, the status JSON keys, Codex's status and logout on stderr, `Not logged in` with
exit 0), and one assertion table (`apps/runtime/src/contract/auth-table.ts`, with golden `--help` texts)
runs against the fakes in the normal checks and against the pinned real CLIs, account-free in
`docker run --network none`, in the opt-in `scripts/check_runtime_cli_contract.sh`. The real Claude Code
login cannot be redirected to a mock (its OAuth hosts are fixed), so it stays fake-only. The optional
`scripts/check_vendor_live.sh` refuses without `FLUX_LIVE_VENDOR=1` and is in no required check.

### Agent connection and permissions

The MCP route resolves `flux_connection_id` in the agent-connection store, with
its scopes, selected projects and grants. A `runtime` connection therefore gets a
matching agent connection:

- Enabling assistant runs on a `runtime` connection creates an agent connection
  (`agent_connections`) owned by the owner, with a new `compute_source` value,
  `owner_runtime`. Migrations add it to the CHECKs of both `agent_connections` and
  `agent_proposals`. The owner chooses its scopes and projects on the same consent
  screen as a mode (b) client. The first slice allows `flux.context.read` only.
- The worker mints a run token, signed by Flux's authorization server:
  - `flux_connection_id` = that agent connection;
  - `sub` and `flux_owner_user_id` = the owner;
  - `scope` = the agent connection's current scopes;
  - `flux_run_id` and `flux_place`;
  - audience the Flux MCP resource, lifetime no longer than the run timeout.
- The MCP route keeps its checks: the token's owner, and the live connection on
  every request (`app/apps/server/src/agent-connection/mcp-route.ts`). For a token
  with `flux_run_id` it adds two:
  - the run is still running, for this owner and this connection;
  - every tool reads and writes only `flux_place`.
- For a run token, the route lists exactly the run's tools and no others. The
  start-up check in [Hardening](#hardening-no-local-tool) compares against the same
  list, so a wider listing would fail every run.
- The agent's reach is the connection's scopes and projects ∩ the owner's current
  rights ∩ the run's place, as for a mode (b) client. Standing grants (#152) apply
  the same way. Consequential changes become proposals.
- Disabling the use, revoking the `runtime` connection or removing the runtime
  revokes this agent connection in the same transaction.

### Run

1. *Ask my assistant* or `/ai` creates the existing O-008 personal run, with
   consent and owner rechecks.
2. The worker mints the run token and asks the manager to start the run. The
   supervisor passes the token to the CLI in its own environment variable,
   `FLUX_RUN_TOKEN`, never in a file or an argument.
3. The supervisor runs one fixed command. The prompt goes on stdin. Flux's brief
   is appended to the CLI's system prompt and never replaces it, so the run stays
   a Claude Code or Codex session [I].
   - **Claude Code:**
     ```text
     claude -p --output-format stream-json --verbose --include-partial-messages
       --restricted --tools "" --disable-slash-commands
       --strict-mcp-config --mcp-config <tmpfs file: Flux MCP URL, Authorization from FLUX_RUN_TOKEN>
       --allowedTools mcp__flux__<tool> …          (exact names, no wildcard)
       --permission-mode dontAsk --permission-prompts none
       --no-session-persistence --max-turns N --append-system-prompt <brief>
     ```
     with `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `DISABLE_UPDATES=1` and
     `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
   - **Codex:**
     ```text
     codex exec --json --ephemeral --ignore-user-config --sandbox read-only --skip-git-repo-check
       -c cli_auth_credentials_store=file
       -c features.shell_tool=false -c features.unified_exec=false -c features.apps=false
       -c features.multi_agent=false -c features.skill_mcp_dependency_install=false
       -c web_search=disabled -c tools.web_search=false -c tools.view_image=false
       -c features.hooks=false -c features.goals=false
       -c features.remote_plugin=false -c features.memories=false
       -c mcp_servers.flux.url=<Flux MCP route through runtime-egress>
       -c mcp_servers.flux.bearer_token_env_var=FLUX_RUN_TOKEN
       -c mcp_servers.flux.required=true
       -c 'mcp_servers.flux.enabled_tools=["<tool>", …]'   (exact and non-empty)
     ```
4. One adapter per CLI maps its JSONL to the existing owner-only progress events
   (`assistant_run.changed.v1`). The final text is redacted, then commits through
   the personal-run path, shown as "Jo's assistant · asked by Jo".
5. Transcripts are not kept: `--no-session-persistence` for Claude Code and
   `--ephemeral` for Codex. Continuations (T8) need their own decision on where a
   transcript may live.

### Hardening: no local tool

The CLI reads and writes Flux only through the exact Flux MCP tools. It has no
shell, files, web, image, app, sub-agent or other MCP tool.

- **Claude Code** (CLI reference, retrieved 2026-10-05):
  - `--tools ""` removes every built-in tool. `--restricted` also removes the
    tools that run commands or code, and WebFetch. It loads only managed settings
    and `--settings`, so hooks or plugins in the owner's user settings do not
    load. It needs Claude Code v2.1.248 or later.
  - `--strict-mcp-config` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` leave Flux as
    the only MCP server. `--allowedTools` names the exact Flux tools.
    `dontAsk` with `--permission-prompts none` denies anything else.
  - **Read-back.** The adapter reads the first `system/init` event. The run is
    stopped, with no answer committed, if that event lists any tool other than the
    exact Flux tools, or any MCP server other than a connected Flux. The one
    exception is `EndConversation`, which the CLI keeps while MCP tools remain.
    The event's field names are pinned against the real binary in T5
    (**unverified** today).
- **Codex** (config reference, retrieved 2026-10-05):
  - `--sandbox read-only` limits the shell but does not remove it.
    `features.shell_tool` is "stable; on by default". So every local tool is
    switched off by `-c`, as in the command above. That includes `features.hooks`
    (`--ignore-user-config` skips only `config.toml`, not hook files),
    `features.goals` (automatic continuation), `features.remote_plugin` and
    `features.memories`.
  - App and connector traffic is not controlled by the sandbox's network proxy,
    so `features.apps=false` is required.
  - `--ignore-user-config` skips the `config.toml` in the binding directory, so
    every setting comes from the fixed `-c` list. An empty `enabled_tools` is
    refused.
  - The `-c` list switches off only the features known today, so on its own it
    is not proof.
  - **Authoritative check: the run's own JSONL.** The adapter reads every `item.*`
    event of `codex exec --json`. Any item other than an agent message, reasoning,
    or an `mcp_tool_call` to the `flux` server with a tool from the exact list
    stops the CLI at once, and nothing is committed. This is the Codex
    counterpart of Claude Code's `system/init` check. It cannot undo a step that
    has already started, so the overrides stay as the preventive layer.
  - **Optional preflight.** `config/read` returns "the effective configuration on
    disk after resolving configuration layering", from a separate app-server
    process, so it may not reflect `-c`. T6 checks it against the pinned binary,
    which needs no account. Flux keeps it as a blocking preflight only if it
    reflects the overrides; otherwise it is dropped.
  - The app-server client allows only `initialize`, `config/read` and, to confirm
    a plan limit, `account/rateLimits/read`. wenext measured that app-server's
    `command/exec` still runs with the shell flags off.
- **Committed answer.** Before commit, token patterns are removed from the answer:
  `sk-ant-`, `sk-`, JWT-shaped `eyJ…`, `refresh_token`, `access_token`, `id_token`
  and the exact run token. Each match becomes "[removed: looked like a secret]",
  and the run records that it happened. Logs and errors keep their redaction.
- **Criterion.** "No local tool remains" is a T5 and T6 acceptance criterion
  (Claude Code's `system/init` check and Codex's JSONL check, against fakes and
  the pinned real CLIs). T10 adds an adversarial check: a
  real-account run asked to print a credential file or its environment, or to run
  a command, finds no tool for it.
- `FLUX_RUN_TOKEN` in the MCP `Authorization` header: credential variables placed
  in remote MCP `headers` "read as empty" in Claude Code. It is **unverified**
  that a variable with Flux's own name is exempt. T5 checks it; if it reads as
  empty, Flux uses a `headersHelper` instead.

### Caps

For `runtime` connections, PROV-3's money reservation and O-008's "one capped
worker request per run" are replaced by these bounds. The values are starting
values; the owner may lower them.

- Runs per day (default 20).
- One serial lane per slot. Sign-in, status, run and sign-out never overlap,
  which also prevents refresh-token races.
- A wall-clock timeout (default five minutes) and a no-event timeout (default 60
  seconds).
- Maximum turns (default 10). Claude Code uses `--max-turns`; for Codex the adapter
  counts turns and stops the run.
- MCP results: at most 16 KiB per tool result and 64 KiB per run, enforced by the
  MCP route for run tokens. This replaces PROV-3's input bound, because the CLI
  fetches its own context.
- Maximum answer size (16 KiB).

**Plan limits.** When the CLI reports a plan limit, the run ends in its own state,
and nothing falls back to an API key.

- Codex: a text marker, then a confirming `account/rateLimits/read` through the
  same allowlisted app-server client (wenext's two steps).
- Claude Code: the CLI's error result only.
- A limit Flux could not read shows as "unknown", never as zero. Flux does not
  retry before the reset time the CLI reports.

### Payer and data

- **Payer label**, set from the sign-in status and never shown as zero:
  - "your Claude plan (plan limits or paid extra usage, not visible to Flux)";
  - "your ChatGPT plan (plan limits or paid extra usage, not visible to Flux)";
  - "your Anthropic Console organization (API billing, cost not reported to
    Flux)";
  - "your OpenAI API account (API billing, cost not reported to Flux)".
- Anthropic "reserves the right to draw use of such third-party tools from usage
  credits rather than subscription limits". Hermes reports that its path uses only
  paid extra usage. So "fails closed at a plan limit" covers only what the CLI
  reports.
- **Foundation §9.4, first pillar** (the user sees whether a run uses plan limits,
  paid extra usage, an organization's API or a local model) **cannot be met for
  `runtime`.** Settings says so before the owner enables it.
- **Data.** A run sends the requested place's content, including other members'
  messages, to Anthropic or OpenAI under the owner's account settings. Consumer
  plans may train on it unless the owner opted out. Under the Commercial Terms,
  Anthropic "may not train" (as read by the review on 2026-10-05). OpenAI's Terms
  of Use (effective 2026-01-01, Wayback 2026-10-03): "If you do not want us to use
  your Content to train our models, you can opt out…". The O-008 notice and Settings
  show this for `runtime`. Mode (b) has the same property.

### Stop, sign-out and removal

- **Stop:** SIGINT, then SIGTERM after a grace period, then kill. Requested and
  acknowledged are separate states. A broken stream ends `unknown`, with no
  automatic rerun.
- **Sign out** runs `claude auth logout` / `codex logout` first. Then it deletes
  that CLI's files from the binding directory.
- **Remove runtime**, revoking the connection, and deleting the owner each:
  1. run sign-out for every signed-in CLI;
  2. kill in-flight runs, so the next MCP call fails with 403;
  3. delete the binding directory;
  4. the supervisor confirms that `/data` is empty, then exits. The slot's
     restart policy starts a fresh supervisor with an empty tmpfs `/tmp`. If the
     supervisor cannot confirm, the slot stays out of the pool and the operator is
     told;
  5. the slot is free once the new supervisor reports a new boot id and an empty
     `/data`. Flux binds a slot only after that restart.
- If logout fails, for example because the vendor is unreachable, the files are
  still deleted. The owner is told to end the session in their Claude or ChatGPT
  account settings. Whether CLI logout revokes the refresh token at the vendor is
  **unverified** (T10).
- The [auth-operation fence](#durable-auth-operations) distinguishes acknowledged
  non-`ok` cleanup from unknown effects and prevents a delayed status/console or
  old logout from undoing sign-out or acting on a recovered binding.
- A login revoked or expired at the vendor shows *Sign in again* on the next run.

### Backup, restore and cleanup

- `./flux backup` covers the database, the files volume and `docker/.env` only.
  Runtime slot volumes are excluded on purpose, because they hold vendor logins.
  T3 says so in the backup guide.
- A disk-level or host snapshot does capture slot volumes. The operator guide says
  so.
- After a restore, the worker reconciles bindings at start. It reads the bindings
  from the database and asks each slot, through the manager, which binding
  directory it holds:
  - a binding whose directory is missing or signed out shows *Sign in again*;
  - a directory without a binding is signed out (best effort) and deleted, then
    the slot restarts as in a release.
- `./flux reset` and `./flux clean` include the `runtime` profile. They run the
  sign-out step for every binding first (best effort), then remove the slot volumes
  with the project's other volumes. `clean` is the uninstall.
- **Switching off.** With `FLUX_AGENT_RUNTIME` empty, the next `./flux up` stops the
  runtime services. Slot volumes and logins stay, so switching back on restores
  them. Runs refuse with *Off on this instance*. To remove the logins for good, the
  operator runs the launcher's runtime purge step (sign out, then delete the
  volumes; T3 names it).

### Secrets and honesty

- Flux never persists, logs or parses a vendor credential. The login exists only
  in the owner's binding directory, written by the CLI's own flow. It never
  appears in the database, queue payloads, API responses, stream frames, logs,
  exports or the admin UI. The one thing Flux carries is what the owner types at
  the CLI's own sign-in prompt, relayed in memory only (an authorization code, or
  a Codex API key or access token).
- The supervisor runs beside the CLI and could technically read the credential
  files. It never opens them; it only checks their mode and deletes them. The
  instance operator, as host root, can read every slot volume.
- A schema test fails if a runtime table gains a column that could hold a token.
  Only enumerated display facts are allowed (wenext's pattern).
- The manager and supervisor never log PTY or CLI output. Error text is redacted
  (`sk-ant-`, `eyJ…`, `refresh_token` patterns). A seeded-secret absence test
  covers the database, logs and frames (the PROV-4 pattern).
- A login is never copied between slots or binding directories: rotating refresh
  tokens would invalidate each other.
- **What a compromised part can reach.** No Flux service has Docker API access,
  so none reaches root on the host.
  - A compromised manager can drive any bound owner's CLI, spending their plan and
    seeing the outputs. It can watch console input, try to sign a slot into
    another account (the account-change notice mitigates this) and deny service.
    It cannot read credential files or mint MCP tokens.
  - A compromised slot gets that owner's login and the short-lived, place-bound
    run token, and reaches only `runtime-egress`.
- **Settings says, before sign-in:**
  - the instance operator can technically access runtime storage, so an owner
    should sign in only on an instance whose operator they trust;
  - the vendors recommend API keys for products and automation, and may restrict
    this use without notice, possibly on the owner's account (accepted risks 2
    and 5);
  - the API-billing methods in the console are the vendors' recommended choice.

### Operator duties

T3 publishes these as an operator guide in `docs/operations/`.

- **Values and profile:** `FLUX_AGENT_RUNTIME` empty (off), `claude_code`, `codex`,
  or `claude_code,codex`. The launcher then starts the `runtime` profile.
- **No Docker socket** is needed or mounted, so rootless Docker or Podman is not a
  prerequisite. The engine must support `internal` networks, a read-only root
  filesystem, `cap_drop`, `pids_limit` and memory and CPU limits. T3 tests Docker
  Engine; other engines are **unverified**.
- **Sizing:** four slots by default. Per slot: up to 2 GiB memory, one CPU and
  256 MiB of disk for the binding directory, plus the shared tools volume (Claude
  Code's install size, measured in T3). More slots come from the documented
  override, which also attaches `runtime-manager` and `runtime-egress` to the new
  slot's network and adds its secret to `docker/.env`.
- **Bindings:** release idle bindings with `./flux runtime release`, or set the idle policy,
  so the pool does not fill for good.
- **CLI versions:** each Flux release pins the Claude Code and Codex versions that
  its flag contract test passed. `./flux upgrade` reinstalls Claude Code at the
  new pinned version. Nothing updates itself.
- **Anthropic Commercial Terms:** agree with Anthropic first, for example in a
  Console organization. Then set the statement. Flux records it and does not
  verify it.
- **Paid hosting:** keep the runtime off.
- **Access:** the host root can read every owner's vendor login. Owners are told
  so.
- **Backups, snapshots and switching off:** as in
  [Backup, restore and cleanup](#backup-restore-and-cleanup).

## AIM-4 — rules for both modes

These rules apply to both modes; they are not a third mode.

- **One entry point.** *Connect AI* shows both modes side by side: *Agent in
  Flux*, with its connections and each `runtime` sign-in state, and *Your agent app
  (MCP)*. The Agents view lists both, e.g. "Agent in Flux · Claude Code · your
  Claude plan", with the payer label from the sign-in method. Mode names are product copy; vendor names appear only for the chosen
  client or provider (PROV-2).
- **Owner-only.** F-019 applies to both modes. Membership, mentions or replies
  never invoke or pay for anyone else's agent or runtime.
- **Grants and audiences.** The agent's project level is the agent grant ∩ the
  owner's current rights ∩ the requested place, rechecked at every operation.
  Private DMs, other projects and private memory are never loaded implicitly.
- **Explicit payer.** Each run records its payer: the key's provider account
  (`server`), the account the owner signed the CLI into (`runtime`, with the
  labels in [Payer and data](#payer-and-data)) or the client account (mode (b),
  usage unknown). No silent switch between them.
- **Attributable actions.** Every effect records the owner, the agent, the mode,
  the transport and the connection or client.
- **No-AI continuation.** Human work continues when any connection or runtime is
  offline, signed out, limited or failing.

## Accepted risks

These risks are **recorded by the agents under founder direction #266** (items 11
and 13, 2026-10-05). The founder directed the approach and ruled out a vendor
inquiry. The founder did not review this list. Each operator decides for their
instance through `FLUX_AGENT_RUNTIME`. Evidence and analysis:
[research §3.3–3.4](research/2026-10-05-agent-runtime.md#34-risks-stated-without-deciding-them).

**Rating: medium–high for Claude Code, medium for Codex.** The vendor text supports
hosting an owner's own sign-in to the unmodified CLI. It is a stretch for using
that CLI as the headless engine of Flux's own assistant.

1. **Commercial Terms.** "Preinstalling or running Claude Code in your products or
   services … requires agreeing to our Commercial Terms". In a self-hosted Flux the
   operator is plausibly that customer. Mitigation: Flux does not bundle Claude
   Code. The operator must agree with Anthropic and say so before enabling it; Flux
   records only that statement. Paid hosting keeps the runtime off.
2. **Products for others should use API keys.** Anthropic says so in three places
   (quotes as checked by the review on 2026-10-05):
   - support 13189465: "If you're building a product, application, or tool for
     others, use API key authentication through Claude Console or a supported
     cloud provider."
   - the legal page: "Developers building products or services that interact with
     Claude's capabilities… should use API key authentication".
   - the Agent SDK overview: "Unless previously approved, Anthropic does not allow
     third party developers to offer claude.ai login or rate limits for their
     products".

   The legal page's carve-out covers "an end user … signing in to the unmodified
   Claude Code binary … including where a platform hosts Claude Code". Flux hosts
   that sign-in faithfully. But Flux also drives the binary as the engine of its
   own assistant, and offers the owner's plan limits to that feature. The
   carve-out does not clearly reach this [I]. Mitigations:
   - the owner's own sign-in, through the CLI's own flow;
   - every run is triggered by the owner;
   - Flux appends to Claude Code's system prompt and never replaces it;
   - the console offers Console API billing next to the plan;
   - Settings states the risk.

   Residual risk: Anthropic may treat this as the prohibited case and act
   "without prior notice", possibly against the owner's account.
3. **Shared output.** Anthropic prohibits tools that "route third-party traffic
   against subscription limits". An answer posted into a project is read by other
   members. Flux treats this like the owner sharing Claude's output. A member's
   action or mention never triggers another person's runtime (F-019).
4. **Automated use.** Anthropic's Consumer Terms prohibit access "through automated
   or non-human means" except by API key or explicit permission. Plan limits
   "assume ordinary, individual usage". OpenAI's Terms of Use prohibit
   "Automatically or programmatically extract data or Output". `claude -p` and
   `codex exec --json` are the vendors' own documented programmatic interfaces, and
   OpenAI documents running automation as your Codex account. Neither vendor says
   how these product pages relate to its general terms [I]. Mitigation:
   owner-triggered runs only, no background rules, a daily run cap.
5. **OpenAI's automation guidance and hosting wording.**
   - Auth page: "Use API key authentication for programmatic Codex CLI workflows…
     Don't expose Codex execution in untrusted or public environments".
   - Non-interactive page: "API keys are the right default for automation… Use
     this path only if you specifically need to run as your Codex account".
   - App-server authentication "has never been permitted for commercial or hosted
     services". For Sign in with ChatGPT: "If you're interested in offering it in a
     paid or remotely hosted app, complete the interest form."

   Flux runs the plain `codex` CLI with its own login (device code, which Codex
   documents for a "remote or headless" host, or an API key). It uses neither
   app-server authentication nor Sign in with ChatGPT. A team-hosted Flux is
   remotely hosted from the user's point of view, and other members' content is
   untrusted input. The runtime treats it so: no local tools and one isolated slot
   per owner. These pages allow a ChatGPT login for automation only as a
   non-default choice.
6. **Storage on the instance.** The CLI writes the login into a volume on the
   operator's host. Flux never persists, logs or parses it, but a host root can
   read it. Flux relies on the carve-out in risk 2 against "may not collect, store, or
   intermediate" [I]. Settings states the operator's access.
7. **Payer visibility.** Flux cannot see whether a run used plan limits or paid
   extra usage. Foundation §9.4's first pillar is not met for `runtime`
   ([Payer and data](#payer-and-data)).
8. **Training on shared content.** A run sends other members' content under the
   owner's account data settings ([Payer and data](#payer-and-data)).
9. **Sign-in methods.** The legal page: "customers may not remove, disable, or
   restrict any authentication method built into it (including methods that
   permit signing in with a Claude account or the user's own API key)". The console
   offers every `claude auth login` method, including Console API billing and SSO.
   It does not accept a pasted `setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`), because
   that token is a Claude account credential [I], and the same page forbids Flux
   to "collect, store, or intermediate" those. It does not pass an API key, `apiKeyHelper` or cloud
   credentials into the runtime, because `server` connections already carry API
   keys under PROV-4 custody. Whether Anthropic reads this as restricting a method
   is unknown [I].
10. **Change.** Anthropic may enforce "without prior notice". `--bare` "will become
    the default for `-p`", and bare mode "never reads OAuth credentials". Plan
    eligibility can change; the free claude.ai plan has no Claude Code access.
    Codex app-server, used for the optional preflight and the rate-limit check, is
    experimental. Mitigation: pinned CLI versions, a flag contract test, the
    start-up and JSONL checks, and honest *Sign in again* / *Provider refused*
    states.

## No vendor inquiry

- Flux sends no questions to Anthropic or OpenAI about subscriptions. No feature
  waits for a vendor answer (founder direction #266 item 13).
- This replaces the 2026-10-04 plan's provider-question task and the "off until
  OpenAI confirms" gate.
- Flux follows published vendor text. A published change is handled under
  *Revisit when*.

## Rejected options

### Runtime orchestration

| Option | Why rejected |
| --- | --- |
| A label-filtering Docker socket proxy for a manager that creates per-owner containers (the `7a6987e7` design) | Off-the-shelf proxies filter by endpoint, not by request body or label. A caller can create a container with `Binds`/`Mounts` of `/`, `Privileged`, `CapAdd`, host `NetworkMode`/`PidMode` or `Devices`. It can create a volume with `DriverOpts {type:none,o:bind,device:/}`, `exec` into a runtime, or read every owner's credentials with `GET /containers/{id}/archive`. That is root on the host |
| Per-owner containers created on demand through a custom, validating Docker API proxy | It would need exactly the review's list: an endpoint allowlist; create and exec body validation (digest-pinned image; only the owner's volume plus the read-only tools volume; `Privileged=false`, empty `CapAdd`, `CapDrop=ALL`, `no-new-privileges`, `ReadonlyRootfs`; non-root user; runtime network only; resource limits); no volume driver options; no archive, build, pull, plugin or swarm calls; and every container ID in a path carrying the runtime label and the Compose project. That is a security-critical parser of the Docker API, and a socket in the release Compose file. One gap is root on the host. Kept here as the minimum for any later reconsideration |
| A supervisor in each runtime, with a manager limited to lifecycle calls | It removes `exec` and archive reads. But on-demand containers still need `containers/create`, whose body can mount `/`, so it needs the same body validation |
| **A fixed pool of Compose-declared slots, each with a supervisor (chosen)** | Costs: a fixed capacity per instance, an idle supervisor per slot, and a slot reused across owners only after a verified wipe. Gains: no Docker API in Flux at all, and every container setting is static Compose |

### From wenext

The founder pointed to wenext, the founder's other project, as the reference.
@Zamojski5 read it for the review (Codex 0.147.0; no code was run, and wenext's own
notes say no real Codex turn ran in its runtime tests).

**Adopted:** device-code sign-in held by one job for at most 15 minutes and shown
only to the owner; tokens never in the database, enforced by a schema test; one
UUID-named home per binding, `0700` / `0600`, `file` store with `auto` refused;
per-run hardening overrides, plus `tools.view_image=false`; the effective config
read back, here failing closed; a client-side app-server method allowlist;
two-step plan-limit detection with "unknown" never shown as zero; one serial lane
per account; a no-event timeout; runtime homes excluded from backups.

**Not copied:**

- Codex as a subprocess inside the main API container, which holds
  `DATABASE_URL`, both networks and every connection's home, with a capability
  file that carries the database connection string. F-022 keeps one isolated slot
  per owner.
- Organization-shared subscriptions: a connection with `workspace_id NULL` serves
  every member. F-019 rejects that.
- A device code stored in the database and shown to every operator.
- Disconnect without CLI logout, which leaves the vendor session valid.
- Observe or judge turns that override only `mcp_servers={}`, so the shell
  default stays on.
- `forced_login_method="chatgpt"`, which is itself a sign-in restriction.
- No redaction of the committed answer, and persistent threads.

## Revisit when

- Anthropic or OpenAI publish text that removes the official-binary carve-out,
  forbids hosted device-code login, or otherwise forbids this pattern. The affected
  client is then disabled; the `server` transport and mode (b) stay.
- Either vendor publishes text that clearly covers, or clearly forbids, a product
  driving the hosted CLI as its engine (accepted risk 2).
- The flag contract test fails, or `--bare` becomes the default for `-p`.
- The pinned Codex version changes its JSONL item types, or adds a default-on
  local feature that the override list does not switch off. Codex runs stay off
  until the list and the check are updated.
- An isolation, escape or secret-absence test fails.
- The slot pool proves too small and a way to create per-owner containers without
  Docker API access appears.
- Channels leave research preview, or Codex documents a push path (mode (b)).
- Real-account smoke tests contradict any constraint above.
