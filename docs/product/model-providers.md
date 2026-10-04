# F-020 — provider-neutral Flux agent

**Founder requirement, 2026-10-02.** Hubert (@PelikanFix16) gave this direction in
the supervising session: the Flux agent must not be only a connectable cloud
Claude agent. It must also work with OpenAI Codex and similar clients, and with
an API key for OpenRouter or any other provider. Every model must get equal
support inside the Flux agent. Implementation is tracked in
[#179](https://github.com/ColdPhase/flux/issues/179).
**Owner:** @PelikanFix16. **Evaluator:** @Zamojski5.

> **Two-mode framing: [F-022](ai-modes.md), proposed 2026-10-04 — awaiting peer review.**
> Everything here is mode 2 (the agent in Flux) except PROV-5, which is mode 1 (your
> agent app over MCP). F-022 adds a connection *transport* (PROV-1), a token-cap
> variant for plan connections (PROV-3) and replaces PROV-4's subscription sentence.

This decision **supersedes the Anthropic-only provider scope** of
[O-007](background-compute.md) and [O-008](personal-runs-compute.md), O-008's
deferral of local models, and the Anthropic preflight count as the input bound
([PROV-3](#prov-3--cost-caps-and-token-bounds)). Everything else in those decisions
stays in force:

- owner custody of the key and payer attestation
- [F-019](decisions.md) owner-only use
- separate consent per use
- daily caps and per-run reservations
- one bounded request per run
- source and audience limits
- stop, retry and continue semantics
- fail-closed behaviour with no payer fallback

## What was true before this decision (observed on `main` `471b22dd`, 2026-10-02)

- **Assistant in Flux and background comparison (#68/#58).**
  - Anthropic only: one adapter in `app/packages/agent-runtime/src/anthropic.ts`
    and one pinned model, `PERSONAL_RUN_LIMITS.model`.
  - Settings and Details copy says "your own Anthropic API key".
  - O-008 rejected local models "for now". OpenAI, OpenRouter and Gemini keys
    were never assessed as in-product compute.
- **External co-work over MCP (#152).**
  - A connection can carry the label Claude Code, Codex or External client.
  - The Connect guide shows only `claude mcp add/login`.
  - Details names only "Claude Code on your computer".
  - Real Codex activation remains unverified (#152/#160).

## PROV-1 — owner AI connections

An owner may keep one or more AI connections. Each connection records:

- **Provider kind:**
  - `anthropic`
  - `openai`
  - `openrouter`
  - `gemini`
  - `openai_compatible`: self-hosted Ollama/vLLM/LM Studio, gateways and other
    endpoints speaking the same wire format.
- **Model:** the owner's choice. Where the provider lists models, they come from
  that list, fetched server-side. Otherwise the owner types the model id.
- **Base URL:** fixed for the named providers; owner-set for `openai_compatible`.
- **Key:** custody as in O-007 §2, generalised per provider: "one provider workspace" means the provider account or project the key belongs to, and "revoke at Claude Platform" means revoking the key with that provider.
- **Price:** see PROV-3.
- **Transport ([F-022](ai-modes.md#aim-2--mode-2-the-agent-in-flux)):** `server`
  (the Flux worker calls the provider with the key above; every provider kind) or
  `companion` (the owner's Flux companion calls the provider; only `chatgpt_plan`,
  [AIM-3](ai-modes.md#aim-3--the-companion-and-the-chatgpt-plan-connection-mode-2)).
  A `companion` connection has no key in Flux.

The owner chooses which connection each use runs on (assistant in Flux,
background rule). Configuring a connection enables neither use; each use keeps
its own consent, cap and pause (O-008). Replacing or deleting a connection stops
the uses that point to it. Nothing falls back to another connection or payer.

## PROV-2 — equal treatment of every model

One provider-neutral runtime port carries the same steps for every provider:

- prompt assembly
- source selection
- output parsing
- proposals
- stop, retry and continue
- pause
- audit

Adapters translate only the wire format, the stop reason, usage and errors into
the port's closed result set. The result set (truncated/refusal/rate limit/
overloaded/timeout/aborted/provider error, with a billing hint) is shared by all
adapters.

- **No vendor-exclusive features.** No Flux feature is reserved to a vendor or
  model. Provider-hosted tools (web search, code execution, connectors) stay off
  for every provider. Flux asks for plain text and parses it the same way for
  all.
- **Neutral UI.** The UI names the selected provider and model neutrally, e.g.
  "OpenRouter · model-id". "Anthropic" or "Claude" appears only where that is
  the selected connection or an external client the person labelled that way.
- **Model differences are shown, not hidden.** A model with a smaller context
  window gets the same bounded input when it fits. When it does not fit, the run
  fails closed with a clear state, as any provider would.

## PROV-3 — cost, caps and token bounds

O-008's consent, daily cap, per-run reservation, reconciliation and fail-closed
rules apply to every provider.

**Price source.** A reservation needs a price before any response exists, so a
connection's price per 1M input and output tokens comes from:

1. Flux's dated price table for named models, or
2. an owner-entered price. Zero is allowed for self-hosted endpoints.

A connection without one of these cannot be enabled. Enabling and reservation use
only this price. A provider-reported cost in a response (for example OpenRouter's
`usage.cost`) never raises or bypasses the reservation; it is used only to reconcile
the run's actual charge.

**Reservation.** For a run, the reservation is:

> maximum input tokens × input price + maximum output tokens × output price

It is reconciled against reported usage. A lost response keeps its reservation
as `unknown`.

**Plan connections ([F-022](ai-modes.md#aim-3--the-companion-and-the-chatgpt-plan-connection-mode-2)).**
A `chatgpt_plan` connection has no per-token price. Its use is bounded by a daily
token cap and a per-run token ceiling (input estimate + maximum output), reserved
and reconciled exactly like a money reservation; a lost response keeps its token
reservation as `unknown`. The payer is the owner's ChatGPT plan, shown as *Using
ChatGPT plan* with a *Manage usage* link. A plan limit fails closed.

**Input bound.** The same conservative Flux token estimate bounds input for every
provider. A provider token-count endpoint may tighten the estimate, never loosen
the bound. This replaces O-007/O-008's preflight count with the Anthropic
token-counting endpoint as the bound; that endpoint becomes one optional refinement.

## PROV-4 — security

The O-007 §2 custody rules apply to every adapter:

- AEAD at rest.
- Only the worker decrypts the key.
- The key never appears in API responses, stream frames, jobs, logs, exports or
  error bodies.
- The existing seeded-key absence test runs for each adapter.

**Base URL (SSRF guard).**

- Public HTTPS by default.
- Redirects are not followed.
- Response time and size are bounded.
- The URL is resolved and checked at dispatch.
- Private, loopback and link-local targets are allowed only when the instance
  operator enables them explicitly with an allowlist.
- Environment variables never redirect a key.

**Subscriptions ([F-022](ai-modes.md), proposed 2026-10-04; replaces the earlier
blanket exclusion).** Flux never collects, stores or forwards a consumer sign-in,
session or CLI credential (Claude.ai, `claude setup-token`, `~/.codex/auth.json`,
ChatGPT cookies), and never impersonates another application's OAuth client. A
subscription enters mode 2 only through a provider-documented plan-usage grant to
third-party apps. On 2026-10-04 that is OpenAI's Sign in with ChatGPT, held by the
owner's companion ([AIM-3](ai-modes.md#aim-3--the-companion-and-the-chatgpt-plan-connection-mode-2)),
never by the Flux server. Anthropic permits no such grant, so a Claude plan is used
through the person's own Claude Code in mode 1 (PROV-5).

## PROV-5 — external clients are equal too

Connect offers equivalent guidance for Claude Code, Codex and a generic MCP
client, with each client's own add and login commands. All of them get the same:

- OAuth consent
- grants and standing autonomy
- identity and one entry per connection in the Agents view (UI116-2)

The client label stays a recognition aid, not a verified identity.

Flux tokens are audience-bound to the Flux MCP resource, and Flux never accepts or
passes through a client's provider token (MCP authorization 2026-07-28;
[AIM-1](ai-modes.md#aim-1--mode-1-your-agent-app-connects-to-flux)).

## PROV-6 — evidence

**Adapter contract suite.** One suite runs identically, in Docker, against mock
servers for each wire format:

- Anthropic Messages.
- OpenAI-compatible Chat Completions, used by OpenAI, OpenRouter, Gemini's
  compatible endpoint and self-hosted servers.

The suite covers success, truncation, refusal, rate limit, overload, timeout,
abort, malformed output and usage/cost reconciliation. A native adapter is added
only when a provider cannot meet this suite through a compatible endpoint, and
the added adapter must pass the same suite.

**Real-key smoke tests.** Each named provider gets a dated smoke test with the
owner's own key. A provider without a key at hand is reported unverified, not
passed.

**Provider terms.** Rows marked `unknown` in the
[feasibility study](own-ai-feasibility.md) (OpenAI API terms; OpenRouter and
Gemini were not assessed) are checked against dated primary sources during
implementation. A provider whose terms forbid this use is disabled, and the
evidence is recorded. The requirement itself does not wait for that check.

**External clients.** Real Codex and Claude Code connections are recorded,
together with one other MCP client as a smoke test.

**Companion and plan connection ([F-022](ai-modes.md)).** The same contract suite runs
in Docker against a mock Responses streaming server behind a companion process,
covering success, plan limit (`subscription_sharing_usage_limit_exceeded`),
expired/revoked token, cancel, disconnect mid-stream, offline computer, duplicate
delivery and token-absence on the Flux side. A real ChatGPT-plan smoke test is
dated and recorded, or reported unverified.

## Revisit when

Revisit when either of these holds:

- A provider's terms forbid the mode.
- Independent evidence shows that a provider cannot meet the same custody, cap
  and fail-closed gates. In that case only that provider is disabled.

The equal-treatment requirement stays.
