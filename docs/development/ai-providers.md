# AI providers (#179)

This page describes how an owner's AI connection reaches any supported provider and model with
the same Flux path ([F-020](../product/model-providers.md), PROV-1–PROV-6). The owner key custody,
consent, caps and fail-closed rules are those of
[background comparison](proactive-comparison.md) (O-007) and [personal runs](personal-runs.md)
(O-008); this page covers what is provider-specific and what is deliberately not.

## Layout

| Path | Role |
| --- | --- |
| `app/packages/contracts/src/ai-providers.ts` | Provider kinds, labels, fixed base URLs, key hints, the dated price table, `maxRequestMicros`, the model-list wire types. |
| `app/packages/core/src/ai/` | Key-format, model-id, base-URL and price validation; the conservative token estimate; price resolution; the endpoint-policy port. |
| `app/packages/core/src/proactive-comparison/dispatch.ts` | The comparison prompt, answer schema and parsing, shared by every provider. |
| `app/packages/core/src/personal-runs/` | The personal-run prompt, parsing, reservation and commit, shared by every provider. |
| `app/packages/agent-runtime/src/endpoint-policy.ts` | The SSRF guard: address classes, the operator allowlist, save-time and connect-time checks. |
| `app/packages/agent-runtime/src/guarded-fetch.ts` | The one HTTP transport of every adapter: guarded lookup, no redirects, size and time bounds. |
| `app/packages/agent-runtime/src/anthropic.ts`, `chat-completions.ts`, `openai-compatible.ts`, `comparison.ts` | The two wire formats, for personal runs and comparisons. |
| `app/packages/agent-runtime/src/registry.ts` | `providerPersonalCompute` and `providerComparison`: the adapter chosen by the connection's provider kind. |
| `app/packages/agent-runtime/src/model-list.ts` | Keyless model listings and the provider price listing. |
| `app/apps/server/src/proactive-comparison/ai-composition.ts` | The API's endpoint policy, save-time check and listings. |
| `app/apps/worker/src/proactive-comparison/providers.ts`, `personal-runs/composition.ts` | The worker's adapter registry. |
| `app/packages/db/migrations/0042_ai_provider_connections.sql` | The schema change, with a guarded pre-use reversal in `reverse/`. |

## Provider kinds and wire formats

| Kind | Wire format | Base URL | Key format | Models |
| --- | --- | --- | --- | --- |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `sk-ant-…` | typed (listing needs a key) |
| `openai` | Chat Completions | `https://api.openai.com/v1` | `sk-…`, not `sk-admin-…` | typed |
| `openrouter` | Chat Completions | `https://openrouter.ai/api/v1` | `sk-or-…` | listed with prices, no key |
| `gemini` | Chat Completions | `https://generativelanguage.googleapis.com/v1beta/openai` | `AIza…` | typed |
| `openai_compatible` | Chat Completions | the owner's URL | any visible ASCII, 8–512 characters | listed when the server answers `GET /models` without a key |

The base URLs are the providers' documented roots, written into the code; no environment
variable is read for them, so none can redirect a key. The OpenAI, OpenRouter and Gemini URLs and
key formats could not be re-checked against their documentation from the implementation sandbox
(2026-10-02); they are unverified until a real-key smoke test. A model id is the owner's free choice
within `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`; OpenRouter's `:online` variants, which add a
provider-hosted web search, are refused.

Both wire formats send the same request: the Flux system prompt, one user message, the output
bound, no tools, no streaming, no retries. The differences are the wire format only:

- Anthropic: `x-api-key`, `max_tokens`, `output_config.effort: "low"`, and for comparisons
  `output_config.format` with the answer schema; the official SDK with `maxRetries: 0` and the
  guarded transport as its `fetch`. Its token-count endpoint may raise the Flux estimate.
- Chat Completions: `Authorization: Bearer`, `max_completion_tokens` for OpenAI (its reasoning
  models accept nothing else) and `max_tokens` elsewhere, `response_format` with the answer schema
  for comparisons, and `usage: { include: true }` for OpenRouter, whose `usage.cost` becomes the
  charge. No effort field: non-reasoning models reject `reasoning_effort`, and the output bound,
  which includes reasoning tokens, stays the cost bound. A small fetch client, not a vendor SDK.

Every outcome maps to the same closed result: `completed` with `end_turn`, `max_tokens` (also a
Chat `length`), `refusal` (also a Chat `refusal` message or `content_filter`) or `stop_sequence`;
or `failed` with `rate_limited` (429), `overloaded` (503, 529), `timeout`, `aborted` or
`provider_error` (other statuses, redirects, malformed or oversized answers, lost connections).
`billed: 'none'` only when nothing was sent (no key, a refused endpoint); otherwise `unknown`.

## Prices, reservations and the input bound

A connection's price per 1M tokens (micro-dollars) comes from, in order: OpenRouter's own listing
(`provider_reported`, read without a key when the connection is saved), Flux's dated table
(`AI_PRICE_TABLE`, Anthropic models read on 2026-10-02), or the owner (`owner`, zero allowed). An
owner price is refused when a listed or table price exists. A connection without a price can be
saved but not enabled: `BACKGROUND_PRICE_UNKNOWN`, `PERSONAL_RUN_PRICE_UNKNOWN`, the reservation
refusal `CONNECTION_PRICE_UNKNOWN`, and the assistant state `unavailable` / `price_unknown`.

