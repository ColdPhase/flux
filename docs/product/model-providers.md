# F-020 — provider-neutral Flux agent

**Founder requirement, 2026-10-02.** Hubert (@PelikanFix16) gave this direction in
the supervising session: the Flux agent must not be only a connectable cloud
Claude agent. It must also work with OpenAI Codex and similar clients, and with
an API key for OpenRouter or any other provider. Every model must get equal
support inside the Flux agent. Implementation is tracked in
[#179](https://github.com/ColdPhase/flux/issues/179).
**Owner:** @PelikanFix16. **Evaluator:** @Zamojski5.

This decision **supersedes the Anthropic-only provider scope** of
[O-007](background-compute.md) and [O-008](personal-runs-compute.md), and O-008's
deferral of local models. Everything else in those decisions stays in force:

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

Flux holds **no consumer subscription sign-in** (ChatGPT, Claude.ai or similar).
O-007/O-008 evidence and the [feasibility study](own-ai-feasibility.md) keep that
rejected. A person uses such a subscription through their own external client
over MCP (PROV-5).

## PROV-5 — external clients are equal too

Connect offers equivalent guidance for Claude Code, Codex and a generic MCP
client, with each client's own add and login commands. All of them get the same:

- OAuth consent
- grants and standing autonomy
- identity and one entry per connection in the Agents view (UI116-2)

The client label stays a recognition aid, not a verified identity.

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

## Implementation status (#179, 2026-10-02)

First implementation slice of #179. Engineering details are in
[AI providers](../development/ai-providers.md). This section records what is implemented and
verified in Docker, what is still open, and the implementation choices made inside the contract
above.

| Criterion | State | Evidence or reason |
| --- | --- | --- |
| PROV-1 | Partly | Five provider kinds, owner model (server-side keyless list where available, else typed), fixed or owner base URL, custody unchanged (migration `0042`). **Still one connection per owner**, used by both uses; "one or more connections" with a per-use choice is a follow-up. |
| PROV-2 | Implemented for both uses | One prompt assembly, parser, proposal path and stop/retry/pause flow in core; two wire adapters and a registry in `@flux/agent-runtime`; neutral copy. Production personal runs remain off (#68). |
| PROV-3 | Implemented | Price table, provider-reported and owner prices; reservation formula; enabling refused without a price; the conservative estimate bounds every provider. |
| PROV-4 | Implemented | Guarded transport for every adapter; save-time and connect-time host checks; operator allowlist `FLUX_AI_PRIVATE_TARGETS`; key absence checked per adapter. |
| PROV-5 | Implemented in the UI | Connect shows Claude Code, Codex and another MCP client with their commands. **Real Codex and Claude Code activations, and one other client, are not recorded** (no clients or public HTTPS host in the implementation sandbox). |
| PROV-6 | Partly | The adapter contract suite runs identically against Docker mocks of both wire formats. **Real-key smoke tests are unverified** for every named provider (no keys). **Provider terms marked `unknown` were not re-checked**: OpenAI, OpenRouter and Google pages were unreachable from the sandbox (egress blocked, 2026-10-02). |

Choices made within the contract, for review:

- **Price sources.** `provider_reported` is OpenRouter's own per-model price, read without a key
  when a connection is saved; each OpenRouter response's `usage.cost` is then the charge. A table
  or provider price cannot be overridden by the owner; an owner price is accepted only when
  neither exists, and may be zero. A connection may be saved without a price; no use can be
  enabled on it.
- **Price table.** Only Anthropic rows, read from Anthropic's pricing page and model overview on
  2026-10-02 (`claude-sonnet-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` and its dated snapshot,
  `claude-fable-5-1`). Other providers' pages could not be reached, so none of their models is
  listed and no price was invented.
- **Reservation.** A personal run reserves the formula at the connection's price; O-008's per-run
  setting is the ceiling it must fit, so a model whose largest request exceeds it is refused at
  enable and at invoke. A background comparison reserves the formula with O-007's 5-cent floor.
- **Input bound.** The Flux estimate is one token per two UTF-8 bytes plus framing. Anthropic's
  count endpoint is still called when the estimate fits, and only a higher count is used.
- **Effort and output.** Anthropic gets `effort: low`. Chat Completions has no field every model
  accepts (non-reasoning models reject `reasoning_effort`), so none is sent; `max_completion_tokens`
  (OpenAI) or `max_tokens` (others) bounds the output including any reasoning.
- **Structured comparison answers.** Core embeds the answer schema in the prompt for every
  provider; each wire format also carries it in its structured-output field (`output_config.format`,
  `response_format`). A compatible server that rejects that field fails closed.
- **Failure mapping.** 503 and 529 are `overloaded` on both wire formats.
- **Consent versions.** New consents are `o-007-2026-10-02` and `o-008-2026-10-02`; the earlier
  versions stay valid only for Anthropic `claude-sonnet-5` connections.

## Revisit when

Revisit when either of these holds:

- A provider's terms forbid the mode.
- Independent evidence shows that a provider cannot meet the same custody, cap
  and fail-closed gates. In that case only that provider is disabled.

The equal-treatment requirement stays.
