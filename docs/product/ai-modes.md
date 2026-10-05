# F-022 — exactly two AI modes

**Status: Proposed — awaiting independent peer review** by @Zamojski5. Revised
2026-10-05. **Owner:** @PelikanFix16 (`claude-hubert`), under founder direction
[#266](https://github.com/ColdPhase/flux/issues/266) items 11 and 13. First
proposed 2026-10-04 by @Zamojski5 (`claude-maurycy`) on
[#245](https://github.com/ColdPhase/flux/issues/245). Earlier reviews do not cover
this revision.

**Evidence:** [agent runtime research](research/2026-10-05-agent-runtime.md),
retrieved 2026-10-05, and the [two AI modes audit and research](research/2026-10-04-two-ai-modes.md),
retrieved 2026-10-04. **Delivery:** [plan](research/2026-10-04-two-ai-modes-plan.md).

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

**What this revision changes** (from the 2026-10-04 proposal):

- A Claude plan was "not offered" in the agent in Flux. It is now offered through
  the `runtime` transport ([AIM-3](#aim-3--the-runtime-transport)).
- The ChatGPT plan ran through a companion program on the owner's computer, off
  until OpenAI answered. The companion is withdrawn. The official Codex CLI in the
  owner's runtime replaces it.
- The vendor-question task and every gate on a vendor answer are removed
  ([No vendor inquiry](#no-vendor-inquiry)).
- Modes use the founder's letters. The 2026-10-04 documents call mode (b) "mode 1"
  and mode (a) "mode 2".

**Scope.** This decision refines [F-020](model-providers.md). For the two-mode
framing it supersedes the three-way split in foundation §9.2, the A/B/C modes of
the [own-AI feasibility study](own-ai-feasibility.md), PROV-4's sentence that a
subscription is usable only through an external client, and O-008's blanket
rejection of consumer plans. A plan credential held by Flux stays rejected. F-019,
O-005, O-007, F-016, F-018 and the rest of F-020 stay in force.

## AIM-1 — mode (a): the agent in Flux

The person uses the agent from inside Flux: `/ai`, *Ask my assistant*, and owner
background rules. Each run uses one owner **AI connection** (PROV-1). A connection
has a **transport**. The transport is a property of the connection, not a mode.

| Transport | Who runs the agent loop | Where credentials live | Connections | Uses |
| --- | --- | --- | --- | --- |
| `server` | The Flux worker, through the [PROV-2](model-providers.md#prov-2--equal-treatment-of-every-model) runtime port | Flux, encrypted ([PROV-4](model-providers.md#prov-4--security)) | API key for `anthropic`, `openai`, `gemini`, `openrouter` or `openai_compatible` (F-020, #179/PR #192). OpenRouter may also issue the key through [OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) | Assistant runs and background rules |
| `runtime` | The unmodified official CLI, `claude` or `codex`, in the owner's runtime container ([AIM-3](#aim-3--the-runtime-transport)) | Only that owner's runtime volume, written by the CLI | `claude_code` (the owner's Claude plan) or `codex` (the owner's ChatGPT plan) | Owner-triggered assistant runs only |

- Nothing falls back from one connection, transport or payer to another. A
  `runtime` run that hits a plan limit fails closed. It never retries on an API key.
- Background rules (O-007) keep `server` connections. A `runtime` connection cannot
  be chosen for one.

**Not offered, with the reason.** Quotes retrieved 2026-10-05 unless marked.

| Request | Decision | Evidence |
| --- | --- | --- |
| A pasted `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, a claude.ai session, or a copied `~/.codex/auth.json` | Refused. No Flux field accepts one | Anthropic: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." Codex CI auth: "Do not use this workflow for public or open-source repositories", and "only one machine … will use a given auth.json copy". Hermes: refresh tokens are "single-use, rotating" |
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

- `FLUX_AGENT_RUNTIME` is empty (off) by default. The release `docker/compose.yaml`
  does not set it. When it is off, no runtime starts and Settings says the
  instance has not enabled it.
- Enabling it starts `runtime-manager` and a label-filtered Docker socket proxy
  under a Compose profile.
- The `ghcr.io/coldphase/flux-agent-runtime` image includes a pinned official Codex release
  (Apache-2.0).
- **Flux does not bundle Claude Code in any image.** When the operator enables
  Claude Code, the manager installs it with Anthropic's official installer:
  - at the version Flux's flag contract test covers (the installer accepts a
    version);
  - checked against Anthropic's signed release manifest;
  - into a read-only tools volume, with `DISABLE_UPDATES=1` so it stays on that
    version.
- **Why not bundle it:**
  - Its licence reads "© Anthropic PBC. All rights reserved. Use is subject to
    Anthropic's Commercial Terms of Service." AGPL Flux cannot redistribute it.
  - "Unless we've mutually agreed otherwise, preinstalling or running Claude Code
    in your products or services (e.g. in hosted sandboxes or other agent
    infrastructure) requires agreeing to our Commercial Terms of Service". In a
    self-hosted Flux, the party running it is the instance operator, not the Flux
    project.
  - The switch text names this condition, and enabling Claude Code records the
    operator's acknowledgement. OpenClaw's Docker image also "does not pre-install
    Claude Code".

### Runtime and isolation

- Exactly one runtime per owner: a container `flux-rt-<opaque id>` and a volume
  for the agent home (`.claude`, `.codex`).
- The manager resolves owner → runtime only from the worker's run record or the
  owner's own session, never from browser input. A workspace role gives no access.
- The manager is internal only. The worker reaches it with a service secret.
- The container runs non-root, with a read-only root filesystem, `cap_drop: ALL`,
  `no-new-privileges`, pid/memory/CPU limits and a tmpfs `/tmp`. It has no Docker
  socket and no host mounts. gVisor (`runsc`) is optional.
- Runtimes sit on their own network. They reach only the Flux MCP route and an
  egress proxy that allowlists the vendor hosts the CLIs document (Claude Code:
  `api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com`,
  `downloads.claude.ai`). No database, Redis, worker, metadata IP or LAN.

### Sign-in as in a terminal

1. Settings → *Agent in Flux* → *Sign in with Claude Code* or *Sign in with Codex*
   opens a sign-in console for the owner only.
2. The console is xterm.js over a session-bound WebSocket. It is attached to a PTY
   that runs exactly one command, `claude auth login` or `codex login --device-auth`.
   It is not a shell.
3. The owner sees the CLI's own URL and code.
   - **Claude:** Anthropic's page shows a code. The owner pastes it at the CLI's
     `Paste code here if prompted` prompt, which Claude Code documents for
     containers. The PKCE verifier stays in the CLI.
   - **Codex:** the owner opens the device URL and enters the one-time code. Nothing
     is pasted back. Device-code login must first be enabled in the owner's ChatGPT
     security settings or by their workspace admin.
4. Flux detects completion only through `claude auth status` / `codex login status`.
   It stores display facts only: method, plan if reported, a masked account label
   and the time.
5. The CLI keeps its login as a file in the volume (`CLAUDE_CONFIG_DIR`; Codex
   `cli_auth_credentials_store = "file"`) and refreshes it itself.

### Run

1. *Ask my assistant* or `/ai` creates the existing O-008 personal run, with
   consent and owner rechecks.
2. The worker mints a short-lived JWT from Flux's authorization server:
   - claims `sub` = owner, `flux_connection_id` = the owner's runtime connection,
     `flux_run_id` and `flux_place`;
   - audience the Flux MCP resource; lifetime no longer than the run timeout.
3. The manager starts the CLI in the owner's runtime. The token is passed in its
   own environment variable (`FLUX_RUN_TOKEN`), never written to the volume.
   - **Claude:** `claude -p --output-format stream-json --verbose
     --include-partial-messages --strict-mcp-config --mcp-config <tmpfs file>
     --tools "" --allowedTools "mcp__flux__*" --permission-mode dontAsk
     --max-turns N --session-id <uuid>`, with `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
   - **Codex:** `codex exec --json --ephemeral --sandbox read-only
     --skip-git-repo-check`, with `mcp_servers.flux` set to the Flux URL,
     `bearer_token_env_var = "FLUX_RUN_TOKEN"` and `required = true`.
4. One adapter per CLI maps its JSONL to the existing owner-only progress events
   (`assistant_run.changed.v1`). The final text commits through the personal-run
   path, shown as "Jo's assistant · asked by Jo".
5. Built-in tools are off, so the CLI has no shell, files or web. It reads and
   writes Flux only through Flux MCP tools.

### Permissions equal mode (b)

- The CLI calls the existing MCP endpoint. That route already rechecks the live
  connection on every request (`app/apps/server/src/agent-connection/mcp-route.ts`).
  For a run token it also limits reads and writes to the run's place, and the
  token stops working when the run ends.
- The agent's reach is the grant ∩ the owner's current rights ∩ the run's place,
  as for a mode (b) client. Consequential changes become proposals, as in mode (b).
  The first slice exposes read-only tools.

### Caps

Plans report no token price, so for `runtime` connections PROV-3's money
reservation is replaced by:

- runs per day;
- one concurrent run per runtime (this also prevents refresh-token races);
- a wall-clock timeout (default five minutes);
- maximum turns (Claude `--max-turns`; for Codex the adapter counts turns and
  stops the run);
- maximum output bytes.

Usage shows as "your plan (cost not reported)", never as zero. A plan-limit or
login error fails closed with its own state. There is no fallback to an API key.

### Stop, sign-out and removal

- **Stop:** SIGINT, then SIGTERM after a grace period, then kill. Requested and
  acknowledged are separate states. A broken stream ends `unknown`, with no
  automatic rerun.
- **Sign out** runs `claude auth logout` / `codex logout`, then wipes the
  credential files.
- **Remove runtime** deletes the container and its volume.
- **Revocation.** Revoking the connection or deleting the owner kills in-flight
  runs, makes the next MCP call fail with 403 and deletes the volume.
- A login revoked or expired at the vendor shows *Sign in again* on the next run.

### Secrets and honesty

- Vendor tokens exist only in the owner's runtime volume. They never appear in the
  database, queue payloads, API responses, stream frames, logs, exports or the
  admin UI.
- The manager never logs PTY or CLI output. Error text is redacted (`sk-ant-`,
  `eyJ…`, `refresh_token` patterns). A seeded-secret absence test covers the
  database, logs and frames (the PROV-4 pattern).
- A login is never copied between runtimes: rotating refresh tokens would
  invalidate each other.
- **Settings says** that the instance operator can technically access runtime
  storage, so an owner should sign in only on an instance whose operator they
  trust.

## AIM-4 — rules for both modes

These rules apply to both modes; they are not a third mode.

- **One entry point.** *Connect AI* shows both modes side by side: *Agent in
  Flux*, with its connections and each `runtime` sign-in state, and *Your agent app
  (MCP)*. The Agents view lists both, e.g. "Agent in Flux · Claude Code (your
  plan)". Mode names are product copy; vendor names appear only for the chosen
  client or provider (PROV-2).
- **Owner-only.** F-019 applies to both modes. Membership, mentions or replies
  never invoke or pay for anyone else's agent or runtime.
- **Grants and audiences.** The agent's project level is the agent grant ∩ the
  owner's current rights ∩ the requested place, rechecked at every operation.
  Private DMs, other projects and private memory are never loaded implicitly.
- **Explicit payer.** Each run records its payer: the key's provider account
  (`server`), the owner's own plan (`runtime`, cost not reported) or the client
  account (mode (b), usage unknown). No silent switch between them.
- **Attributable actions.** Every effect records the owner, the agent, the mode,
  the transport and the connection or client.
- **No-AI continuation.** Human work continues when any connection or runtime is
  offline, signed out, limited or failing.

## Accepted risks

Founder direction #266 (items 11 and 13, 2026-10-05) accepts these risks for the
product. They are recorded, not hidden. Each operator decides for their instance
through `FLUX_AGENT_RUNTIME`. Evidence:
[research §3.4](research/2026-10-05-agent-runtime.md#34-risks-stated-without-deciding-them).

1. **Commercial Terms.** "Preinstalling or running Claude Code in your products or
   services … requires agreeing to our Commercial Terms". In a self-hosted Flux the
   operator is plausibly that customer. Mitigation: Flux does not bundle Claude
   Code; the operator installs it through the switch, which names the condition.
2. **Shared output.** Anthropic prohibits tools that "route third-party traffic
   against subscription limits". An answer posted into a project is read by other
   members. Flux treats this like the owner sharing Claude's output. A member's
   action or mention never triggers another person's runtime (F-019).
3. **Automated use.** The Consumer Terms prohibit "automated or non-human means",
   and plan limits "assume ordinary, individual usage". `claude -p` is a documented
   mode. Mitigation: owner-triggered runs only, no background rules, a daily run
   cap.
4. **OpenAI's hosting wording.** App-server authentication "has never been
   permitted for commercial or hosted services". For Sign in with ChatGPT, "If
   you're interested in offering it in a paid or remotely hosted app, complete the
   interest form." A team-hosted Flux is remotely hosted from the user's point of
   view. Mitigation: Flux runs the plain `codex` CLI with its own device-code
   login, which Codex documents for remote and container hosts. It does not use
   app-server authentication.
5. **Storage on the instance.** The CLI writes the login into a volume on the
   operator's host. Flux code never reads it, but a host root can. Flux relies on
   Anthropic's carve-out for "an end user … signing in to the unmodified Claude
   Code binary … including where a platform hosts Claude Code" against "may not
   collect, store, or intermediate" (inference). Settings states the operator's
   access.
6. **Change.** Anthropic may enforce "without prior notice". `--bare` "will become
   the default for `-p`", and bare mode "never reads OAuth credentials". Plan
   eligibility can change; the free claude.ai plan has no Claude Code access.
   Mitigation: pinned CLI versions, a flag contract test, and honest *Sign in
   again* / *Provider refused* states.

## No vendor inquiry

- Flux sends no questions to Anthropic or OpenAI about subscriptions. No feature
  waits for a vendor answer (founder direction #266 item 13).
- This replaces the 2026-10-04 plan's provider-question task and the "off until
  OpenAI confirms" gate.
- Flux follows published vendor text. A published change is handled under
  *Revisit when*.

## Revisit when

- Anthropic or OpenAI publish text that removes the official-binary carve-out,
  forbids hosted device-code login, or otherwise forbids this pattern. The affected
  client is then disabled; the `server` transport and mode (b) stay.
- The flag contract test fails, or `--bare` becomes the default for `-p`.
- An isolation, escape or secret-absence test fails.
- Channels leave research preview, or Codex documents a push path (mode (b)).
- Real-account smoke tests contradict any constraint above.
