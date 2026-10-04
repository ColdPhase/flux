# F-022 — exactly two AI modes

**Status: Proposed — awaiting peer review.** Owner @Zamojski5 (`claude-maurycy`);
independent evaluator @PelikanFix16. Issue [#245](https://github.com/ColdPhase/flux/issues/245).
Evidence and audit: [two AI modes research](research/2026-10-04-two-ai-modes.md),
retrieved 2026-10-04. Delivery: [plan](research/2026-10-04-two-ai-modes-plan.md).

**Founder clarification, 2026-10-04 (#245).** Flux has exactly two AI integration
modes. Providers, connectors and sign-in methods are choices inside a mode, never
further modes.

This decision refines [F-020](model-providers.md) and supersedes, for the two-mode
framing only, the three-way split in foundation §9.2, the A/B/C modes of the
[own-AI feasibility study](own-ai-feasibility.md) and PROV-4's sentence that a
subscription is usable only through an external client. Everything else in F-019,
F-020 (PROV-1–PROV-6), O-005, O-007, O-008, F-016 and F-018 stays in force.

## AIM-1 — mode 1: your agent app connects to Flux

The person's own agent application runs on their computer under its own account:
Claude Code, Codex or another MCP client. It calls Flux as a remote MCP server
through a Flux-issued OAuth grant ([O-005](first-agent-path.md), [CO-1–CO-5](mcp-cowork.md),
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
  its gates are met it stays unsupported:
  - Channels are a research preview.
  - They need an Anthropic or organization allowlist. On Pro/Max a custom channel
    loads only with `--dangerously-load-development-channels`, which Flux never
    instructs a person to use.
  - A server that negotiates MCP 2026-07-28 cannot deliver channel messages on
    Claude Code's v2 runtime.

  No equivalent push into a person's running Codex is documented, so none is
  claimed.
- **This is where a Claude plan works with Flux.** Anthropic forbids third-party
  products from routing requests through Claude plans (AIM-2 below); the person's
  own, unmodified Claude Code is the supported route.

## AIM-2 — mode 2: the agent in Flux

The person uses the agent from inside Flux: `/ai`, *Ask my assistant*, and owner
background rules. Flux runs its own agent loop through the one runtime port of
[PROV-2](model-providers.md#prov-2--equal-treatment-of-every-model). Each run uses
one **AI connection** that the owner chose (PROV-1).

A connection has a **provider** and a **transport**:

| Transport | Who calls the provider | Credentials held by | Connections available |
| --- | --- | --- | --- |
| `server` | The Flux worker | Flux, encrypted (PROV-4 custody) | API key for `anthropic`, `openai`, `gemini`, `openrouter`, `openai_compatible` (#192). An OpenRouter key may be pasted or obtained through [OpenRouter OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) |
| `companion` | The Flux companion on the owner's computer | The companion, on that computer only | `chatgpt_plan`: the owner's ChatGPT plan through OpenAI's Sign in with ChatGPT plan usage. Off by default; see the AIM-3 status |

**Not available, with the reason:**

| Request | Decision | Evidence |
| --- | --- | --- |
| Claude Free/Pro/Max/Team/Enterprise plan as an AI connection, on any transport | Not offered. Claude in mode 2 uses an Anthropic API key or OpenRouter (Bedrock/Google Cloud would be a later PROV-1 kind); the Claude plan is used through mode 1 | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." (legal page, lastmod 2026-08-21). "Unless previously approved …" (Agent SDK overview, lastmod 2026-09-21) |
| Pasted `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`, a Claude.ai session or a copied `~/.codex/auth.json` | Refused; the UI never asks for one | "developers may not collect, store, or intermediate Claude.ai credentials or session tokens"; Codex CI guide: one machine per `auth.json`, "Do not use this workflow for public or open-source repositories" |
| Companion that drives the unmodified `claude` binary (`claude -p`, Agent SDK) with the owner's login | Not built. It needs Anthropic's written answer first (plan task) | The carve-out covers "an end user … signing in to the unmodified Claude Code binary", but support article 15036540 treats "`claude -p`, and third-party app usage" together, and `--bare` "will become the default for `-p`" and ignores OAuth credentials |
| ChatGPT plan on the `server` transport (Flux server holds the tokens) | Disabled until OpenAI approves Flux through its interest form | "If you're building a paid or remotely hosted app, join the waitlist"; the 127.0.0.1 callback; "Keep tokens out of browser storage" |
| Reusing the Codex CLI's OAuth client or calling `chatgpt.com/backend-api` | Rejected: impersonates another application (foundation §9.4) | SIWC: "do not point it at ChatGPT's backend-api endpoints" |
| Codex app-server auth or `chatgptAuthTokens` hosted by Flux | Rejected | "App-server authentication has never been permitted for commercial or hosted services"; `chatgptAuthTokens` is "FOR OPENAI INTERNAL USE ONLY" |

## AIM-3 — the companion and the ChatGPT plan connection (mode 2)

**Status of this connection.**

- **Inference.** It is a recorded inference ([research §4](research/2026-10-04-two-ai-modes.md#4-findings-for-flux)), not an OpenAI statement, that a local open-source companion serving prompts assembled by a remote Flux fits SIWC's "open-source projects, personal projects that run locally".
- **Switch.** The operator switch for `companion` connections stays **off by default** until OpenAI answers the interest form or an independent peer accepts that inference.
- **Real-account behavior.** This is **unverified** until a dated smoke test.

The companion is a small open-source part of Flux (AGPL, in this repository). The
owner runs it on their own computer. It holds the owner's ChatGPT tokens and serves
only that owner's runs.

1. **Pairing with Flux.** The companion obtains a Flux token through OAuth 2.1 with
   PKCE and a loopback callback, from Flux's existing authorization server.
   - Scope `flux.compute.serve`, audience the Flux companion endpoint.
   - Bound to one owner, one AI connection and one device record (name, first and
     last seen).
   - The owner can revoke it in Flux. The token grants no project access: the
     companion receives only the bounded requests Flux sends it.
2. **ChatGPT sign-in.** On the owner's computer, the companion shows *Continue with
   ChatGPT* and runs OpenAI's flow:
   - `dynamic_agent_client`, PKCE, a 127.0.0.1 callback, and a persisted
     `ext_agent_host_id`.
   - Tokens live in the OS keychain or a `0600` file on that computer, with
     serialized refresh. They are never sent to Flux, logged or put in browser
     storage.
   - Flux stores only display facts the companion reports: plan type, a masked
     account label, and the time of sign-in.
3. **Connection.** The companion keeps one outbound WebSocket to the Flux origin.
   Flux never connects inbound, so a NAT, LAN or VPN install works.
4. **Run.** The worker does everything it does for a `server` connection, then
   hands one bounded request to the companion:
   - Before dispatch it rechecks F-019 ownership, the grant, the sources, consent
     and caps, and assembles the prompt.
   - The request is leased with a fencing generation and an idempotency key.
   - The companion calls `POST https://api.openai.com/v1/responses` with
     `store:false, stream:true` and the owner's chosen model.
   - It streams deltas back and reports usage.
   - The worker parses the output through the same port and rechecks access
     before committing a proposal.
5. **Stop.** Flux sends a cancel. The companion aborts the request and
   acknowledges. Requested and acknowledged are separate states.
6. **Reconnect.** The companion reconnects with the run ID and the lease generation.
   A stream broken mid-run ends `unknown`, and its token reservation stays counted
   (PROV-3). Flux never reruns it automatically; the owner may retry.
7. **Offline computer.**
   - A run on a companion connection waits as *Waiting for your computer* for a
     bounded time (default two minutes), then fails closed with *Your computer
     isn't connected*.
   - Nothing falls back to another connection or payer.
   - Background (unattended) rules cannot use a companion connection. They keep
     `server` connections only (O-007).
8. **Disconnect and revocation.**
   - Removing the connection or the device in Flux revokes the companion token.
   - Sign-out in the companion calls OpenAI's revocation endpoint and deletes the
     tokens.
   - OpenAI "does not currently notify your tool when a user disconnects the app".
     A revoked plan therefore shows on the next run as *Sign in to ChatGPT again on
     your computer*.

**Payer and caps.**

- **Payer.** The payer is the owner's own ChatGPT plan. If the owner selects a
  ChatGPT workspace account, that workspace's policies apply and the owner confirms
  they may use it. Consent names it: "Runs use your ChatGPT plan (account …)."
- **Caps.** There is no per-token price, so PROV-3's money reservation is replaced
  by a daily token cap and a per-run token ceiling, enforced the same way.
- **UI labels.** The UI shows OpenAI's required *Using ChatGPT plan* and a
  *Manage usage* link to ChatGPT Settings → Usage, where the owner sets the per-app
  weekly limit.
- **Limit reached.** `subscription_sharing_usage_limit_exceeded` and other plan
  limits fail closed with a clear state. "OpenAI does not silently switch the request
  to another billing path", and neither does Flux.
- **Eligibility.** Flux does not promise which plans are eligible. OpenAI's
  response decides, and the UI quotes the reason.

**Data.**

- Prompts and answers pass through the companion in memory only. The companion
  keeps no transcript and logs no content by default.
- Audit records the connection, transport, device, model and usage against the
  owner.

## AIM-4 — rules for both modes

These rules apply to both modes; they are not a third mode.

- **One entry point.** *Connect AI* shows both modes side by side: *Your agent app
  (MCP)* and *Agent in Flux*, with its AI connections. The Agents view lists the
  person's mode-1 connections and their agent in Flux. Mode names are product copy;
  vendor names appear only for the chosen client or provider (PROV-2).
- **Owner-only.** F-019 applies to both modes. Membership, mentions or replies
  never invoke or pay for anyone else's agent.
- **Grants and audiences.** The agent's project level is the agent grant ∩ the
  owner's current rights ∩ the requested place, rechecked at every operation.
  Private DMs, other projects and private memory are never loaded implicitly.
- **Explicit payer.** Each run records its payer: the client account (mode 1,
  unknown usage), the key's provider account (`server`), or the ChatGPT plan
  (`companion`). No silent switch between them.
- **Attributable actions.** Every effect records the owner, the agent, the mode
  and the connection or client.
- **No-AI continuation.** Human work continues when any connection is offline,
  revoked, limited or failing.

## Revisit when

- Anthropic documents a supported third-party plan-usage grant, or answers the
  companion question in writing.
- OpenAI changes SIWC scope, or answers the interest form for a self-hosted,
  multi-user Flux.
- Channels leave research preview, or Codex documents a push path.
- Real-account smoke tests contradict any constraint above.
