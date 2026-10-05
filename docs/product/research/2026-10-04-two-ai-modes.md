# Two AI modes: audit and dated research (#245)

**Issue:** [#245](https://github.com/ColdPhase/flux/issues/245), milestone 2.
**Author:** @Zamojski5 (`claude-maurycy`). **Independent evaluator:** @PelikanFix16.
**Retrieved:** 2026-10-04 for every source below, unless a row says otherwise.
**Status:** research input to the proposed [F-022](../decisions.md) decision. It is
not accepted until the independent peer reviews it.

> **Revised 2026-10-05 (founder direction [#266](https://github.com/ColdPhase/flux/issues/266) items 11 and 13).**
> The companion design, "Claude plan not offered" and every gate on a vendor answer
> in this document are replaced by F-022's `runtime` transport: the owner's
> unmodified official CLI in a per-owner container. Evidence:
> [agent runtime research](2026-10-05-agent-runtime.md). The audit (§1) and the MCP
> and OpenRouter evidence below still apply. The founder's 2026-10-05 letters swap
> the numbering used here: mode 1 below is mode (b), mode 2 is mode (a).

**Founder clarification (2026-10-04, #245).** Flux has exactly two AI integration modes:

1. **Your agent app connects to Flux (external local client over MCP).** Codex,
   Claude Code or another MCP client runs on the person's computer under its own
   account and calls Flux through a Flux-issued, scoped grant.
2. **Agent in Flux.** The person connects a subscription capability, OpenRouter, an
   API key or another connector and uses the agent from inside Flux. Providers and
   authentication methods are choices within this mode, not further modes.

**Labels.**
- **[V]** vendor or project claim, quoted verbatim.
- **[O]** observed: something the author or a research pass saw directly, such as
  a sitemap `lastmod`, a commit, a release, an archive capture or a repository file.
- **[R]** press or community report: second-hand, never sufficient alone for a
  permission.
- **[I]** Flux inference.

Nothing below is observed Flux behavior with a real subscription. No real
ChatGPT, Claude, Codex or OpenRouter account was connected for this research.
Every such check is **unverified**.

## 1. Audit (AC-1)

### 1.1 What already fits

The data model already supports two modes on one identity
(observed on `main` `d94f70e4`):

- `agents` (`app/packages/db/src/schema.ts:333`) is one identity table.
- Mode 1 attaches through `agent_connections.agent_id` (`schema.ts:560–576`, compute
  source `user_operated_*`).
- Mode 2 attaches through `personal_run_agents` (`schema.ts:1349`) and
  `personal_runs.agent_id` (`schema.ts:1359`).
- Both read through `project_grants.agent_id`. The agent's project level is
  `LEAST(agent grant, owner's human level)` (`core/access/policy.ts:196–203`).
- `agent.invoke` requires `ownedByCaller && !revokedAt` (`policy.ts:457–463`), so a
  workspace role grants no invocation (F-019). A workspace-owned agent can never
  be invoked (`policy.ts:174`). An assistant run is visible to its owner only
  (`policy.ts:536–547`).
- MCP tokens are bound to the owner: the token `sub` must equal the connection
  owner and the agent owner (`core/agent-connection/connections.ts:51–54`,
  `db/repositories/agent-connections.ts:33–58`). Standing grants need the
  connection's `flux.action.execute` scope and the owner's `project.manage`
  (`apps/server/src/agent-connection/grants.ts:16–18`).

Grants, private/project audiences and owner-only use therefore do not depend on the
mode. Only how compute is attached differs. The two modes keep these roles meaningful.

### 1.2 Mapping to the two modes

| Artifact | Mode | Status (2026-10-04) | Note |
| --- | --- | --- | --- |
| O-005 [first agent path](../first-agent-path.md), #52 | 1 | Accepted, implemented | Claude Code → Flux MCP/OAuth |
| F-016 [CO-1–CO-5](../mcp-cowork.md), #152 | 1 | #152 open; #193, #176, #174, #171 merged | Real Codex and Claude activation evidence still missing (#152 AC-4) |
| F-018 [CW-1–CW-5](../cowork-workflow.md), #160 | 1 | Open; #175, #214 merged | Start/Resume through MCP prompts; addressed requests |
| #153 claims, handoffs, review | 1 | Open; #166 merged | "code/model execution stays in owner clients" |
| PR #183 Agents view (#136) | 1 only | Merged 2026-10-04 as `7a683420` (after this audit's base) | Lists only `agent_connections`. The agent in Flux is absent from the Agents tab |
| O-008 [personal runs](../personal-runs-compute.md), #68 | 2 (owner-invoked) | #68 open; #141 merged | On `main` production composes no connection and no compute, so mode 2 cannot run yet |
| O-007 [background compute](../background-compute.md), #58 | 2 (unattended) | #58 open | Anthropic key only on `main` |
| F-020 [PROV-1–PROV-6](../model-providers.md), #179 | 2 (PROV-1–4, 6) and 1 (PROV-5) | #179 open | PROV-4 sends subscriptions to mode 1 only |
| PR #192 provider adapters | 2 (+ mode-1 guide copy) | Open; takeover fix at `614049b3` awaits fresh review | Five API-key provider kinds; neutral UI; MCP client guide for Claude Code, Codex and other clients |
| PR #212 comparison runtime switch | 2 (unattended) | Open, stacked on #192 | Operator switch `FLUX_BACKGROUND_COMPARISONS` |
| [Own-AI feasibility](../own-ai-feasibility.md) | Defines A/B/C | Dated research, 2026-09-27 | B and C are both mode 2 |
| Foundation §9.2 | Defines three ways | Founder text | Rows 2 and 3 are both mode 2 |
| `Details.tsx:126–129` "Ways to connect" | Both | Two rows | Already two modes; names only Claude Code and an Anthropic key on `main` (fixed in #192) |

### 1.3 Contradictions and the smallest corrections

Live contracts:

| # | Location | Current text | Smallest correction (made in this PR unless noted) |
| --- | --- | --- | --- |
| 1 | `FLUX-FOUNDATION.md` §9.2 | "Trzy sposoby połączenia" (three ways): official tool, agent inside Flux, company/own API or local model | The founder document is preserved as supplied ([README](../README.md)), so it is not edited. The README's current-authority section and F-022 map rows 2 and 3 to mode 2 |
| 2 | `FLUX-FOUNDATION.md` §17E | Asks to consider the official client, the agent inside Flux and own API/local model separately | Covered by the same README note and F-022; prompt E is assessed per connector within mode 2 |
| 3 | `model-providers.md` PROV-4 | "Flux holds no consumer subscription sign-in … A person uses such a subscription through their own external client over MCP (PROV-5)." | Replaced by F-022: a subscription enters mode 2 only through a provider-documented plan-usage grant; Flux never collects consumer sessions |
| 4 | #179 issue body, PROV-4 | Same sentence | Issue text: orchestrator to update after F-022 review (not edited here) |
| 5 | `decisions.md` F-020 | "… no consumer-session keys and fail-closed behaviour remain" | Points to F-022 |
| 6 | `decisions.md` O-008 | "Rejects shared keys, consumer-plan sessions, …" | Points to F-022: a Flux-held session stays rejected; a provider-granted plan connection is reconsidered there |
| 7 | `personal-runs-compute.md` | "Consumer-plan session (Claude.ai/Pro/Max login held by Flux) … Rejected, not deferred." | Dated pointer to F-022 |
| 8 | `background-compute.md` | "Do not accept … a Claude consumer-plan session" | Still right for unattended use. Dated pointer to F-022 |
| 9 | `first-agent-path.md` | "Third-party claude.ai login or routing Free/Pro/Max credentials through Flux is excluded." | Still right for Claude. Dated pointer to F-022 for the two-mode framing |
| 10 | `mcp-cowork.md` | "does not move terminals, agent containers, browsers or provider subscription credentials into the Flux server" | Right, but reads as a product-wide ban. A sentence now marks the section as mode 1 and says mode 2 also keeps subscription credentials off the server |
| 11 | `journeys-and-vocabulary.md` | "No personal subscription, provider login, or embedded run is promised here." | Dated pointer to F-022 |
| 12 | `application-architecture.md` | "an embedded runner, if later approved … provider login, subscription reuse … remain conditional on O-005" | Dated pointer to F-022 |
| 13 | `research.md` | "assess external official agents, embedded execution, and API/local models separately" | Two modes; within mode 2, each connector |

Dated research and supplied references:

| # | Location | Correction |
| --- | --- | --- |
| 14 | `own-ai-feasibility.md` §1 A/B/C, §3, §6.2, §7 ("No consumer-subscription path in Flux for now") | Dated header note: A is mode 1; B and C are mode 2; §7's subscription conclusion is superseded for ChatGPT by F-022 |
| 15 | `docs/design/references/studio-v11.6/supplied/FLUX_MCP_FIRST_RFC_v0.2.md:126` "Wyróżniamy trzy tryby" | Preserved supplied source; not edited. F-022 governs |

### 1.4 UI copy and PRs needing reconciliation

**UI on `main`** (`app/apps/web/src/`), observed:

- `app/Details.tsx:128` "**Claude Code on your computer** — Uses your account for
  compute and your personal Flux grant." and `:129` "**Your assistant in Flux** —
  … with your own Anthropic API key …". Two modes are right; the vendor names are
  stale under F-020. #192 already changes these to "Your MCP client on your
  computer" and "… your own API key from the provider and model you choose".
- `agent-connection/pages.tsx:242–246` shows only `claude mcp add/login`. #192 adds a
  guide for Claude Code, Codex and another MCP client.
- `assistant/AssistantSettings.tsx:64,100,160`, `assistant/ConversationParts.tsx:146`,
  `proactive-comparison/BackgroundComputeSettings.tsx:136–167` name Anthropic or
  Claude Platform only. #192 neutralizes them.

**No code correction in this PR.** The mislabelling is the Anthropic-only wording,
which #192 already replaces. Editing the same files here would conflict with that
open PR. The remaining UI work (one entry point for both modes, the plan
connection) is planned in the [delivery plan](2026-10-04-two-ai-modes-plan.md).

**PR #192 claims to reconcile with F-022:**

- (a) It keeps PROV-4's MCP-only subscription sentence on its branch.
- (b) It flips F-020 in `decisions.md` to "implemented (PR #192)". PROV-5 has no
  real client activation and PROV-6 no real-key smoke test yet, so F-020 is not
  implemented.
- (c) Its provider-terms table in `docs/development/ai-providers.md` concludes
  "Allowed" for OpenAI from the 2026-01-01 Services Agreement PDF. That text is
  current (§2 below) but the conclusion should cite §2.2 and §3.1 explicitly.
  Gemini's paid-key condition for the EEA, Switzerland and the UK is not enforced.
- (d) Its connection model is API-key only. A ChatGPT plan connection needs a new
  connection transport, not a sixth provider kind (F-022).
- (e) AI connections live under the page titled "Your background suggestions",
  which the assistant settings now link to. The two uses need one "AI connections"
  page.

**PR #212:** it inherits #192's framing. F-022 keeps unattended background compute
on key/endpoint connections only, so #212 needs no functional change.

### 1.5 Gaps

1. No recorded two-mode decision or shared vocabulary. "Connection" means two
   tables (`agent_connections` vs provider connections) on two unrelated pages
   (`/connect-agent` vs `/settings/background-compute`).
2. No connector for a subscription in mode 2, and no local companion.
3. No single place that shows both modes. The Agents view omits the agent in Flux.
4. The provider-confirmation follow-ups in [own-AI feasibility](../own-ai-feasibility.md)
   have no owner.
5. Mode 2 cannot run in production on `main` yet (no key custody, provider off).
6. PROV-5 / #152 AC-4 real Codex and Claude activation and PROV-6 real-key smoke
   tests are unrecorded.

## 2. Vendor evidence (AC-2)

### 2.1 Anthropic / Claude

**A third-party product may not route requests through a person's Claude plan.**
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
sitemap lastmod 2026-08-21 [O]. Re-read by the author on 2026-10-04.

- [V] "Anthropic does not permit third-party developers to offer Claude.ai login
  into their own applications, or to route requests through Free, Pro, or Max plan
  credentials on behalf of their users. Moreover, developers may not collect,
  store, or intermediate Claude.ai credentials or session tokens — sign-in to a
  Claude account must complete through Anthropic's own flow."
- [V] "Developers building products or services that interact with Claude's
  capabilities, including those using the Agent SDK, should use API key
  authentication through Claude Console or a supported cloud provider."
- [V] "OAuth authentication is intended exclusively for purchasers of Claude Free,
  Pro, Max, Team, and Enterprise subscription plans and is designed to support
  ordinary use of Claude Code and other native Anthropic applications."
- [V] Carve-out: "Nor does it prevent an end user from signing in to the unmodified
  Claude Code binary with their own Claude subscription, including where a
  platform hosts Claude Code as described under *Can customers offer Claude Code in
  their products?* above."
- [V] That section: "preinstalling or running Claude Code in your products or
  services (e.g. in hosted sandboxes or other agent infrastructure) requires
  agreeing to our Commercial Terms of Service"; "The Claude Code binary must not be
  modified"; "Customers may not pay for, resell, or intermediate Claude usage on
  their end users' behalf."
- [V] "Advertised usage limits for Pro and Max plans assume ordinary, individual
  usage of Claude Code and the Agent SDK."
- [V] "Anthropic reserves the right to take measures to enforce these restrictions
  and may do so without prior notice."
- [O] The carve-out and the "Can customers offer Claude Code" section first appear
  in the Wayback capture of 2026-08-30 and are absent on 2026-08-16. A 2026-03-01
  capture read: "Using OAuth tokens obtained through Claude Free, Pro, or Max
  accounts in any other product, tool, or service — including the Agent SDK — is not
  permitted".

[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), lastmod
2026-09-21 [O]:

- [V] "Unless previously approved, Anthropic does not allow third party developers
  to offer claude.ai login or rate limits for their products, including agents built
  on the Claude Agent SDK. Use the API key authentication methods described in the
  Quickstart instead."

[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
dateModified 2026-06-16 [O]:

- [V] "Update June 15: We're pausing the changes to Claude Agent SDK usage described
  below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and
  third-party app usage still draw from your subscription's usage limits."

[Log in to your Claude account](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account),
dateModified 2026-05-19 [O]:

- [V] "Anthropic may at its discretion allow paid subscribers who have enabled usage
  credits to use certain third-party tools … but reserves the right to draw use of
  such third-party tools from usage credits rather than subscription limits."
- [V] "Developers: If you're building a product, application, or tool for others,
  use API key authentication through Claude Console or a supported cloud provider."

[Consumer Terms](https://www.anthropic.com/legal/consumer-terms), effective
2025-10-08 (current; no newer version on 2026-10-04) [O]:

- [V] "You may not share your Account login information, Anthropic API key, or
  Account credentials with anyone else or make your Account available to anyone
  else."

[Authentication](https://code.claude.com/docs/en/authentication), lastmod 2026-10-01,
and [headless mode](https://code.claude.com/docs/en/headless), lastmod 2026-10-04 [O]:

- [V] `claude setup-token` makes "a one-year OAuth token" that "authenticates with
  your Claude subscription"; it is for "CI pipelines and scripts".
- [V] "In bare mode, Claude Code never reads OAuth credentials or the system
  keychain", and `--bare` "will become the default for `-p` in a future release."
- [V] `--output-format stream-json`, `--input-format stream-json`, `--resume`, and
  interrupt by SIGINT or the SDK's `interrupt()`.

**Official ways to drive the person's own Claude Code from another product:**

- **Remote MCP** ([Claude Code MCP](https://code.claude.com/docs/en/mcp), lastmod
  2026-10-03 [O]): `claude mcp add --transport http`, OAuth 2.0, `claude mcp login`.
  Generally available. This is mode 1.
- **Channels** ([channels](https://code.claude.com/docs/en/channels), lastmod
  2026-10-04; [reference](https://code.claude.com/docs/en/channels-reference),
  lastmod 2026-09-29 [O]):
  - [V] "A channel is an MCP server that pushes events into your running Claude Code
    session … Channels can be two-way: Claude reads the event and replies back
    through the same channel".
  - [V] "A channel is an MCP server that runs on the same machine as Claude Code.
    Claude Code spawns it as a subprocess and communicates over stdio."
  - [V] Research preview; "`--channels` only accepts plugins from an
    Anthropic-maintained allowlist, or from your organization's allowlist if an
    admin has set `allowedChannelPlugins`"; custom channels otherwise need
    `--dangerously-load-development-channels`; "claude.ai Team and Enterprise:
    channels are blocked until an Owner enables them"; "Events only arrive while the
    session is open".
  - [V] (MCP page) "a channel server that negotiates MCP protocol revision 2026-07-28
    can't deliver channel messages" on the v2 runtime.
- **Remote Control** ([remote control](https://code.claude.com/docs/en/remote-control),
  lastmod 2026-10-02 [O]) connects only Anthropic's own surfaces ("claude.ai/code or
  the Claude app") to a local session. No third-party API is documented [I].
- **Routines** ([routines](https://code.claude.com/docs/en/routines), lastmod
  2026-10-03 [O]): a user-created per-routine bearer token can start a cloud session
  on the user's plan. Research preview behind a beta header; runs in Anthropic's
  cloud. Whether a third party may store that token is not addressed [I].
- **Claude in Slack / Claude Tag** ([Slack](https://code.claude.com/docs/en/slack),
  lastmod 2026-09-22 [O]; [Claude Tag](https://claude.com/docs/claude-tag/overview),
  undated): [V] "Each session runs under your own Claude account"; Claude Tag "isn't
  available on individual plans … or for third-party deployments" and "runs in an
  ephemeral sandbox, not on your computer". These are Anthropic's own products, not
  an embedding API.

**Enforcement history (2026):**

| Date | Event | Label |
| --- | --- | --- |
| 2026-01-09 | Anthropic "tightened our safeguards against spoofing the Claude Code harness" ([VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)); OpenCode and Roo users hit "This credential is only authorized for use with Claude Code" | [R]; issues [O] |
| 2026-01-22 | Roo Code PR #10883 "remove Claude Code provider" merged | [O] |
| 2026-03-19 | OpenCode PR #18186 "anthropic legal requests" merged; its docs now say "Anthropic explicitly prohibits this" | [O] |
| 2026-04-04 | "Claude subscriptions will no longer cover usage on third-party tools like OpenClaw" ([TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/)) | [R] |
| 2026-06-15 | Agent SDK billing change paused; `claude -p` and third-party usage still draw from plan limits | [V] |
| 2026-08-30 | Hosting carve-out first seen on the legal page | [O] |

### 2.2 OpenAI / Codex / ChatGPT

**Sign in with ChatGPT (SIWC) plan usage — the documented way for third-party
apps to use a ChatGPT plan.** First archive capture 2026-09-29; cookbook dated
2026-09-28 [O]. Quotes below were re-checked by the author in the raw captures.

- [V] [Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt):
  "At launch, ChatGPT plan usage is available to open-source projects, personal
  projects that run locally, and selected private apps." "If you're building a paid
  or remotely hosted app, join the waitlist to request access before offering it to
  users."
- [V] [Overview](https://developers.openai.com/siwc/token-sharing-open-source): "These
  docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're
  interested in offering it in a paid or remotely hosted app, complete the interest
  form."
- [V] [Quickstart](https://developers.openai.com/siwc/quickstart): "Eligible ChatGPT
  Plus and Pro users can use their ChatGPT plan for AI requests in participating
  apps." "Identity scopes don't grant access to ChatGPT conversations or OpenAI API
  resources. Using a ChatGPT plan requires separate Responses API scopes."
- [V] Mechanism: OAuth with PKCE and `client_id=dynamic_agent_client`, a persisted
  `ext_agent_host_id` per host, scopes `openid profile email offline_access
  resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`.
  "Use an HTTP loopback callback on 127.0.0.1 … Do not substitute with localhost."
  Access token 1 hour; rotating refresh token 30 days; "serialize refreshes".
- [V] Custody: "Keep access, refresh, and retained ID tokens in protected local or
  self-hosted runtime storage. Keep tokens out of browser storage"; files `0600`.
- [V] Inference only on `POST https://api.openai.com/v1/responses` with
  `store:false, stream:true`; "do not point it at ChatGPT's backend-api endpoints".
- [V] Limits: per-app weekly caps set by the user in ChatGPT Settings → Usage; "For
  ChatGPT Plus users, the five-hour usage limit is shared across all apps"; errors
  such as `subscription_sharing_usage_limit_exceeded` (429); "OpenAI does not
  silently switch the request to another billing path"; "OpenAI does not currently
  notify your tool when a user disconnects the app."
- [V] Self-hosted VMs: "A 127.0.0.1 callback reaches the computer running the
  browser, not the remote VM. Complete OAuth locally … Transfer the … credential file
  … over a secure channel such as SSH." "Host-specific usage attribution and
  revocation of ChatGPT plan access for transferred sessions are not yet available."
- [V] UI requirements: the button reads "Continue with ChatGPT"; the app shows "Using
  ChatGPT plan" and a "Manage usage" link.
- [V] [Help article 20001542](https://help.openai.com/en/articles/20001542) (via a
  reader proxy; help.openai.com returned 403): "All users can connect their account
  with supported open source tools. If you are a Plus or Pro user, you can also
  connect your ChatGPT account with eligible commercial tools."
- [O] [Partner list](https://learn.chatgpt.com/docs/sign-in-with-chatgpt): plan usage
  partners include Hermes Agent, Conductor, Warp and others; open-source entries
  include OpenClaw and OpenCode.
- [R] Staff post (Thibault Sottiaux, 2026-09-29): "You can now use your ChatGPT
  subscription directly in over 60 partners products".

**Codex app-server: not a licence for hosted use.**
[App-server docs](https://learn.chatgpt.com/docs/app-server) (redirected from
developers.openai.com/codex/app-server); `codex-rs/app-server/README.md` last
commit 2026-10-01; Codex `rust-v0.160.0` released 2026-10-01 [O].

- [V] "If you've built a local or open-source application using Codex app-server
  authentication, you can continue using it, though we recommend migrating to Sign
  in with ChatGPT … App-server authentication has never been permitted for
  commercial or hosted services."
- [V] "The app-server command and WebSocket transport are experimental and aren't
  supported for production workloads."
- [O] `chatgptAuthTokens` is labelled `[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO
  NOT USE.` in `app-server-protocol/src/protocol/v2/account.rs` (last commit
  2026-09-22).
- [V] Streaming and control: `item/agentMessage/delta`, `turn/completed` with status
  `completed`/`failed`/`interrupted`; cancel with `turn/interrupt`; `turn/steer`;
  reconnect by `initialize` then `thread/resume`.

**Codex authentication** ([auth](https://learn.chatgpt.com/docs/auth), undated;
[CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), undated):

- [V] "Sign in with ChatGPT for subscription access / Sign in with an API key for
  usage-based access."
- [V] "treat ~/.codex/auth.json like a password". The CI guide restricts a copied
  `auth.json` to "trusted private automation", one machine per file, and "Do not use
  this workflow for public or open-source repositories."
- [V] Codex access tokens (Business/Enterprise) are "for trusted, non-interactive
  Codex local workflows" and run "as the token creator".
- [V] [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp): Streamable HTTP, bearer
  token, "OAuth authentication, including Client ID Metadata Documents (CIMD) and
  Dynamic Client Registration (DCR)"; `codex mcp add <name> --url …`, `codex mcp
  login`.

**Terms** (openai.com returned 403; read from Wayback captures [O]):

- [ChatGPT Terms of Use](https://openai.com/policies/terms-of-use/), effective
  2026-01-01, capture 2026-10-03: [V] "You may not share your account credentials or
  make your account available to anyone else".
- [Services Agreement](https://openai.com/policies/services-agreement/), effective
  2026-01-01, capture 2026-09-26: [V] §2.2 "the right to use OpenAI's API to integrate
  the Services into Customer Applications and to make Customer Applications available
  to End Users"; §3.1 "Customer will not share Account access credentials or
  individual login credentials between multiple users."
- [Service Terms](https://openai.com/policies/service-terms/), updated 2026-09-21,
  capture 2026-09-25: [O] no clause specific to SIWC or plan usage found.

**Unofficial pattern seen in other tools.** OpenCode, Cline, OpenClaw and Roo reuse
the Codex CLI's public OAuth client ID (`app_EMoamEEZ73f0CkXaXp7hrann`) against
`chatgpt.com/backend-api/codex/responses` [O, source files]. No OpenAI primary
source sanctions it; SIWC docs say not to use backend-api endpoints [V]. OpenClaw's
"explicitly supported" claim cites no OpenAI source [V/R]. For Flux this is
impersonation of another application, which foundation §9.4 excludes [I].

### 2.3 OpenRouter

[OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) (undated; read through
a fetch summary, so paraphrase-grade):

- Redirect to `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256`,
  then `POST https://openrouter.ai/api/v1/auth/keys` with the code and verifier,
  which returns a "user-controlled API key". Codes expire after 10 minutes.
- "Store the API key securely within the user's browser or in your own database".
- **Unknown:** spend limits or expiry set at issuance, and a revocation API. The user
  manages keys in OpenRouter settings.

[I] This is an ordinary per-user API key obtained by an official flow, so it fits
PROV-1 custody unchanged. The callback can return to the Flux origin.

### 2.4 MCP authorization (spec 2026-07-28)

[Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
released 2026-07-28 [O]:

- [V] "The MCP server **MUST NOT** pass through the token it received from the MCP
  client." "MCP servers **MUST NOT** accept or transit any other tokens."
- [V] Clients "**MUST** implement and use the `resource` parameter"; servers "**MUST**
  only accept tokens specifically intended for themselves".
- [V] Protected Resource Metadata (RFC 9728) is required; registration order is
  pre-registration, then CIMD, then DCR; PKCE with `S256` is required.

## 3. Comparable products

All retrieved 2026-10-04. Mechanisms for ChatGPT plans: **A** reuses the Codex CLI's
public client against `chatgpt.com/backend-api`; **B** is SIWC; **C** spawns the
official CLI, app-server or an ACP adapter under the user's own login.

| Product | Subscription connection | API key / OpenRouter | Execution | Users | Token custody | Terms / enforcement | Streaming / cancel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/integrations/providers) (v2026.9.24) | Codex: device code or PKCE, imports `~/.codex/auth.json`; listed as a SIWC partner. Claude: OAuth that "routes as Claude Code" and "only works on a Claude Max plan with purchased extra usage credits" | Keys; OpenRouter key or OpenRouter PKCE | Owner's machine or server; messaging gateway | One owner; allowlisted chat users share the owner's credentials [I] | `~/.hermes/auth.json`, `.env` | Claude path is a project claim against Anthropic's text | Per-platform streaming; `/stop` |
| [OpenClaw](https://docs.openclaw.ai/concepts/oauth) (v2026.9.8) | Codex: A (PKCE on 1455 or device code); listed as a SIWC open-source partner. Claude: reuse the host's Claude Code login / `claude -p`, or a setup-token | Keys per profile | One Gateway per host | Multi-user mode is "one trust domain" | SQLite, identity-scoped records | Per-person accounts: "Anthropic accepts an API key for personal setup, not a Claude subscription token." "Anthropic staff told us this usage is allowed again" (no source) | WebSocket events |
| Cline | Claude: spawns the local `claude` CLI. Codex: A (`originator=cline`) | Keys; OpenRouter key | User's machine | Single | Claude login stays in the CLI | None stated | Claude mode "may not stream token-by-token" |
| Roo Code (archived) | Claude provider removed 2026-01-22; ChatGPT: A | Keys | User's machine | Single | VS Code SecretStorage | Hit the 2026-01-09 enforcement | n/a |
| [Zed](https://zed.dev/docs/ai/external-agents) (ACP) | C: "Claude Agent owns its own authentication and billing"; same for Codex | Agent-native | Local subprocess; ChatGPT login "doesn't work in remote projects" | Single | Agent's own store; Zed holds nothing | Matches the Anthropic carve-out pattern [I] | ACP `session/update`, `session/cancel`, load/resume |
| Goose | C via ACP; old CLI providers deprecated | Keys | Local | Single | Vendor CLI | None | ACP; "No session fork or resume" |
| OpenHands | SDK: OpenAI subscription OAuth (`~/.openhands/auth/`). Agent Canvas: C via ACP, reusing the host's CLI login | Keys as server secrets | Agent server host; a cloud sandbox needs an API key | One login per server [I] | Vendor CLI stores | — | ACP relay |
| OpenCode | ChatGPT: A. Claude: removed in 1.3.0 | Keys; OpenRouter key | Local | Single | `~/.local/share/opencode/auth.json` | PR #18186 "anthropic legal requests" | — |
| [Happy](https://github.com/slopus/happy) | C: wraps the local `claude`/`codex` (Agent SDK, ACP) | Agent-native | User's machine; relay for sync | Single user, many devices | Vendor login local; relay sees encrypted blobs | — | Real-time WebSocket |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | C: local agents | Agent-native | Each member's machine; shared cloud plus relay | Team board, local agents | Vendor CLI stores | — | — |

**Patterns** [O/I]:

1. **Local agent, remote UI.** Zed, Goose, OpenHands (local), Happy and Vibe Kanban
   run the official agent on the user's machine under the user's own login; the UI
   or server never stores vendor tokens. For Claude plans this is the only pattern
   that matches Anthropic's carve-out.
2. **Apps that collected Claude plan OAuth were broken or withdrawn** (OpenCode,
   Roo). Those still offering it rely on unsourced assurances (OpenClaw) or extra
   usage billing (Hermes).
3. **Shared servers use API keys for Claude.** OpenClaw's multi-user gateway offers
   per-person ChatGPT sign-in but only API keys for Anthropic.
4. **ChatGPT plan support is broad but mostly unofficial (A).** SIWC (B) is now the
   documented route, scoped to open-source and local apps.
5. **OpenRouter PKCE** gives a user-controlled key suited to a multi-user server.
6. **Custody guidance converges:** owner-only files or OS keychain, never browser
   storage, rotating refresh tokens with serialized refresh, revocation at sign-out.

## 4. Findings for Flux

1. **Claude plan in mode 2: not permitted.** A Flux-built agent loop on a Claude
   plan "route[s] requests through Free, Pro, or Max plan credentials on behalf of
   their users" and needs approval under the Agent SDK note. Claude in mode 2 uses an
   Anthropic API key, a supported cloud provider or OpenRouter. A Claude plan is used
   with Flux through the person's own Claude Code in mode 1.
2. **A local Flux bridge running `claude -p` is not a supported connector.** The
   support article groups "`claude -p`, and third-party app usage" together; the
   April 2026 change [R] targeted that pattern; `--bare` will become the `-p` default
   and ignores OAuth credentials. The carve-out covers the unmodified binary, but
   whether a Flux component driving it counts as "route requests … on behalf of their
   users" is unresolved. It needs Anthropic's written answer before any promise.
3. **Channels are the Anthropic-designed way to push Flux requests into a running
   Claude Code.** They belong to mode 1, as delivery for F-018 addressed requests,
   gated by research preview, the allowlist and the 2026-07-28 negotiation caveat.
4. **ChatGPT plan in mode 2: supported through SIWC, with a local component.** The
   127.0.0.1 callback, the ban on browser storage and the "remotely hosted → waitlist"
   rule mean the tokens must live on the person's computer, in an open-source Flux
   companion. Whether a companion that serves prompts assembled by a remote Flux
   server counts as "locally hosted open-source" is **[I], unresolved**; OpenAI's
   interest form is the route to confirm it and to enable a server-held variant.
5. **Rejected for ChatGPT:** reusing the Codex CLI client ID (impersonation),
   `chatgptAuthTokens` ("internal use only"), and Flux-hosted app-server auth ("never
   been permitted for commercial or hosted services").
6. **OpenRouter PKCE** is a clean server-side way to obtain the key.
7. **Mode 1 must keep audience-bound Flux tokens** and never forward a client's token
   upstream (MCP 2026-07-28).

## 5. Source ledger

| Source | Page date | Notes |
| --- | --- | --- |
| [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | lastmod 2026-08-21 | Re-read 2026-10-04; Wayback 2026-03-01, 2026-08-16, 2026-08-30 |
| [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | lastmod 2026-09-21 | |
| [Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting) | lastmod 2026-09-28 | API key is the only Anthropic credential path documented |
| [Authentication](https://code.claude.com/docs/en/authentication) | lastmod 2026-10-01 | |
| [Headless](https://code.claude.com/docs/en/headless) | lastmod 2026-10-04 | |
| [Claude Code MCP](https://code.claude.com/docs/en/mcp) | lastmod 2026-10-03 | |
| [Channels](https://code.claude.com/docs/en/channels), [reference](https://code.claude.com/docs/en/channels-reference) | lastmod 2026-10-04 / 2026-09-29 | Research preview |
| [Remote Control](https://code.claude.com/docs/en/remote-control) | lastmod 2026-10-02 | |
| [Routines](https://code.claude.com/docs/en/routines) | lastmod 2026-10-03 | Research preview |
| [Claude Code in Slack](https://code.claude.com/docs/en/slack) | lastmod 2026-09-22 | |
| [Claude Tag](https://claude.com/docs/claude-tag/overview) | undated | Public beta |
| [Support 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | 2026-06-16 | |
| [Support 13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) | 2026-05-19 | Older than H2 2026; consistent with the 2026-08-21 legal page |
| [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms) | effective 2025-10-08 | Current version |
| [SIWC cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) | 2026-09-28 | Raw capture re-checked |
| [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), [quickstart](https://developers.openai.com/siwc/quickstart) | first capture 2026-09-29 | |
| [SIWC partners](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) | undated; observed 2026-10-04 | |
| [Codex app-server](https://learn.chatgpt.com/docs/app-server) | README commit 2026-10-01 | Codex 0.160.0 |
| [Codex auth](https://learn.chatgpt.com/docs/auth), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) | undated | Anchored to Codex 0.160.0 (2026-10-01) |
| [ChatGPT Terms of Use](https://openai.com/policies/terms-of-use/) | effective 2026-01-01 | Wayback capture 2026-10-03 |
| [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) | effective 2026-01-01 | Wayback capture 2026-09-26 |
| [OpenAI Service Terms](https://openai.com/policies/service-terms/) | updated 2026-09-21 | Wayback capture 2026-09-25 |
| [OpenRouter OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) | undated | Fetch summary only |
| [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | 2026-07-28 | |
| [Hermes providers](https://hermes-agent.nousresearch.com/docs/integrations/providers) | doc commit 2026-10-01 | |
| [OpenClaw OAuth](https://docs.openclaw.ai/concepts/oauth) | doc commits 2026-09-29 to 2026-10-02 | Also `providers/anthropic.md`, `concepts/multi-user.md` |
| [Zed external agents](https://zed.dev/docs/ai/external-agents), [ACP](https://agentclientprotocol.com/protocol/prompt-turn) | undated; ACP schema v1.24.1 2026-09-30 | Fetch summary for Zed |
| [OpenCode PR #18186](https://github.com/anomalyco/opencode/pull/18186) | 2026-03-19 | |
| [Roo Code PR #10883](https://github.com/RooCodeInc/Roo-Code/pull/10883) | 2026-01-22 | |
| [TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/), [VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses) | 2026-04-04 / 2026-01-09 | Press [R] |

**Not retrieved:** openai.com announcement pages (HTTP 403, no archive copy);
help.openai.com directly (HTTP 403; read through a reader proxy); the original X
posts behind the press reports.
