# Own-AI integration feasibility (draft checkpoint)

**Status: DRAFT — incomplete research checkpoint, not ready for evaluation.**
It preserves evidence gathered so far for [issue #9](https://github.com/ColdPhase/flux/issues/9)
under accepted contract v3 ([comment 5851588690](https://github.com/ColdPhase/flux/issues/9#issuecomment-5851588690)).
Nothing here is a supplier choice, an integration promise, or an accepted O-005 decision.
Every finding below is **preliminary** until the remaining work at the end is done.

**Research / access date:** 2026-09-27.

## Modes assessed

- **A. External official agent → Flux:** the user's own Codex or Claude Code client
  acts on Flux through a Flux-issued, scoped authorization (e.g. a remote MCP server
  with Flux OAuth). Flux never holds the provider credential.
- **B. Agent inside the Flux experience:** Flux starts and shows the agent run itself.
- **C. User/organization API, cloud endpoint or local model:** Flux calls a model
  endpoint with an API key, org-managed cloud credentials, or a self-hosted runtime.

## Preliminary findings (not yet complete; see ledger dates)

| Mode / provider | Preliminary finding | Label | Claim status |
| --- | --- | --- | --- |
| A — Claude Code | Remote MCP over streamable HTTP with OAuth (dynamic client registration, CIMD, or pre-configured client ID/secret); `claude mcp login <name>`; local/project/user scopes; organization-managed MCP config [P5]. | vendor documentation | technical: confirmed; page date: unknown / needs confirmation |
| A — Codex | MCP client supports STDIO and streamable HTTP servers with OAuth (CIMD, DCR), `codex mcp login`, bearer token via env var, tool allow/deny lists [P3]. | vendor documentation | technical: confirmed; page date: unknown / needs confirmation |
| A — Claude apps (custom connectors) | Remote MCP connectors on Free (1 connector), Pro, Max, Team and Enterprise. Owners add them for organizations. Claude connects **from Anthropic's cloud**, so the server must be reachable from the public internet or allowlist Anthropic IP ranges [P7, updated 2026-08-11]. | vendor documentation | conditional: a private self-hosted Flux behind a firewall cannot use this path as is |
| B — Anthropic subscription | Help Center: third-party tools should use API-key auth through Claude Console or a supported cloud provider. Products built "for others" must use API keys. Routing third-party traffic against subscription limits is prohibited [P8, **stale: 2026-05-19**]. Agent SDK plan article: planned credit change paused; SDK, `claude -p` and third-party app usage still draw from subscription limits [P9, **stale: 2026-06-16**]. | vendor terms/help (stale) | **unknown / needs confirmation** under the H2 2026 rule. The stale sources point against an embedded consumer-subscription path. |
| B/C — Claude Code billing | Pro/Max limits are shared across Claude and Claude Code. At the limit a user can buy API credits at API rates, upgrade, or wait. `ANTHROPIC_API_KEY` takes precedence over the subscription [P10, updated 2026-08-19]. | vendor help | confirmed; supports the "no silent billing switch" rule in §5 |
| B — Anthropic Agent SDK | Library that runs the Claude Code binary with its tools, permissions, sessions and hooks inside a process the developer operates [P4]. | vendor documentation | technical: confirmed; permission to use subscription auth for other users: see row above |
| B — Codex | Two sign-in paths: ChatGPT (subscription, workspace RBAC, required for Codex cloud) or API key (usage-based, local workflows, some cloud features unavailable). Enterprise "Codex access tokens" for trusted non-interactive local workflows. Warning not to expose Codex execution in untrusted or public environments [P1]. Codex App Server is an open-source JSON-RPC interface "when you want a deep integration inside your own product", with thread start/resume/fork and approvals [P2]. | vendor documentation | technical: confirmed; permission for a multi-user product to use a user's ChatGPT sign-in: **unknown / needs confirmation**; page dates: unknown |
| C — vLLM | OpenAI-compatible server; `--api-key` / `VLLM_API_KEY`; tool calling requires `--enable-auto-tool-choice` and a parser [P11, file last committed 2026-09-16]. | project documentation | technical: confirmed |
| C — Bedrock / Vertex (Agent Platform) | Claude Code documents Bedrock and Google Cloud Agent Platform (formerly Vertex AI) setup with IAM [P6]. | vendor documentation | pending detail and date |
| C — Ollama, Azure OpenAI, OpenAI API | Not yet assessed in this checkpoint. | — | pending |

## Preliminary source ledger

All accessed 2026-09-27. Dates are the page's visible update date or the repository commit date. "Unknown" means no date was visible, and the source cannot yet support a current claim on its own.

| ID | Source | Date |
| --- | --- | --- |
| P1 | [Codex authentication](https://learn.chatgpt.com/docs/auth) (redirected from developers.openai.com/codex/auth) | unknown |
| P2 | [Codex App Server](https://learn.chatgpt.com/docs/app-server) | unknown |
| P3 | [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | unknown |
| P4 | [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | unknown |
| P5 | [Claude Code MCP](https://code.claude.com/docs/en/mcp) | unknown |
| P6 | [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock), [on Google Cloud Agent Platform](https://code.claude.com/docs/en/google-vertex-ai) | unknown |
| P7 | [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | 2026-08-11 |
| P8 | [Log in to your Claude account](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) | stale: 2026-05-19 |
| P9 | [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | stale: 2026-06-16 |
| P10 | [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) | 2026-08-19 |
| P11 | [vLLM OpenAI-compatible server docs](https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md) | commit 2026-09-16 |


## User experience across the connection lifecycle (AC-3)

Everything in this section is **Flux inference / proposal**. No part of it
describes existing Flux behavior; there is no Flux application yet. It applies
foundation §9.4 (founder direction) to the modes assessed above.

### 5.1 Vocabulary used in this document (provisional)

| Term | Meaning |
| --- | --- |
| **Compute source** | Where model inference is paid for and executed: a personal plan, an organization API account, an org-managed cloud endpoint, or a self-hosted runtime. |
| **Connection** | A configured link between a Flux person or workspace and one compute source or external agent. It has exactly one owner and one scope. |
| **Personal connection** | Owned by one person; usable only for that person's own actions. Never silently shared with a team. |
| **Workspace connection** | Configured by an administrator for an organization-billed source (API key, cloud endpoint, local runtime) with explicit member eligibility and limits. |
| **External agent** | The user's own official Codex or Claude Code client acting on Flux through a Flux-issued, scoped authorization (mode A). |
| **Grant** | The Flux-side permission set given to an external agent or connection: which spaces, which object types, read vs write. |

These terms should be reconciled with the segment/persona glossary from #8 and
the later product-language task before any is treated as final.

### 5.2 States and required behavior

| State | Mode A: external official agent | Mode B: agent inside Flux | Mode C: API / cloud / local | Common rule |
| --- | --- | --- | --- | --- |
| **Connect** | User adds the Flux MCP server URL in their own client; Flux runs its own OAuth consent screen listing the grant (spaces, read/write). Flux never sees the provider credential. | Only paths confirmed as permitted in §3 (API key, org cloud endpoint, local runtime). A consumer-plan sign-in button appears only after the provider's written permission is recorded (see §6). | Admin or user enters a key/endpoint; Flux shows owner, billing account, model list actually returned by the endpoint, and member eligibility. | Show who pays, who owns the connection, and what it can reach **before** the first run. |
| **Normal use** | Agent actions appear in Flux under the agent's identity *and* the human who authorized it; writes go through the same permission checks as a person. | Each run shows its compute source badge (e.g. "Org API — Acme Anthropic account") and the context it received. | Same as B, plus per-workspace limits configured by the admin. | Context passed to a model is limited to the current grant; personal context is never included by virtue of a connection existing. |
| **Limit / exhaustion** | Handled by the user's client; Flux sees only failed or stopped tool calls and keeps partial results as drafts. | Run pauses with a readable reason ("provider limit reached", with provider-reported reset time only if the provider exposes it). Offer: wait, switch to another *already consented* source, or continue manually. | Org budget/limit reached → same pause; admin sees the event. | **No silent switch** from a subscription or free tier to a paid API or another billing account. A switch requires an explicit, per-switch or pre-authorized consent recorded with who approved it. |
| **Revocation / disconnect** | User or admin revokes the Flux grant; outstanding tokens stop working; the agent's past contributions remain attributed. The user can also remove the server in their client. | Disconnect deletes stored credentials; queued runs using it are paused, not re-routed. | Admin rotates/removes key; dependent automations show "compute source unavailable". | Revocation is a normal state with a clear return path, never data loss. |
| **No AI available** | Flux works fully without any external agent. | Conversations, reading, editing, tasks and manual continuation of an agent's partial work remain available. | Same. | Absence of a model never blocks human collaboration (foundation §9.4). |

### 5.3 Private vs shared context

- A personal connection runs with the permissions of its owner, restricted by
  the grant. Its output is private to the owner until the owner shares it,
  unless the run was started in a shared space whose policy says otherwise and
  the user saw that policy at start.
- A workspace connection may run shared automations; the admin defines which
  spaces and roles may use it. Members see that a shared source is used.
- An external agent (mode A) reads only what the Flux grant allows, regardless
  of what the user's own client can see elsewhere.

### 5.4 Cost-consent boundaries

1. Every run records its compute source, billing owner, and initiating person.
2. Changing a run's compute source to a different billing owner or billing
   type (plan → pay-as-you-go API, personal → organization) requires explicit
   consent by someone authorized for the destination account.
3. Admin-defined spend or usage caps for workspace connections; Flux reports
   provider-returned usage where available and labels estimates as estimates.
4. Flux never stores or reuses a consumer-plan session token outside the
   provider's official, permitted mechanism (contract scope: no copying of
   sessions/tokens).

## Remaining work before evaluation

- Find H2 2026 dates for P1–P6. Use the docs' changelogs or git history where they are public; otherwise mark the source unknown.
- Replace or confirm the stale P8/P9 permission statements with H2 2026 sources: current Consumer/Commercial Terms, the Usage Policy, and the Help Center. Run and record a dedicated research pass for this gap, which blocks AC-1/AC-2 for mode B.
- OpenAI: current Terms and Services Agreement and Codex/App Server permission for multi-user products; OpenAI API; Azure OpenAI.
- Ollama (auth and OpenAI-compatible surface), Bedrock/Vertex details, and a "not assessed" list of other providers.
- Community-grounded evidence per the 2026-09-27 founder direction ([comment 5851872685](https://github.com/ColdPhase/flux/issues/9#issuecomment-5851872685)), pending contract v4: dated Reddit, HN, X and GitHub reports on subscription auth in third-party tools, enforcement, and local-model pain. Each point cross-verified and labelled.
- Complete the recommendation, risks, recheck trigger, O-005 open decisions and owners, and architecture/release implications (AC-4).