- A personal run reserves `16,000 × input + 1,500 × output` at the connection's price. The owner's
  per-run setting is the ceiling it must fit (`PERSONAL_RUN_COST_OVER_LIMIT`, `run_cost_over_limit`).
- A comparison reserves `8,000 × input + 1,200 × output`, at least O-007's $0.05.
- Usage is charged at the connection's price, or as the provider reported it.

The input of every provider is bounded by `conservativeTokenEstimate`: one token per two UTF-8
bytes plus framing, above the major tokenizers' counts for prose in Latin, Polish and CJK text.
Anthropic's count endpoint is still called when the estimate fits; only a higher count is used.
The estimate is not an exact count: a provider may still report more input than estimated for
unusual text (long digit runs, emoji), which the comparison treats as invalid usage (`unknown`).

## Endpoint guard (SSRF)

Owner-set base URLs (`openai_compatible`) must be public HTTPS. `literalRefusal` refuses other
schemes, credentials, IP literals and `localhost` names that are not public; `checkEndpoint`
resolves the host and refuses it if any address is private (RFC 1918), loopback, link-local,
unique-local (ULA), CGNAT, reserved, multicast, NAT64, Teredo/6to4 or an IPv4-mapped form of
these. Cloud metadata addresses (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`,
`168.63.129.16`, `fd00:ec2::254`) are refused always.

The operator variable `FLUX_AI_PRIVATE_TARGETS` (API and worker; see [containers](containers.md))
is the only way to open private targets: comma-separated host names (exact), addresses or CIDR
ranges, for example `ollama,10.0.0.0/8`. Plain HTTP is accepted only for such allowed private
targets. A malformed entry stops the API and worker at startup.

The check runs when a connection is saved (`AI_ENDPOINT_REFUSED`) and when a model list is read,
and again in the socket's own lookup for every request (`guardedLookup`), so the address that is
checked is the address connected to; a DNS answer that changes after saving is refused at
dispatch. The transport never follows a redirect, aborts after its time bound and drops a
response above its size bound (1 MB for model answers, 4 MB for model lists). Error bodies are
never read into errors or logs.

## Model lists

`POST /api/v1/ai-model-lists` `{ provider, baseUrl? }` (signed-in person) returns
`{ provider, status, models, checkedOn }`. `listed` comes with model ids (and OpenRouter prices);
`needs_key` for providers that list models only with a key, which the API never holds; `refused`
for an endpoint the guard refuses; `unavailable` when the endpoint does not answer a model list.

## Keys

Custody is unchanged: AEAD with the owner and connection ids, decrypted only in the worker for one
request. A key never appears in API responses, error bodies, logs, stream frames, job rows,
candidates or proposals. Seeded keys of every adapter carry the marker `owner-budget-key-`, which
`scripts/check_application.sh` looks for in the API, worker and provider-mock logs, and
`ai-connections.test.ts` in stored candidates, proposals, events and jobs.

## Tests

| File | Covers |
| --- | --- |
| `app/tests/app/provider-adapters.test.ts` | The adapter contract suite: one set of cases, run identically against the Docker `providermock` for both wire formats (success, truncation, refusal, 429, 529/503, other errors, timeout, abort, malformed, usage-less, redirect, oversized, refused endpoints, environment variables, usage and cost, keys absent from results, errors and console), plus the comparison adapters, OpenRouter cost, OpenAI's token field and keyless model lists. |
| `app/tests/app/ai-endpoint-guard.test.ts` | Address classes, the allowlist, DNS rebinding, redirects, size and time bounds; key formats, model ids, base URLs and the estimate. |
| `app/tests/app/ai-connections.test.ts` | The API: every provider kind, validation, save-time SSRF refusals, model lists, enabling without a price, and worker dispatch on both wire formats with reservation and usage at the connection's price. |
| `app/tests/app/personal-runs-providers.test.ts` | Personal runs through the real registry on both wire formats. |
| `app/tests/app/ai-connections-migration.test.ts` | `0042` on earlier data, its constraints and its guarded reversal. |
| `app/tests/ui/test_ai_connections.py` | The settings form, model listing, prices, refused endpoints, phone width, neutral copy and the Connect guide. |

The mocks (`app/tests/app/support/provider-mock.ts`, `app/tests/ui/openai_mock.py`) are never a
provider. Nothing here is a provider, billing or compatibility pass; real-key smoke tests remain
open for every named provider.

## Not yet done

- More than one connection per owner, and choosing the connection per use (PROV-1).
- The production personal-run connection lookup and key resolver (#68), which then composes
  `providerPersonalCompute({ enabled, resolveKey, policy: aiEndpointPolicyFromEnv(env) })`.
- Real-key smoke tests per named provider, and a check of OpenAI, OpenRouter and Gemini terms and
  documentation against dated primary sources (PROV-6).
- Real Codex and Claude Code connections and one other MCP client (PROV-5).
