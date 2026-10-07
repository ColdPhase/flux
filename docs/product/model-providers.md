# F-020 — provider-neutral Flux agent

**Founder requirement, 2026-10-02.** Hubert (@PelikanFix16) gave this direction in
the supervising session: the Flux agent must not be only a connectable cloud
Claude agent. It must also work with OpenAI Codex and similar clients, and with
an API key for OpenRouter or any other provider. Every model must get equal
support inside the Flux agent. Implementation is tracked in
[#179](https://github.com/ColdPhase/flux/issues/179).
**Owner:** @PelikanFix16. **Evaluator:** @Zamojski5.

> **Two-mode framing: [F-022](ai-modes.md), revised and accepted 2026-10-05.**
> Everything here is mode (a) (the agent in Flux) except PROV-5, which is mode (b)
> (your agent app over MCP). F-022 adds a connection *transport* (PROV-1), run caps
> for `runtime` connections that replace the money reservation, the single bounded
> request and the input bound (PROV-3), and replaces PROV-4's subscription sentence.

This decision **supersedes the Anthropic-only provider scope** of
[O-007](background-compute.md) and [O-008](personal-runs-compute.md), O-008's
deferral of local models, and the Anthropic preflight count as the input bound
([PROV-3](#prov-3--cost-caps-and-token-bounds)). Everything else in those decisions
stays in force:

- owner custody of the key and payer attestation
- [F-019](decisions.md) owner-only use
- separate consent per use
- daily caps and per-run reservations
- one bounded request per run (for `runtime` connections, F-022's turn and MCP
  result caps instead; [PROV-3](#prov-3--cost-caps-and-token-bounds))
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
- **Transport ([F-022](ai-modes.md#aim-1--mode-a-the-agent-in-flux)):** `server`
  (the Flux worker calls the provider with the key above; every provider kind) or
  `runtime` (the owner's unmodified official CLI, client `claude_code` or `codex`,
  runs in the owner's runtime slot under the owner's own sign-in, with any method
  of the CLI's own login command;
  [AIM-3](ai-modes.md#aim-3--the-runtime-transport)). A `runtime` connection has no
  key, base URL or price in Flux. Its MCP access goes through an owner-consented
  agent connection ([F-022](ai-modes.md#agent-connection-and-permissions)).

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
- **`runtime` connections.** The CLI runs its own loop. Flux still owns the
  brief, the place, the tools (the exact Flux MCP tools only; every built-in and
  local tool is off and read back before use), output parsing, proposals, stop
  and audit ([AIM-3](ai-modes.md#hardening-no-local-tool)).
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
as `unknown`. The charge of a run never exceeds its reservation: reported usage
above the request's maximum input or output tokens, or a reconciled cost above
the reservation, is treated like a lost response. The run fails closed: the cost
stays `unknown`, the whole reservation stays counted against the daily cap, the
reported numbers are not stored as the charge, and the answer is withheld.

**`runtime` connections ([F-022](ai-modes.md#caps)).** The owner's plan reports
no per-token price, so the price source and money reservation do not apply.
Consent and pause stay. A use is bounded instead by:

- runs per day;
- one serial lane per runtime slot (sign-in, status, run and sign-out);
- a wall-clock timeout (default five minutes) and a no-event timeout;
- maximum turns;
- MCP result size per tool call and per run;
- maximum answer size.

Usage shows with a payer label from the sign-in method, for example "your Claude
plan (plan limits or paid extra usage, not visible to Flux)", never as zero. A plan
limit the CLI reports, or an expired login, fails closed. Nothing falls back to an
API key. Whether the vendor draws paid extra usage instead is not visible to Flux
([F-022](ai-modes.md#payer-and-data)).

**Input bound.** The same conservative Flux token estimate bounds input for every
provider. A provider token-count endpoint may tighten the estimate, never loosen
the bound. This replaces O-007/O-008's preflight count with the Anthropic
token-counting endpoint as the bound; that endpoint becomes one optional refinement.
For `runtime` connections Flux does not assemble the input: the CLI fetches its
context through MCP. There the bound is the MCP result size per call and per run,
together with maximum turns.

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

**Subscriptions ([F-022](ai-modes.md), revised 2026-10-05; replaces the earlier
blanket exclusion).**

- A subscription enters mode (a) only through the unmodified official CLI
  (`claude`, `codex`) in the owner's runtime, signed in through the CLI's own flow
  ([AIM-3](ai-modes.md#aim-3--the-runtime-transport)).
- Flux never persists, logs or parses the vendor credential. It lives only in
  that owner's binding directory in the runtime slot's volume, written by the CLI's
  own flow, never in the database, queue, logs, exports, API responses or admin UI.
  The sign-in console relays what the owner types at the CLI's own prompt, in
  memory only. The supervisor beside the CLI and the host root could technically
  read the stored login; the supervisor never opens it.
- Flux never collects or forwards a consumer sign-in, session or CLI credential
  (a pasted `claude setup-token`, `~/.codex/auth.json`, claude.ai or ChatGPT
  cookies), and never impersonates another application's OAuth client.
- A subscription also works in mode (b), through the person's own client (PROV-5).

## PROV-5 — external clients are equal too

Connect offers equivalent guidance for Claude Code, Codex and a generic MCP
client, with each client's own add and login commands. All of them get the same:

- OAuth consent
- grants and standing autonomy
- identity and one entry per connection in the Agents view
  ([CO-1](mcp-cowork.md#connections-and-owner-authorized-autonomy--co-1))

The client label stays a recognition aid, not a verified identity.

Flux tokens are audience-bound to the Flux MCP resource, and Flux never accepts or
passes through a client's provider token (MCP authorization 2026-07-28;
[AIM-2](ai-modes.md#aim-2--mode-b-your-agent-app-over-mcp)).

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

**`runtime` connections ([F-022](ai-modes.md)).** Fake `claude` and `codex` binaries
with the real argv and JSONL shapes run in Docker. They cover every sign-in method,
real MCP calls with the run token, success, expired login, plan limit, timeouts,
crash, stop, oversized output, an extra tool at start, redaction, escape attempts
and token absence on the Flux side. A test checks that no Compose file mounts a
Docker or Podman socket. A flag contract test runs the pinned real CLIs' `--help`,
and a read-back test checks the pinned real Codex's effective config. A
real-account smoke test for each CLI, with an adversarial no-tool check, is dated
and recorded, or reported unverified
([test plan](research/2026-10-04-two-ai-modes-plan.md#docker-test-plan)).

## Implementation status (#179, 2026-10-02)

First implementation slice of #179. Engineering details are in
[AI providers](../development/ai-providers.md). This section records what is implemented and
verified in Docker, what is still open, and the implementation choices made inside the contract
above.

| Criterion | State | Evidence or reason |
| --- | --- | --- |
| PROV-1 | Implemented | Five provider kinds, owner model (server-side keyless list where available, else typed), fixed or owner base URL, custody unchanged (migration `0042`). Since 2026-10-03, several named connections per owner: background comparisons use the one the owner marks, the assistant the one its consent names; removing one stops its use without fallback. |
| PROV-2 | Implemented for both uses | One prompt assembly, parser, proposal path and stop/retry/pause flow in core; two wire adapters and a registry in `@flux/agent-runtime`; neutral copy. Production personal runs remain off (#68). |
| PROV-3 | Implemented | Price from Flux's dated table or the owner only; reservation formula; enabling refused without a price; a provider-reported cost (OpenRouter `usage.cost`) only reconciles the charge; the conservative estimate bounds every provider. |
| PROV-4 | Implemented | Guarded transport for every adapter; save-time and connect-time host checks; operator allowlist `FLUX_AI_PRIVATE_TARGETS`; key absence checked per adapter. |
| PROV-5 | Implemented in the UI | Connect shows Claude Code, Codex and another MCP client with their commands. **Real Codex and Claude Code activations, and one other client, are not recorded** (no clients or public HTTPS host in the implementation sandbox). |
| PROV-6 | Partly | The adapter contract suite runs identically against Docker mocks of both wire formats. **Real-key smoke tests are unverified** for every named provider (no keys). Provider terms were re-checked on 2026-10-03 against dated primary sources (see [AI providers](../development/ai-providers.md#provider-terms-2026-10-03)): none forbids an owner using their own key in their own Flux, so no provider is disabled; Gemini's conditions are shown with its key field. |

Choices made within the contract, for review:

- **Price sources.** `table` or `owner` only. A table price cannot be overridden by the owner; an
  owner price is accepted only when the table has no row for the model, and may be zero. A price
  OpenRouter lists for a model is only offered as the starting value of the owner's price. A
  connection may be saved without a price; no use can be enabled on it. OpenRouter's response
  `usage.cost` reconciles the run's charge and never changes its reservation.
- **Price table.** Only Anthropic rows, read from Anthropic's pricing page and model overview on
  2026-10-02 (`claude-sonnet-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` and its dated snapshot,
  `claude-fable-5-1`). Other providers' pages could not be reached, so none of their models is
  listed and no price was invented.
- **Reservation.** A personal run reserves the formula at the connection's price; O-008's per-run
  setting is the ceiling it must fit, so a model whose largest request exceeds it is refused at
  enable and at invoke. A background comparison reserves the formula with O-007's 5-cent floor.
- **Input bound.** The Flux estimate is one token per UTF-8 byte plus framing. Byte-level BPE and
  SentencePiece tokenizers (with byte fallback) emit at least one byte per token, so this is an
  upper bound for any text, including CJK, emoji and digit runs; it halves the prose that fits in
  16,000 tokens compared with a per-two-bytes estimate. Anthropic's count endpoint is still called
  when the estimate fits, and only a higher count is used.
- **Charge bound.** A personal run whose reported usage exceeds its token limits, or whose
  reconciled cost exceeds its reservation (including a large OpenRouter `usage.cost`), ends
  `provider_failed` with cost `unknown`, its reservation retained, and no answer or proposal, as a
  comparison ends `unknown` with `INVALID_OBSERVED_USAGE` / `OBSERVED_COST_OVER_CEILING`.
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
