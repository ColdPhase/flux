# Own-AI integration feasibility (O-005 recommendation)

**Status:** O-005 recommendation for independent agent evaluation. This is feasibility research, not a supplier choice, an integration promise or an accepted decision. Under the [founder delegation](autonomy.md), the decision belongs to the agents after peer review.

> **2026-10-04 reconciliation, revised 2026-10-05 ([F-022](ai-modes.md), proposed).** Flux has exactly two AI modes. Mode A below is mode (b), your agent app over MCP; modes B and C are both mode (a), the agent in Flux. §7's "no consumer-subscription path" is superseded: an owner's Claude or ChatGPT plan works in mode (a) only through the unmodified official CLI in the owner's runtime, under the owner's own sign-in. Flux still never holds plan credentials. Fresh evidence: [agent runtime research](research/2026-10-05-agent-runtime.md) and [two AI modes research](research/2026-10-04-two-ai-modes.md).

**Contract:** [issue #9, accepted v4](https://github.com/ColdPhase/flux/issues/9#issuecomment-5851902448), accepted in [5851917250](https://github.com/ColdPhase/flux/issues/9#issuecomment-5851917250).
**Research / access date:** 2026-09-27 for every source below.
**Labels:** *vendor claim* (provider documentation or terms), *observed* (something the author checked directly, such as a repository date or an API response), *community report (unverified / corroborated)*, and *Flux inference*. No Flux application exists, so no row is observed Flux behavior. This repository's developer harness, which runs personal Codex/Claude CLIs, is not evidence for product integration.

## 1. Modes

- **A. External official agent → Flux.** The user's own Codex, Claude Code, ChatGPT or Claude app acts on Flux through a Flux-issued, scoped grant, for example a remote MCP server with Flux OAuth. Flux never holds the provider credential.
- **B. Agent inside the Flux experience.** Flux starts, shows and resumes the agent run itself.
- **C. User/organization API, org-managed cloud endpoint, or self-hosted model.** Flux calls a model endpoint with an API key, cloud credentials or a local runtime, and runs its own agent loop.

## 2. Summary

| Path | Technical feasibility | Permission to offer | Status for Flux |
| --- | --- | --- | --- |
| A via Claude Code / Codex CLI + Flux remote MCP | Claude Code: confirmed [P5]. Codex CLI: vendor-documented on an undated page → `unknown / needs confirmation`; dated client OAuth bugs show the flow in use [K11] | Claude Code: confirmed, since Flux offers no Anthropic login [P1]. Codex CLI: Flux inference (Flux holds no OpenAI credential); current OpenAI terms `unknown` [P16] | **Recommended first path**; the Codex flow must pass Flux's own login test |
| A via Claude or ChatGPT apps (custom connectors) | confirmed | confirmed, with plan and admin conditions | Conditional: Anthropic's or OpenAI's cloud must reach the Flux server |
| B with an Anthropic API key or cloud provider (Bedrock, Google Cloud Agent Platform, Foundry), via Agent SDK or Managed Agents | confirmed | confirmed | Available path, billed to the key owner |
| B with the **unmodified Claude Code binary**, where each user signs in to their own subscription through Anthropic's flow | confirmed | **conditional**: needs Commercial Terms, no intermediating, and a direct confirmation for a self-hosted OSS product | Do not ship until confirmed in writing |
| B with Flux offering claude.ai login, or routing through a user's Free/Pro/Max plan | possible | **not permitted** | Rejected |
| B with the OpenAI Agents API (managed Codex harness) and a Platform API key | confirmed (public beta since 2026-09-10) [P15] | `unknown / needs confirmation`: the current OpenAI Services Agreement was not readable (HTTP 403) [P16] | Candidate after the terms re-read; US-only residency and no ZDR |
| B with a user's ChatGPT sign-in (Codex App Server `chatgptAuthTokens`) | **unknown / needs confirmation** (undated page; experimental by its own wording) | **unknown / needs confirmation**; ToU text points against it | Not offered |
| C with an OpenAI / Anthropic / Azure API key or an org cloud endpoint | confirmed | Anthropic: confirmed [P1]. OpenAI and Azure: `unknown / needs confirmation` (no H2 2026 terms text verified) [P16][P17] | Anthropic available; OpenAI and Azure after the terms re-read |
| C with Ollama / vLLM on a private network | confirmed | open source; no provider terms | Available, as a degraded capability tier |

## 3. Matrix by mode and provider (AC-1)

Columns: mechanism · authentication owner · consent/terms · plan limits · billing path · capabilities · deployment constraints · claim status. Technical feasibility, permission and implementation status are kept separate in the last column.

### Mode A — external official agent

| Provider / client | Mechanism and auth owner | Terms, limits and billing | Capabilities and deployment | Status |
| --- | --- | --- | --- | --- |
| **Claude Code CLI** | Remote MCP over streamable HTTP. Flux is the OAuth authorization server; the client supports CIMD, DCR or a pre-registered client, `claude mcp login`, and local/project/user scopes [P5]. Auth owner: the user (Claude), and Flux (the Flux grant). | The user's own plan or key under their own Anthropic terms. Limits and billing stay with the user. | Tools, resources and prompts from Flux. The client runs on the user's machine, so a private self-hosted Flux on a LAN or VPN is reachable. | Technical: confirmed (vendor claim, page lastmod 2026-09-25). Permission: confirmed, since Flux offers no Anthropic login. Implementation: none. |
| **Codex CLI** | MCP client: STDIO or streamable HTTP, bearer token from an env var, OAuth CIMD/DCR, tool allow/deny lists, `codex mcp login` [P3]. | The user's ChatGPT plan or API key under OpenAI terms. | Same as above; the local client connects from the user's machine. | Technical: vendor claim on an undated page → `unknown / needs confirmation`. Open issues dated 2026-08-26 and 2026-09-25 show the client MCP OAuth flow in use [K11]. Permission: Flux inference (the user runs their own client; Flux holds no OpenAI credential); OpenAI's current terms `unknown` [P16]. |
| **Claude apps** (web/desktop custom connectors) | Remote MCP connector. On Team/Enterprise an owner enables it for the organization, then **each member authenticates individually**; enterprise-managed org auth is a separate beta [P7][P12]. | Free: 1 custom connector; Pro, Max, Team and Enterprise supported [P12]. Owners can cap each tool at *Always allow*, *Needs approval* or *Blocked*, and the source service's permissions remain an upper bound [P12]. | **Anthropic's cloud connects to Flux**, so Flux must be publicly reachable or allowlist Anthropic IP ranges [P7]. Team/Enterprise connectors work only in private Claude projects, and chats with synced connector content cannot be shared [P12]. | Technical: confirmed. Permission: confirmed. **Conditional** for a private self-hosted Flux. |
| **ChatGPT apps** (remote MCP) | Remote MCP app with OAuth; stable callback on chatgpt.com and a CIMD client id per the plugins changelog 2026-08-21 [P13]. | The user's ChatGPT plan. | OpenAI's cloud connects to Flux; public HTTPS. The Secure MCP Tunnel is outbound-only, but its page is undated and it launched 2026-05-19 (stale) → `unknown / needs confirmation` [P13]. | Technical: OAuth callback and CIMD confirmed (vendor claim, changelog 2026-08-21). Egress IPs and tunnel: `unknown / needs confirmation`. |

### Mode B — agent inside Flux

| Provider / runtime | Mechanism and auth owner | Terms, limits and billing | Capabilities and deployment | Status |
| --- | --- | --- | --- | --- |
| **Anthropic Agent SDK / Managed Agents with an API key or cloud provider** | The Agent SDK runs the Claude Code binary as a library inside a process Flux operates; Managed Agents are hosted by Anthropic with a cloud or self-hosted sandbox [P4]. Auth owner: the organization or user who owns the Console key or cloud credentials. | Developers building products "should use API key authentication through Claude Console or a supported cloud provider" [P1]. The SDK is governed by the Commercial Terms, including when it powers products for end users [P4]. Billed at API or cloud rates to the key owner. | Built-in tools, hooks, subagents, MCP, permissions, sessions (resume/fork) [P4]. Runs inside the Flux worker container; Bedrock and Google Cloud Agent Platform are documented with IAM, ADC, service accounts or WIF [P6]. | Technical: confirmed. Permission: **confirmed** (P1, lastmod 2026-08-21; P4, lastmod 2026-09-21). |
| **Anthropic: Flux offers claude.ai login, or uses a user's Free/Pro/Max plan** | Flux would collect or proxy an OAuth session, or use `claude setup-token` tokens for others. | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens" [P1]. The SDK note says the same "unless previously approved" [P4]. Enforcement "may [happen] without prior notice" [P1]. | — | Permission: **not permitted** (vendor claim, H2 2026). Rejected. |
| **Anthropic: unmodified Claude Code binary; each user signs in with their own subscription** | A platform may preinstall or run Claude Code "as published", may not remove any built-in auth method, and "each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential". Customers "may not pay for, resell, or intermediate Claude usage" [P1]. | Requires agreeing to the Commercial Terms [P1]. "Advertised usage limits for Pro and Max plans assume ordinary, individual usage" [P1]. At the plan limit, usage is billed at API rates only if the user or owner enabled usage credits; otherwise the user is blocked [P10][P14]. | Session runs in a Flux-hosted sandbox with the user's own login inside the binary. Resume uses Claude Code sessions. | Technical: confirmed. Permission: **conditional**. Unknowns: (1) whether a self-hosted open-source Flux, installed by an organization for its members, is a "customer offering Claude Code"; (2) whether Flux keeping the user's session alive in a sandbox between runs counts as intermediating; (3) how shared or team-triggered runs fit "ordinary, individual usage". These need **written confirmation from Anthropic sales** before any in-product subscription promise. |
| **OpenAI Agents API** | Managed Codex harness with durable sessions, steering, tools/MCP, subagents, and OpenAI-hosted or self-hosted sandboxes; bearer `OPENAI_API_KEY` [P15]. Public beta released 2026-09-10 per the API changelog [P15]. | "Model usage is billed at the selected model's API rates", plus tool and container rates [P15]. | "Supports data residency only in the United States and does not support Zero Data Retention (ZDR)"; a self-hosted sandbox does not change this [P15]. | Technical: confirmed (beta, changelog 2026-09-10). Billing and residency: vendor claim on an undated overview of a product launched 2026-09-10, so the text is at least that recent (inference). Permission: `unknown / needs confirmation` (Services Agreement [P16]). **Conditional** for EU or ZDR-bound organizations. |
| **OpenAI: ChatGPT sign-in inside Flux (Codex App Server)** | Open-source JSON-RPC app server for "deep integration inside your own product", with thread start/resume/fork and approvals; `chatgptAuthTokens` lets a host supply ChatGPT tokens [P2]. Vendor claims on an undated page → current state `unknown / needs confirmation`. | "The app-server command and WebSocket transport are experimental and unsupported for production workloads" [P2]. The ChatGPT Terms of Use prohibit "making your account available to anyone else" and "using ChatGPT to power third-party services" (wording from a search snippet only; the terms page returned HTTP 403; last version seen eff. 2026-01-01, stale [P16]). No OpenAI document found that authorizes third-party products to use a user's ChatGPT auth; the question is open in OpenAI's own repo [K5]. "Sign in with ChatGPT (beta)" for select partners appears to provide identity only (`unknown / needs confirmation`, not re-read [P16]). | — | Technical: **unknown / needs confirmation** (P2 is undated; its own text calls the server experimental). Permission: **unknown / needs confirmation**, and the evidence points against it. Not offered. |
| **OpenAI: Codex access tokens** | Business/Enterprise tokens for trusted non-interactive local workflows; they run as the token creator [P3]. | Warn against shared identities and public environments [P3]. | Single-identity automation only. | Technical: vendor claim on an undated page → `unknown / needs confirmation`. Even if confirmed, not suitable for multi-user Flux runs (Flux inference). |

### Mode C — API, org cloud endpoint or local model

| Provider / runtime | Mechanism and auth owner | Terms, limits and billing | Capabilities and deployment | Status |
| --- | --- | --- | --- | --- |
| **Anthropic API / OpenAI API** | Org or user API key; Flux runs its own loop over Messages / Responses / Chat Completions. | Anthropic: products for end users "should use API key authentication through Claude Console or a supported cloud provider" [P1]. OpenAI: the last Services Agreement seen allows customer applications for end users, but it is stale (eff. 2026-01-01) and the current page returned HTTP 403 [P16]. Pay per token. | Tool calling and streaming; the provider's retention policy applies. | Technical: confirmed. Permission: Anthropic confirmed [P1]; OpenAI `unknown / needs confirmation`. |
| **Azure OpenAI / Foundry** | Entra ID: "lets you call your Azure OpenAI resource without storing an API key" [P17], or keys. Private link: page last updated 2026-06-05 (stale) → `unknown`. | Azure agreement (terms not assessed → `unknown`); Global, Data Zone and Batch deployment types [P17]. **Codex on Azure: API key only; "Entra ID support is currently not available for Codex"** [P17]. | Regional data zones [P17]; private networking `unknown`. | Technical: confirmed (vendor claim, ms.date 2026-08-04 to 2026-09-03; quotes from the raw pages). Private link and terms: `unknown`. |
| **Amazon Bedrock** | IAM credentials/SSO, or Bedrock API keys (`AWS_BEARER_TOKEN_BEDROCK`) [P6]. Short-term key guidance: `unknown / needs confirmation` (AWS pages undated). | AWS agreement; AWS rates. | IAM-scoped; supported by Claude Code and the Agent SDK. | Technical: confirmed (P6 lastmod 2026-09-24). |
| **Google Cloud Agent Platform (formerly Vertex AI)** | ADC, service account or WIF; `CLAUDE_CODE_USE_VERTEX` [P6]. | Google agreement. | Claude models are listed as partner models; that page is undated → model list `unknown` [P19]. | Technical: confirmed (P6 lastmod 2026-09-22). |
| **Ollama** (v0.34.4, 2026-09-23) | OpenAI- and Anthropic-compatible local endpoints; "The local API at `http://localhost:11434` does not require authentication"; keys authenticate ollama.com cloud requests; binds 127.0.0.1 by default; `OLLAMA_NO_CLOUD=1` [P18]. | No provider terms; hardware cost only. | Tools, vision and JSON output; no `tool_choice` [P18]. Must run on an internal-only Compose network behind the Flux backend (Flux inference). Exposed instances are a real risk [K12]. | Technical: confirmed (repository docs, commits 2026-08-11 to 2026-09-23; quotes re-read 2026-09-27). |
| **vLLM** (v0.30.0, 2026-09-22) | OpenAI-compatible server; `--api-key` protects only the `/v1`, `/v2`, `/inference` and `/cohere` prefixes, **not** `/invocations` and several control endpoints: "Do not rely exclusively on `--api-key`" [P11]. | No provider terms. | Tool calling needs `--enable-auto-tool-choice` and a parser; arguments "may occasionally be malformed" unless strict mode is used [P11]. | Technical: confirmed (server doc commit 2026-09-16; security doc commit 2026-09-26; quotes re-read 2026-09-27). |

### Capability by path

One row per path above. `unknown` means no H2 2026 primary source was found; `n/a` means the capability does not apply to that path. In mode A, Flux only sees tool calls: attachments are Flux materials exposed as MCP tools/resources, and the run itself (background work, resume) belongs to the user's client, not to Flux. In every mode, Flux's durable work, conversation and result state stays in Flux, so a human can continue after an interrupted or unavailable AI run (Flux inference, per #13 AC-4).

| Path | Tools | Attachments | Background work | Resume | Locality |
| --- | --- | --- | --- | --- | --- |
| A · Claude Code CLI | Flux MCP tools, resources and prompts [P5] | Flux materials as MCP resources [P5] | n/a to Flux (runs in the user's client) | n/a to Flux (client sessions) | User's machine; reaches a LAN/VPN Flux [P5] |
| A · Codex CLI | Flux MCP tools with allow/deny lists [P3] | Flux materials via MCP tools | `codex exec` non-interactive runs in the client [P3]; `unknown` (undated page) | `codex exec resume` in the client [P3]; `unknown` (undated page) | User's machine |
| A · Claude apps | Flux tools, capped by the owner's per-tool setting [P12] | `unknown` (MCP resource support in the apps not checked) | `unknown` | n/a to Flux (the chat stays in Claude; not shareable on Team/Enterprise [P12]) | Anthropic's cloud → public Flux or IP allowlist [P7] |
| A · ChatGPT apps | Flux tools via remote MCP with OAuth [P13] | `unknown` | `unknown` | n/a to Flux | OpenAI's cloud → public HTTPS; Secure MCP Tunnel `unknown` (stale source) [P13] |
| B · Agent SDK / Managed Agents, API key or cloud | Built-in tools, hooks, subagents, MCP [P4] | `unknown` | In a Flux-operated worker (Flux inference) or an Anthropic-hosted sandbox [P4] | Sessions resume/fork [P4] | Flux worker container; inference at Anthropic, Bedrock or Google Cloud [P6] |
| B · Flux offers claude.ai login / consumer plan | n/a (rejected) | n/a | n/a | n/a | n/a |
| B · unmodified Claude Code binary, user's own sign-in | Claude Code built-in tools and MCP [P4][P5] | `unknown` | In a Flux-hosted sandbox (Flux inference) | Claude Code sessions [P4] | Flux sandbox; inference at Anthropic |
| B · OpenAI Agents API | Tools/MCP, subagents [P15] | `unknown` (Files API wording seen only in a search snippet) | `unknown` (no wording found) | "retains session state so you can continue work across turns"; `session_id` [P15] | OpenAI-hosted or self-hosted sandbox; **US-only residency, no ZDR** [P15] |
| B · Codex App Server with ChatGPT sign-in | Tools with approvals [P2]; `unknown` (undated page) | `image` / `localImage` inputs [P2]; `unknown` (undated page) | `unknown` | `thread/resume`, `thread/fork` [P2]; `unknown` (undated page) | Host process run by Flux; experimental [P2] |
| B · Codex access tokens | Codex tools [P3]; `unknown` (undated page) | `unknown` | Non-interactive local workflows [P3]; `unknown` (undated page) | `codex exec resume` [P3]; `unknown` (undated page) | Trusted local machine; one identity [P3]; `unknown` (undated page) |
| C · Anthropic / OpenAI API | Function calling in Flux's own loop | `unknown` (not re-checked in H2 2026) | In a Flux worker (Flux inference); provider batch APIs `unknown` | Flux-held run state (Flux inference) | Provider cloud; the provider's retention applies |
| C · Azure OpenAI / Foundry | `unknown` | `unknown` | Batch deployment types with a 24-hour target [P17] | Flux-held run state (Flux inference) | Global or Data Zone (US, EU, APAC) processing [P17]; private link `unknown` (stale page) |
| C · Amazon Bedrock | Client-side tool use on Converse/InvokeModel (undated page → `unknown`) [P19] | PDF with citations (undated page → `unknown`) [P19] | `unknown` | Flux-held run state (Flux inference) | AWS region, IAM-scoped [P6] |
| C · Google Cloud Agent Platform | `unknown` (undated page) [P19] | `unknown` | Batch prediction (undated page → `unknown`) [P19] | Flux-held run state (Flux inference) | Google Cloud region via ADC [P6] |
| C · Ollama | Tools; no `tool_choice` [P18] | Images (base64 in the vision example); PDF not listed [P18] | No batch API listed; runs in a Flux worker (Flux inference) | Flux-held run state; the cloud API does not support stateful Responses, local statefulness `unknown` [P18] | Local; binds 127.0.0.1:11434 by default [P18] |
| C · vLLM | Tools with `--enable-auto-tool-choice` and a parser [P11] | Vision and audio input [P11] | Batch chat completions endpoint [P11] | Retrieve and cancel stored responses [P11] | Self-hosted; `--api-key` covers only some prefixes [P11] |

**Not assessed:** Google Gemini API and Antigravity (except the community signal K4), Mistral, Cohere, xAI, OpenRouter and other aggregators, llama.cpp server, LocalAI, SGLang, LM Studio, GitHub Copilot, Microsoft Copilot, JetBrains AI. Each needs its own pass before Flux names it.

## 4. Sources and reconciliation (AC-2)

### Differing provider statements and how they reconcile

1. **Anthropic: "products for others must use API keys" vs "a platform may host Claude Code with the user's own subscription".** Both are in P1. They reconcile as a narrow exception: only the unmodified binary, only through Anthropic's own sign-in flow, with no paying for or intermediating usage. A Flux-built agent loop (Agent SDK, Messages API) must use API keys or a cloud provider. The stale help pages P8/P9 (May/June 2026) pointed the same way; the P1 clauses were added in H2 2026 (lastmod 2026-08-21), so P8/P9 are now historical context only.
2. **OpenAI: App Server "for deep integration inside your own product" vs "experimental and unsupported for production".** Both are in P2, which is undated, so neither statement is a verified current fact. Flux treats the server's current capability as `unknown / needs confirmation`, treats it as not production-ready, and leaves the ChatGPT-auth question unresolved.
3. **Community claims that OpenAI "gives its blessing" to third-party harnesses vs no such permission in the OpenAI ToU** [K3]. The primary terms win. The community claim only flags the question for direct confirmation (contract rule: community reports never override primary permission statements).

### Needs direct provider confirmation before any in-product subscription promise

- **Anthropic sales:** the three unknowns in the "unmodified Claude Code binary" row.
- **OpenAI:** the current Services Agreement and ChatGPT Terms of Use text (HTTP 403 on 2026-09-27); whether any third-party multi-user product may use a user's ChatGPT/Codex sign-in; Agents API residency and ZDR roadmap; ChatGPT app egress IP ranges and the Secure MCP Tunnel's current state.
- **Both:** the dates of undated pages P2, P3, P15, P16 and P19 at the time of implementation.

### Dedicated research pass for the blocking permission gap (contract verification plan)

At the checkpoint (draft PR #12 at `1242092`), the only mode-B permission sources were stale (P8 2026-05-19, P9 2026-06-16). Pass on 2026-09-27:
- **Tried:** Anthropic Consumer and Commercial Terms, Usage Policy (all stale: effective 2025); support.claude.com search; the code.claude.com sitemap and pages; archived snapshots; OpenAI help center, Codex docs and changelog; openai.com terms (HTTP 403, read via archive copies by the research pass).
- **Result:** P1 (lastmod 2026-08-21) and P4 (lastmod 2026-09-21) supply H2 2026 support for the Anthropic permission rows. I re-read their quotes on 2026-09-27 and they match. The OpenAI ChatGPT-auth question remains `unknown / needs confirmation`; it is reported as unresolved, not as a satisfied criterion.

### Source ledger

"lastmod" is the sitemap `lastmod`, observed via `code.claude.com/sitemap.xml` on 2026-09-27. "Undated" means no date was visible; such a source is not the sole support for a current claim unless marked `unknown`.

| ID | Source | Date |
| --- | --- | --- |
| P1 | [Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) — quotes re-read 2026-09-27 | lastmod 2026-08-21 |
| P2 | [Codex App Server](https://learn.chatgpt.com/docs/app-server) — quotes re-read 2026-09-27 | undated |
| P3 | [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md) | undated → current claims `unknown / needs confirmation` |
| P4 | [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) — note re-read 2026-09-27 | lastmod 2026-09-21 |
| P5 | [Claude Code MCP](https://code.claude.com/docs/en/mcp) | lastmod 2026-09-25 |
| P6 | [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock), [on Google Cloud Agent Platform](https://code.claude.com/docs/en/google-vertex-ai) | lastmod 2026-09-24 / 2026-09-22 |
| P7 | [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | 2026-08-11 |
| P8 | [Log in to your Claude account](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) | stale: 2026-05-19 (historical only) |
| P9 | [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | stale: 2026-06-16 (historical only) |
| P10 | [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) | 2026-08-19 |
| P11 | [vLLM OpenAI-compatible server](https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md), [vLLM security](https://github.com/vllm-project/vllm/blob/main/docs/usage/security.md); release v0.30.0 (2026-09-22) | commits 2026-09-16 / 2026-09-26 |
| P12 | [Use connectors to extend Claude's capabilities](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities) — peer-supplied in [5853406029](https://github.com/ColdPhase/flux/issues/9#issuecomment-5853406029) | 2026-08-20 |
| P13 | [Apps SDK changelog](https://developers.openai.com/apps-sdk/changelog), entry "Stable OAuth callbacks and CIMD client IDs"; [Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels.md) | changelog 2026-08-21; tunnel page undated, launched 2026-05-19 per the API changelog (stale) |
| P14 | Claude help articles [12429409](https://support.claude.com/en/articles/12429409) ("Usage credits are billed at standard API rates") and [12005970](https://support.claude.com/en/articles/12005970) | relative only on 2026-09-27 ("Updated this week" / "Updated over 3 weeks ago"); absolute dates `unknown`. P10 (2026-08-19) is the dated support |
| P15 | [OpenAI Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview) — quotes re-read 2026-09-27; [API changelog](https://developers.openai.com/api/docs/changelog): "Sep 10, 2026 – Released the Agents API in public beta" | overview undated; changelog 2026-09-10 |
| P16 | [ChatGPT Terms of Use](https://openai.com/policies/terms-of-use/), [OpenAI Services Agreement](https://openai.com/policies/services-agreement/): both HTTP 403 on 2026-09-27; wording known only from search snippets | stale: last version seen eff. 2026-01-01; no H2 2026 text verified → `unknown` |
| P17 | Azure OpenAI in Foundry: [managed identity](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/managed-identity), [deployment types](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types) (old URL redirects here), [Codex](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/codex), [network / private link](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/network) | ms.date 2026-08-04 / 2026-08-06 (page `updated_at` 2026-08-12, re-read 2026-09-27) / 2026-09-03; network page updated 2026-06-05 (stale) |
| P18 | Ollama [OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx), [authentication](https://github.com/ollama/ollama/blob/main/docs/api/authentication.mdx), [FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx); release v0.34.4 (2026-09-23) | commits 2026-09-23 / 2026-09-15 / 2026-08-11 |
| P19 | [Amazon Bedrock: Claude parameters](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html), [Google Cloud: Claude partner models](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude) | undated → claims marked `unknown` |

P11, P17 (raw pages) and P18 quotes were re-read on 2026-09-27, and their commit dates come from the GitHub API. P13–P16 and P19 were read through page summaries on 2026-09-27; recheck exact wording before quoting it in product copy. A claim whose only source is undated or stale is marked `unknown / needs confirmation`.

## 5. Community-grounded evidence (AC-2, v4)

**Method:** HN items (dates verified through the official Firebase item API on 2026-09-27) and GitHub issues (dates verified through the GitHub API). **Reddit (r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA, r/selfhosted) returned HTTP 403 to every access path tried** (`reddit.com`, `old.reddit.com`, `api.reddit.com`, JSON endpoints), so Reddit is a named coverage gap, not silence. X posts were seen only via HN links and are not cited. SEO lists and vendor marketing were excluded as sentiment evidence. Supervisor evidence ([5851950690](https://github.com/ColdPhase/flux/issues/9#issuecomment-5851950690)) was used as leads and re-dated.

| ID | Report (date) | Label and cross-check | Bearing on Flux |
| --- | --- | --- | --- |
| K1 | [HN 49753579](https://news.ycombinator.com/item?id=49753579) (2026-09-18) "Does this mean it's fine to use Claude subscriptions with third party harnesses?"; [49804853](https://news.ycombinator.com/item?id=49804853) (2026-09-22) "absurdly vague about 3rd party harnesses" | community report, **corroborated** as real confusion (two threads); the permission question itself is answered by P1, not by the threads | Users will not know the rules; Flux must state them in the connect screen. |
| K2 | [HN 49215736](https://news.ycombinator.com/item?id=49215736) (2026-08-07) account banned after authenticating from a third-party IDE assistant; [HN 49530298](https://news.ycombinator.com/item?id=49530298) (2026-09-02) "banned me for 'suspicious signals'" | community report, unverified cause; the **pattern** of opaque enforcement is corroborated by P1's "without prior notice" | A Flux path that risks a user's personal account is unacceptable. |
| K3 | [HN 49744039](https://news.ycombinator.com/item?id=49744039) (2026-09-17) "against Anthropic's TOS … isn't explicitly allowed in OAI's TOS, however they publicly support Pi and OpenCode" | community report, unverified; conflicts with P16's ToU text | Flags OpenAI ChatGPT-auth for direct confirmation only. |
| K4 | [HN 49548452](https://news.ycombinator.com/item?id=49548452) (2026-09-03) Google Antigravity ToS: third-party usage can get accounts suspended | community report, unverified (Google not assessed) | Same risk class for other consumer plans. |
| K5 | [openai/codex#41664](https://github.com/openai/codex/issues/41664) (2026-08-30, open) asks whether multi-account ChatGPT-auth proxies are supported; [anomalyco/opencode#43850](https://github.com/anomalyco/opencode/issues/43850) (2026-08-21) ChatGPT Plus OAuth failing in a third-party client | observed (open issues) | OpenAI has not answered the permission question publicly. |
| K6 | [HN 49506519](https://news.ycombinator.com/item?id=49506519) (2026-08-31), [49778641](https://news.ycombinator.com/item?id=49778641) (2026-09-20) weekly Claude Code limits cut 17%; [49354459](https://news.ycombinator.com/item?id=49354459) (2026-08-18) "I just cancelled my Max 5x plan"; [49806387](https://news.ycombinator.com/item?id=49806387) (2026-09-22) Codex limits too tight | community report, **corroborated** across threads and providers | Limits change often; exhaustion is a normal state (§6). |
| K7 | **Disconfirming:** [HN 49357861](https://news.ycombinator.com/item?id=49357861) (2026-08-19) rarely hits limits | community report, unverified | Limit pain is uneven; don't design only for heavy users. |
| K8 | [anthropics/claude-code#91777](https://github.com/anthropics/claude-code/issues/91777) (2026-09-03) `claude -p` silently billed a project `.env` API key while a subscription was present; [#81703](https://github.com/anthropics/claude-code/issues/81703) (2026-07-27) usage credits charged despite plan allowance | observed (open issues); corroborated by P10 (API key takes precedence) | Direct evidence for the **no silent billing switch** rule: Flux must never inject a key into a user's environment. |
| K9 | [openai/codex#46214](https://github.com/openai/codex/issues/46214) (2026-09-17) "Selected model is at capacity" on every surface for ~10 days | observed (open issue), single report | Capacity errors need a distinct, honest state. |
| K10 | [HN 48883275](https://news.ycombinator.com/item?id=48883275) (2026-07-12) Claude Code sends ~33k tokens before the prompt vs ~7k for OpenCode; [Ask HN 49548600](https://news.ycombinator.com/item?id=49548600) (2026-09-03) and [49779329](https://news.ycombinator.com/item?id=49779329) (2026-09-20) MCP token bloat; **disconfirming** [49563414](https://news.ycombinator.com/item?id=49563414) (2026-09-04) MCP is right for non-technical users | community report; bloat corroborated across threads, single measurement for the 33k figure | The Flux MCP server must be token-lean (summary-first tools), with a CLI alternative for technical users. |
| K11 | [openai/codex#40885](https://github.com/openai/codex/issues/40885) (2026-08-26, open) MCP OAuth issuer taken from the resource URL, "rejecting conformant servers"; [openai/codex#48041](https://github.com/openai/codex/issues/48041) (2026-09-25, open) repeated OAuth discovery probes | observed (open issues; dates via the GitHub API) | Test both official login flows against Flux's OAuth server, including `authorization_servers` metadata. |
| K12 | [HN 49736692](https://news.ycombinator.com/item?id=49736692) (2026-09-17) Shodan indexes over 47,000 exposed Ollama instances | community report, unverified count; corroborated in kind by P18 (no auth on the local server) | Local runtimes must stay on an internal network. |
| K13 | [HN 49697014](https://news.ycombinator.com/item?id=49697014) (2026-09-14) gotchas migrating long prompts to self-hosted Ollama; [49033914](https://news.ycombinator.com/item?id=49033914) (2026-07-24) small-active-parameter MoE models weak for agentic work; [ollama#17638](https://github.com/ollama/ollama/issues/17638) (2026-08-09) and [vllm#50889](https://github.com/vllm-project/vllm/issues/50889) (2026-08-03) tool-call parsing failures | community report and observed issues, **corroborated** across two runtimes | Local models are a degraded tier for long agent tasks; validate tool-call JSON. |
| K14 | **Disconfirming:** [HN 49510029](https://news.ycombinator.com/item?id=49510029) (2026-08-31) local models on a 128 GB laptop have been capable since March | community report, unverified | Capability varies with hardware; let admins test and choose. |

## 6. User experience across the connection lifecycle (AC-3)

Everything in this section is **Flux inference / proposal**. No part of it
describes existing Flux behavior; there is no Flux application yet. It applies
foundation §9.4 (founder direction) to the modes assessed above.

### 6.1 Vocabulary used in this document (provisional)

| Term | Meaning |
| --- | --- |
| **Compute source** | Where model inference is paid for and executed: a personal plan, an organization API account, an org-managed cloud endpoint, or a self-hosted runtime. |
| **Connection** | A configured link between a Flux person or workspace and one compute source or external agent. It has exactly one owner and one scope. |
| **Personal connection** | Owned by one person; usable only for that person's own actions. Never silently shared with a team. |
| **Workspace connection** | Configured by an administrator for an organization-billed source (API key, cloud endpoint, local runtime) with explicit member eligibility and limits. |
| **External agent** | The user's own official Codex or Claude Code client acting on Flux through a Flux-issued, scoped authorization (mode A). |
| **Grant** | The Flux-side permission set given to an external agent or connection: which spaces, which object types, read vs write. |

These terms should be reconciled with the accepted #8 glossary (merged in PR #11) and
the #14 product-language task before any is treated as final.

### 6.2 States and required behavior

| State | Mode A: external official agent | Mode B: agent inside Flux | Mode C: API / cloud / local | Common rule |
| --- | --- | --- | --- | --- |
| **Connect** | User adds the Flux MCP server URL in their own client; Flux runs its own OAuth consent screen listing the grant (spaces, read/write). Flux never sees the provider credential. | Only paths confirmed as permitted in §3 (API key, org cloud endpoint, local runtime, or — only after written confirmation — the unmodified Claude Code binary with the user signing in through Anthropic's own flow). A consumer-plan sign-in button appears only after the provider's written permission is recorded (see §7). | Admin or user enters a key/endpoint; Flux shows owner, billing account, model list actually returned by the endpoint, and member eligibility. | Show who pays, who owns the connection, and what it can reach **before** the first run. |
| **Normal use** | Agent actions appear in Flux under the agent's identity *and* the human who authorized it; writes go through the same permission checks as a person. | Each run shows its compute source badge (e.g. "Org API — Acme Anthropic account") and the context it received. | Same as B, plus per-workspace limits configured by the admin. | Context passed to a model is limited to the current grant; personal context is never included by virtue of a connection existing. |
| **Limit / exhaustion** | Handled by the user's client; Flux sees only failed or stopped tool calls and keeps partial results as drafts. | Run pauses with a readable reason ("provider limit reached", with provider-reported reset time only if the provider exposes it). Offer: wait, switch to another *already consented* source, or continue manually. | Org budget/limit reached → same pause; admin sees the event. | **No silent switch** from a subscription or free tier to a paid API or another billing account. A switch requires an explicit, per-switch or pre-authorized consent recorded with who approved it. |
| **Revocation / disconnect** | User or admin revokes the Flux grant; outstanding tokens stop working; the agent's past contributions remain attributed. The user can also remove the server in their client. | Disconnect deletes stored credentials; queued runs using it are paused, not re-routed. | Admin rotates/removes key; dependent automations show "compute source unavailable". | Revocation is a normal state with a clear return path, never data loss. |
| **No AI available** | Flux works fully without any external agent. | Conversations, reading, editing, tasks and manual continuation of an agent's partial work remain available. | Same. | Absence of a model never blocks human collaboration (foundation §9.4). |

### 6.3 Private vs shared context

- A personal connection runs with the permissions of its owner, restricted by
  the grant. Its output is private to the owner until the owner shares it,
  unless the run was started in a shared space whose policy says otherwise and
  the user saw that policy at start.
- A workspace connection may run shared automations; the admin defines which
  spaces and roles may use it. Members see that a shared source is used.
- An external agent (mode A) reads only what the Flux grant allows, regardless
  of what the user's own client can see elsewhere.

### 6.4 Cost-consent boundaries

1. Every run records its compute source, billing owner, and initiating person.
2. Changing a run's compute source to a different billing owner or billing
   type (plan → pay-as-you-go API, personal → organization) requires explicit
   consent by someone authorized for the destination account.
3. Admin-defined spend or usage caps for workspace connections; Flux reports
   provider-returned usage where available and labels estimates as estimates.
4. Flux never stores or reuses a consumer-plan session token outside the
   provider's official, permitted mechanism (contract scope: no copying of
   sessions/tokens).

### 6.5 Mode A through Claude or ChatGPT apps

These points answer the peer's question in [5853406029](https://github.com/ColdPhase/flux/issues/9#issuecomment-5853406029):
- **Per-member authentication.** An organization owner enabling the Flux connector does not grant access. Each member completes Flux's own OAuth consent, so each Flux grant is per person [P12].
- **Admin tool ceiling.** A Claude owner's *Always allow / Needs approval / Blocked* setting is a ceiling above Flux, not a replacement. Flux still enforces its own grant and object permissions on every call, and it treats write tools as proposals unless the grant allows direct writes.
- **Chat sharing limit.** Team/Enterprise connector chats are private and cannot be shared [P12]. A shared Flux result therefore has to be written through Flux's permissioned tools into a Flux space. Being able to share the Claude chat never implies being able to share Flux content.
- **Reachability.** For a private self-hosted Flux, the supported mode-A paths are the local CLI clients. Cloud-app connectors need a public endpoint, an IP allowlist, or an enterprise tunnel (§3).

## 7. Recommendation (O-005 proposal)

1. **Build mode A first.** Provide a Flux remote MCP server plus a CLI with Flux as the OAuth 2.1 authorization server. Prefer CIMD, allow DCR, and use audience-bound short-lived tokens and per-agent revocable grants. Target the MCP revision chosen in #13. Test with the Claude Code and Codex login flows. It needs no provider credential in Flux and works for private self-hosted installs through local clients. Permission is confirmed for Claude Code [P1]; for Codex it rests on the user running their own client, while OpenAI's current terms remain `unknown` (§4).
2. **Mode B, initially API-billed only.** Start with Anthropic (Agent SDK or Messages API) and an organization- or user-owned API key or cloud credentials (Bedrock, Google Cloud Agent Platform). Add OpenAI (Responses API, or the Agents API where US residency is acceptable) and Azure/Foundry once their current terms are re-read and recorded (§4); until then their permission is `unknown`. Every run shows its compute source and billing owner (§6).
3. **Mode C behind one adapter.** Use one provider-adapter interface over the common Messages / Chat Completions surface. Local runtimes (Ollama, vLLM) stay on an internal-only network, their tool-call output is validated, and they are labelled a capability tier rather than parity.
4. **No consumer-subscription path in Flux for now.** Do not offer claude.ai or ChatGPT login inside Flux, and never store or proxy subscription tokens. The "unmodified Claude Code binary with the user's own sign-in" path stays **conditional**. It becomes a candidate only after written Anthropic confirmation of the three unknowns in §3, recorded in the decision register. No OpenAI equivalent is available until OpenAI confirms a permitted mechanism.
5. **No-AI continuation is a release requirement** for every AI surface (§6.2).

## 8. Risks and recheck trigger

| Risk | Mitigation |
| --- | --- |
| Provider terms change or are enforced without notice (P1; K2) | Keep all consumer-plan paths out of the core, and recheck P1, P2, P4 and P15 before each release that touches AI. |
| Limits and capacity change often (K6, K9) | Model limit, capacity and ban as ordinary states, and never auto-switch billing (K8). |
| Cloud-app connectors cannot reach a private Flux | Document local-client mode A as the self-hosted default. |
| MCP token overhead makes agents expensive (K10) | Summary-first tools, pagination, a CLI alternative, and token budgets in tests. |
| Local runtime exposure and tool-call failures (K12, K13) | Internal network only, JSON validation, retries with visible failure. |
| Agents API residency/ZDR limits | Offer it only where the organization accepts US residency; otherwise use API keys directly. |
| Undated or stale details (P2, P3, P13 tunnel, P14, P16, P17 private link, P19) | Treated as `unknown`; re-read before implementing the corresponding adapter. |

**Recheck trigger:** re-run this assessment when any of these happens: P1, P2, P4, P12 or P15 changes; a provider announces third-party subscription sign-in or partner programs; Anthropic or OpenAI replies to the confirmation requests in §4; the MCP spec revision changes; or before any public release that mentions AI access. In any case, recheck within 90 days (by 2026-12-26).

## 9. Unresolved O-005 decisions and owners

| Decision | Owner | Unblock condition |
| --- | --- | --- |
| Accept the §7 recommendation as O-005 | Independent evaluator @PelikanFix16 (`codex-hubert`) | Review of this PR |
| Request written confirmation from Anthropic for the unmodified-binary path | @Zamojski5 (`claude-maurycy`), tracked as a follow-up issue after acceptance | Written reply recorded in `decisions.md` |
| Ask OpenAI about ChatGPT-auth use in third-party multi-user products and about Agents API residency | @Zamojski5 | Written reply, or a dated public doc |
| MCP revision and Flux OAuth design | #13 owner @PelikanFix16 | #13 accepted |
| Which local runtime Flux documents first (Ollama vs vLLM) | Agent-run adapter task in milestone 2 | Docker test of tool calling on the reference hardware |

## 10. Implications for architecture (#13) and release

- **Architecture:** Flux needs an OAuth 2.1 authorization server and MCP endpoint that share the same authorization layer as the UI and API. It needs a provider-adapter interface that is aware of the compute source (owner, billing account, eligibility, caps), and a run record holding the compute source, initiator, grant snapshot, state (running / paused-limit / paused-revoked / failed / done) and provenance of proposed changes. Provider secrets are encrypted at rest, visible only to the owner, and never exported. Worker runs recheck grants before reading and before committing (as agreed on #13). Local runtimes are internal Compose services.
- **Release:** the first release promises mode A plus the API/cloud/local-key paths whose permission is confirmed at release time, and no consumer-subscription sign-in. The release notes list supported providers with the date of this assessment and the recheck trigger. The AI-off journey is part of acceptance.
