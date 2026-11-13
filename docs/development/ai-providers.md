# AI providers (#179)

This page describes how an owner's AI connection reaches any supported provider and model with
the same Flux path ([F-020](../product/model-providers.md), PROV-1–PROV-6). The owner key custody,
consent, caps and fail-closed rules are those of
[personal runs](personal-runs.md) (O-008); this page covers what is provider-specific and what is deliberately not.

## Layout

| Path | Role |
| --- | --- |
| `app/packages/contracts/src/ai-providers.ts` | Provider kinds, labels, fixed base URLs, key hints, the price list's types and `listPrice`, `maxRequestMicros`, the model-list wire types. |
| `app/packages/core/src/ai/` | Key-format, model-id, base-URL and price validation; the conservative token estimate; price resolution; the endpoint-policy port. |
| `app/packages/core/src/proactive-comparison/dispatch.ts` | The comparison prompt, answer schema and parsing, shared by every provider. |
| `app/packages/core/src/personal-runs/` | The personal-run prompt, parsing, reservation and commit, shared by every provider. |
| `app/packages/agent-runtime/src/endpoint-policy.ts` | The SSRF guard: address classes, the operator allowlist, save-time and connect-time checks. |
| `app/packages/agent-runtime/src/guarded-fetch.ts` | The one HTTP transport of every adapter: guarded lookup, no redirects, size and time bounds. |
| `app/packages/agent-runtime/src/anthropic.ts`, `responses.ts`, `chat-completions.ts`, `openai-compatible.ts` | The three wire formats of personal runs: Anthropic Messages, OpenAI's Responses API (#954) and Chat Completions. |
| `app/packages/agent-runtime/src/registry.ts` | `providerPersonalCompute` and `providerComparison`: the adapter chosen by the connection's provider kind. |
| `app/packages/agent-runtime/src/model-list.ts` | Keyless model listings (OpenRouter, an OpenAI-compatible endpoint) and the listings read with a key (Anthropic, OpenAI, Gemini; #1218). |
| `app/packages/contracts/src/ai-model-families.ts` | A listed model's family and the newest-first order of the picker (#1218). |
| `app/apps/server/src/ai-keys/` | The key form's listing and key test (6-hour cache by key digest), Try again and the owner's model prices; `model-refresh.ts` asks the worker to read a stored key's list. |
| `app/apps/worker/src/ai-keys/model-lists.ts` | Reads a stored key's models (`api-key.model-list.v1`): the only process that opens a stored key. |
| `app/apps/server/src/proactive-comparison/ai-composition.ts` | The API's endpoint policy, save-time check and listings. |
| `app/apps/worker/src/proactive-comparison/providers.ts`, `personal-runs/composition.ts` | The worker's adapter registry. |
| `app/packages/db/migrations/0001_v0_1_baseline.sql` | The schema (the v0.1 baseline, #779). |

## Provider kinds and wire formats

| Kind | Wire format | Base URL | Key format | Models |
| --- | --- | --- | --- | --- |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `sk-ant-…` | listed with the key: `GET /v1/models?limit=1000` (`Authorization: Bearer` and `anthropic-version: 2026-10-21`, as the adapter), with `display_name`, `line`, `created_at`; retired ones left out |
| `openai` | Responses API (#954) | `https://api.openai.com/v1` | `sk-…`, not `sk-admin-…` | listed with the key: `GET /models` (`Authorization: Bearer`), chat models only, no dated snapshot beside its alias |
| `openrouter` | Chat Completions | `https://openrouter.ai/api/v1` | `sk-or-…` | listed without a key (listed prices only prefill the owner's price) |
| `gemini` | Chat Completions | `https://generativelanguage.googleapis.com/v1beta/openai` | `AIza…` | listed with the key: `GET /v1beta/models?pageSize=1000` (`x-goog-api-key`), models that `generateContent`, no audio, image or embedding ones |
| `openai_compatible` | Chat Completions | the owner's URL | any visible ASCII, 8–512 characters | listed when the server answers `GET /models` without a key |

The base URLs are the providers' documented roots, written into the code; no environment
variable is read for them, so none can redirect a key.

Re-checked on 2026-10-03 against the providers' own documentation:

- **Gemini:** OpenAI compatibility, last updated 2026-09-02. Base URL
  `https://generativelanguage.googleapis.com/v1beta/openai/`, `Authorization: Bearer`, chat
  completions and a models list.
- **OpenRouter:** API reference. Base `https://openrouter.ai/api/v1`, `Authorization: Bearer`, and
  `usage.cost` in the response.

Both are vendor claims. The key formats are not stated on those pages, and none of the three
providers is exercised with a real key yet. A model id is the owner's free choice
within `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`; OpenRouter's `:online` variants, which add a
provider-hosted web search, are refused.

Every wire format sends the same request: the Flux system prompt, one user message, the output
bound, no tools (a `server` run with the Flux tool loop adds the Flux tools and, while the operator's `FLUX_WEB_READS`
is on, the provider's own web search where it has one, each request one turn: see
[personal runs](personal-runs.md#tool-loop-f-027-ast-8-406-first-part) and [web search](personal-runs.md#web-search-954)), no streaming, no retries. The differences are the wire format only:

- Anthropic: `Authorization: Bearer` (the key; SDK 1.x sends an API key there, not in `x-api-key`, #1240), `max_tokens`, `output_config.effort: "low"`, and for comparisons
  `output_config.format` with the answer schema; the official SDK with `maxRetries: 0` and the
  guarded transport as its `fetch`. Its token-count endpoint may raise the Flux estimate.
- OpenAI Responses (#954): `Authorization: Bearer`, `POST <base>/responses`, the brief as `instructions`,
  `max_output_tokens` (it includes reasoning tokens), `store: false` (nothing is kept at OpenAI; a run's
  earlier turns travel in every request as the model's words and function calls, without item ids; no
  reasoning is carried between turns and no encrypted reasoning is asked for, which non-reasoning models refuse),
  function tools with `strict: false`, results as `function_call_output` items. No effort field. A small
  fetch client, not a vendor SDK. Flux speaks it to OpenAI because OpenAI's own web search is a Responses
  tool; GPT-6 Astra and GPT-6.1 Sol, which call tools only there, call tools now.
- Chat Completions (OpenRouter, Gemini's compatible endpoint, self-hosted servers): `Authorization: Bearer`,
  `max_tokens`, `response_format` with the answer schema for comparisons, and `usage: { include: true }`
  for OpenRouter, whose `usage.cost` becomes the charge. No effort field: non-reasoning models reject
  `reasoning_effort`, and the output bound, which includes reasoning tokens, stays the cost bound. A small
  fetch client, not a vendor SDK.

Every outcome maps to the same closed result: `completed` with `end_turn`, `max_tokens` (also a
Chat `length`), `refusal` (also a Chat `refusal` message or `content_filter`) or `stop_sequence`;
or `failed` with `rate_limited` (429), `overloaded` (503, 529), `timeout`, `aborted` or
`provider_error` (other statuses, redirects, malformed or oversized answers, lost connections).
`billed: 'none'` only when nothing was sent (no key, a refused endpoint); otherwise `unknown`.

## Provider terms (2026-10-03)

PROV-6 asks for the terms marked `unknown` in the [feasibility study](../product/own-ai-feasibility.md)
to be checked against dated primary sources. Read on 2026-10-03; quotes are vendor claims, the
conclusions are Flux inferences. Flux's use is the same for every provider: one owner enters
their own key, it is encrypted at rest, and only that owner's runs and comparisons use it
(F-019); Flux never shares, pools, resells or pays for a key.

| Provider | Source and date | What it says | Conclusion |
| --- | --- | --- | --- |
| OpenAI | OpenAI Services Agreement, `cdn.openai.com/osa/openai-services-agreement.pdf` ("ONLINE v.010126", effective 2026-01-01; file Last-Modified 2025-12-01). The HTML policy page answered HTTP 403, so a later revision cannot be excluded. | §2.2: the right "to use OpenAI's API to integrate the Services into Customer Applications and to make Customer Applications available to End Users". §3.1: "Customer will not share Account access credentials or individual login credentials between multiple users." §3.3(g): no "buy, sell, or transfer API keys from, to, or with a third party". | Allowed: the owner integrates their own key into an application they use. Flux keeps each key to its one owner, which matches §3.1 and §3.3(g). |
| OpenRouter | Terms of Service, `openrouter.ai/terms`, "Last Updated: August 31, 2026". | §2: "at least 18 years of age". §3.2: keep "confidentiality and security of all API keys, tokens, passwords, and other credentials". §7: no "reselling API access to Models or otherwise developing a competing service", no "sell or otherwise transfer the access granted". | Allowed: an owner's own key for their own use, stored encrypted, is neither resold nor transferred. |
| Gemini | Gemini API Additional Terms of Service, `ai.google.dev/gemini-api/terms`, "Effective March 23, 2026". | "for developers building with Google AI models for professional or business purposes, not for consumer use"; "18 years of age or older"; access only "within an available region"; "You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom." Unpaid Services may use prompts and responses to improve Google's products, with human review. | Allowed with conditions that bind the key owner. The key field says that only a paid key may be used in the EEA, Switzerland and the UK. Flux cannot see a key's billing state, so it does not enforce this. |

`openai_compatible` endpoints are the owner's own servers or services and carry their own terms.
Anthropic was confirmed in O-007/O-008 and is unchanged.

## Prices, reservations and the input bound

A connection's price per 1M tokens (micro-dollars) comes only from the price list of the place the key pays (source `list`, with
the day the list was fetched: LiteLLM's for Anthropic, OpenAI and Gemini, OpenRouter's own for OpenRouter) or from the owner (`owner`,
zero allowed), because a reservation needs a price before any response exists (#1465,
[CA-2](../product/model-providers.md#ca-2--models)). An owner price is refused when a list has the model. A connection without
a price can be saved but not used: the assistant state `unavailable` / `price_unknown`.

A list price may carry long-prompt tiers (`AiPrice.tiers`, `{ fromTokens, inputMicrosPerMTok, outputMicrosPerMTok }`):
`maxRequestMicros(price, input, output, searches, promptTokens)` prices at `rateAt(price, promptTokens)`, the highest price the
prompt reaches. A reservation passes the longest prompt the request can be (a server run's bound; the gateway's `inputBoundTokens`),
a charge (`usageMicros`) the reported `inputTokens`, the whole prompt with cache reads and writes, while the billed tokens keep their
cache rates. An owner price has no tiers.

How the lists move:

| Piece | Where |
| --- | --- |
| Reading LiteLLM's file into Flux's prices (provider and mode filter, ids, bounds, `_above_<N>k_tokens` tiers from N×1000+1 tokens, whole-file refusal) | `parsePriceList`, `isPriceList` in `app/packages/core/src/ai/price-list.ts` |
| OpenRouter's prices: its keyless model list with `overrides` (`min_prompt_tokens`) as tiers; a variable or malformed price is none | `openRouterRate` in `app/packages/agent-runtime/src/model-list.ts`, `openRouterPriceList` in core |
| The anonymous daily GET of LiteLLM's file through the egress guard (16 MB, 30 s); test stacks ask `<FLUX_TEST_PROVIDER_LISTS>/price-list` and `/openrouter/v1/models` | `fetchPriceList`, `priceListFetchOptions`, `keyListingOptions` in `app/packages/agent-runtime/src/` |
| The job: daily at 04:17 UTC and at start when the stored LiteLLM list is a day old; OpenRouter's list too while anyone has an OpenRouter key; retried 3 times 15 minutes apart; a failure keeps the last good list | `app/apps/worker/src/ai-keys/price-list.ts` (`ai-price-list.refresh.v1`) |
| OpenRouter's list read by the API: when the form lists OpenRouter's models, and at connect when the stored one is a day old | `priceList` in `app/apps/server/src/ai-keys/routes.ts` |
| The stored lists: one row per list (`litellm`, `openrouter`), each replaced only by a list fetched the same day or later | `ai_price_lists` (migration 0081), `aiPriceListRepository`, `storedPriceLists` |
| The shipped list: LiteLLM's entries for Anthropic, OpenAI and Gemini text models as fetched on the release's build day, stored by the migrator when the database has none or an older one | `scripts/update_price_list.py` writes `app/packages/core/src/ai/price-list-snapshot.ts`; `shippedPriceList()`; `app/tooling/migrate.ts` |
| A stored connection's price: the list's price of today for its model, else the stored one (a stored price keeps no tiers) | `currentConnectionPrice` (contracts), applied by `connectionPrice` in the connection repositories |
| The Connect AI form's prices: `priceList` of the `POST /api/v1/ai-model-lists` answer; OpenRouter's list is read when it is chosen | `app/apps/server/src/ai-keys/routes.ts`, `ConnectionFields.tsx` |

A listed model the list does not price is still offered: its owner enters its price for that key
(`PUT /api/v1/background-compute-connections/:id/model-price`, kept in `model_prices`); once the list prices it, the list's price
is used.

- One request of a personal run is bounded at `32,000 × input + 4,000 × output` at the key's price (`64,000 × input`
  for a request of a run with tools; #484, #843). When the worker starts the run it reserves its turns × that
  largest request, never above what is left of the key's one daily budget (`budgetedReservationMicros`, #854);
  a request that finds not even one request's room left waits for the key's next day (`end_reason = 'budget'`,
  `resume_at`). There is no per-run ceiling.
- A comparison reserves `8,000 × input + 1,200 × output`, at least O-007's $0.05, against the same daily budget
  of the background key (`apiKeySpendToday` counts personal runs and comparisons on the key together).
- Usage is charged at the connection's price, or reconciled at the cost the provider reported in
  the response (OpenRouter `usage.cost`), which never raises or bypasses the reservation.
- A search of the provider's own web search (#954) is charged `WEB_SEARCH_MICROS` ($0.01; Anthropic and
  OpenAI both list $10 per 1,000, read 2026-11-08) on top of the tokens, as the provider reports it. There is no limit on the searches of a request
  or a run (#1113), so none is reserved. A response that reports searches when its request offered none is outside its bounds (a lost response),
  and so is one whose cost passes what the run has left. A request that offers the search has room for its results in its input bound
  (`WEB_SEARCH_INPUT_TOKENS`, 50,000 tokens in all, Flux's assumption), reserved at the input price; the input a request that searched reports is
  held to the run's money, not to that bound. A key's budget must hold one request with that room when its provider has a search. A refused
  search is not billed and the request is sent once more without it.
- The charge never exceeds the reservation (`boundedUsageMicros`). Usage above the request's token
  limits, or a cost above its reservation, is not stored: a personal run ends `provider_failed`
  with cost `unknown` and its reservation counted, and a comparison ends `unknown`
  (`INVALID_OBSERVED_USAGE`, `OBSERVED_COST_OVER_CEILING`). Nothing is posted in either case.

The input of every provider is bounded by `conservativeTokenEstimate`: one token per UTF-8 byte
plus framing. Byte-level BPE and SentencePiece tokenizers emit at least one byte per token, so
this is an upper bound for any text (prose, CJK, emoji, digit runs).
It replaces O-007/O-008's Anthropic preflight count as the bound. Anthropic's count endpoint is
still called when the estimate fits, as an optional refinement: only a higher count is used.
A provider that still reports more usage than the bound is handled by the charge bound above.

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
`{ provider, status, models, checkedOn }`. `listed` comes with model ids (and OpenRouter's listed
prices, a suggestion for the owner only);
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
| `app/tests/app/web-search.test.ts` | The provider's own web search on Anthropic Messages and the Responses API against the Docker mock, a search's results as its own run's addresses through the real worker and `/mcp`, the sources line, the charge and the operator switch (#954). |
| `app/tests/app/ai-connections-migration.test.ts` | `0042` on earlier data, its constraints and its guarded reversal. |
| `app/tests/ui/test_ai_connections.py` | The settings form, model listing, prices, refused endpoints, phone width, neutral copy and the Connect guide. |

The mocks (`app/tests/app/support/provider-mock.ts`, `app/tests/ui/openai_mock.py`) are never a
provider. Nothing here is a provider, billing or compatibility pass; real-key smoke tests remain
open for every named provider.

## Not yet done

- Done 2026-10-03 (PROV-1):
  - Several connections per owner, each named. Adding one never replaces another.
  - The assistant uses the one its consent names, chosen when enabling. (Background comparisons
    used the one the owner marked, `usedForBackground`; they went in #858.)
  - Removing a connection stops its use, with no fallback.
  - The production personal-run lookup, key resolver and the `FLUX_PERSONAL_RUNS` operator switch
    are in place (see personal-runs.md).
- Real-key smoke tests per named provider (PROV-6). The provider terms, the base URLs (Gemini and
  OpenRouter) and the OpenAI and Gemini prices were checked on 2026-10-03.
- Real Codex and Claude Code connections and one other MCP client (PROV-5).
