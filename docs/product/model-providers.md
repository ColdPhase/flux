# Connect AI and models (F-036; amends F-020)

**Status:** founder direction, Hubert (@PelikanFix16), 2026-11-02/03
([#851](https://github.com/ColdPhase/flux/issues/851), [#854](https://github.com/ColdPhase/flux/issues/854),
[#843](https://github.com/ColdPhase/flux/issues/843)), recorded 2026-11-03 in
[#852](https://github.com/ColdPhase/flux/issues/852); independent review pending
([F-036](decisions.md#f-036--simple-ai-everything-is-an-agent)). F-020's provider neutrality, key
custody and adapter evidence stay; its per-run reservation and per-request ceiling go. The earlier
text is at [`a82ee012`](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/model-providers.md),
and engineering notes are in [AI providers](../development/ai-providers.md).

A person connects AI once, in Settings › AI. Their connections power all of their
[agents](assistant.md), with no consent screen per feature.

## CA-1 — Connections

- A person may hold several connections at the same time:
  - **Claude plan.** Sign-in in the unmodified Claude Code on the Flux server, through the CLI's
    own login ([where agents run](ai-modes.md#rt-6--sign-in)).
  - **ChatGPT plan.** Device sign-in in the official Codex CLI on the Flux server.
  - **API key.** Anthropic, OpenAI, OpenRouter, Gemini or an OpenAI-compatible endpoint,
    including a self-hosted model (F-020's list stays; [coordinator default C-11](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). An Anthropic key from the Console organization linked
    to a Claude Max, Ultra or Team plan uses that plan's monthly API credits; Flux calls them
    "API credits", not the plan.
- Each connection is made once and shows one line: its status and the provider's remaining usage
  (CA-3).
- A connection belongs to one person. It is never shared with a team or the company, and nobody
  else's action spends it except through the person's own agents (F-019).
- Removing a connection pauses the agents that use it until their owner picks another model
  ([coordinator default C-3](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).

## CA-2 — Models

- Each agent picks its model from any of its owner's connections. The picker is grouped by
  connection, for example "Claude plan: Opus · Sonnet · Haiku" and "ChatGPT plan: GPT-6.1 Sol ·
  Astra · Luna". Connect AI sets the default for new agents: the connection made first, at its
  default model (implemented on the assistant, #854; wave 2 #857 moves it onto every agent).
- **An API key's models come from the provider, read with that key** (founder direction, Hubert,
  2026-11-10 and 2026-11-12, [#1218](https://github.com/ColdPhase/flux/issues/1218)). There is no
  model list written into Flux anywhere in the picker: Flux's price table only prices a listed
  model and never decides which models show, so a newly released model appears without a Flux
  release. Until the provider's list is read (a key added before v0.2.1 waits for its first
  reading), the key offers only its own model.
  - **Adding a key** asks Provider → API key → Model. When the key is typed, the Flux server
    lists that key's models (Anthropic `GET /v1/models`, OpenAI `GET /v1/models`, Gemini
    `models.list`). That one call is also the key test: a key the provider refuses says "This key
    was refused by Anthropic" and is not saved. A list that can't be read (a timeout, a 5xx) leaves
    a free field for the model id with a plain note, and the key can still be saved.
  - **The Model control** is a dropdown of the chat models the key can use, grouped by family
    (Opus, Sonnet, Haiku, Fable…) with the newest family and model first, each with its price or
    "price unknown, enter it". The provider's own display name is shown where it gives one. Nothing
    is preselected. "Other model id…" opens a field for an id the list doesn't have.
  - **OpenRouter and an OpenAI-compatible endpoint** keep their `/models` list read without a key
    (an endpoint's server usually answers it without one), and the free field as a fallback.
  - **Fresh and bounded.** A key's list is read again when its picker opens and the last reading is
    more than 6 hours old, and with Try again. A saved key's list is read by the worker, the only
    process that opens a stored key (CA-4); a key being added is listed by the API with the key the
    person just typed, before it is sealed. Every listing goes through the same endpoint guard as a
    run (CA-4). A list that can't be read says so, keeps the saved model and offers Try again; no
    raw error is shown.
- **Price (PROV-3).** The daily budget prices every request before it is sent, so a model needs a
  price. A listed model with a row in Flux's dated table uses it. A listed model without one stays
  selectable once the owner enters its price for that key (zero for a self-hosted endpoint): "Flux
  doesn't know this model's price yet. Enter it to use it with a daily budget." A price a provider
  lists (OpenRouter) is only offered as the starting value. The table follows the providers'
  pricing pages, dated, with the primary source; a promotional price that ends on a known date is
  left out, and a model priced by prompt length uses the tier Flux's largest request can reach.
- **A model the provider retires** (in an earlier list of the key, missing from a later one) shows
  as "no longer offered by Anthropic". The agents on it pause until their owner picks another model
  (like C-3); Flux never switches the model by itself.
- A model the plan refuses gives one line: "Your Claude plan didn't accept Opus". Nothing switches
  to another model.
- An API-key model that cannot call tools can answer but cannot change anything, and the picker
  says so.

## CA-3 — The provider's limits, not Flux's

- **No Flux limits.** Flux has no runs a day, time, steps or changes per run of its own, and no
  limit on background runs or schedules. The only bounds
  left are technical safety limits that nobody meets in normal use (one run's hour of wall clock,
  ten minutes without a sign of life, 200 steps, a 64 KiB answer, tool results of 256 KiB a call and
  8 MiB a run, 20 waiting requests a person); the [runtime guide](../operations/agent-runtime.md#runs)
  lists them with where each is set (#843).
- **The provider's remaining usage** shows in Settings and on the agent where the provider reports
  it. Otherwise the line says "Plan limits apply". It is never shown as zero.
- **A plan at its limit.** The agent pauses with one line, for example "Claude limit reached,
  resumes at 14:00", or without a time when the provider gives none, and resumes by itself after
  the reset (a request waits for it in the queue). On a CLI in the runtime this includes the API's
  own rate limit (Claude Code's "Request rejected (429)", Codex's 429s), not the vendor's "not your
  usage limit" capacity message ([#1129](https://github.com/ColdPhase/flux/issues/1129)). A request
  longer than the model's context window ends "This conversation is too long for one request", as
  on an API key.
  It never switches to another connection or provider, and there is no switch button. A request
  that already changed something is not run again: it ends with the line and how many changes
  were made. When Anthropic's monthly API credits run out, "API requests stop until your next monthly credits
  arrive"; Flux shows that the same way.
- **An API key keeps one daily budget**, set by its owner. Flux prices each request from the
  model's price before sending it, so a day's spend stays within the budget, counted on the day the
  money is held: a request that waited overnight counts on the day it runs. A budget below one
  request on a model that runs on the key (its own, and the one the assistant uses on it) is
  refused when it is saved, and so is choosing a model whose one request costs more than the
  budget. When less than one request is left, the agent pauses until the next day in the key's
  time zone. Background work on the key
  shares that one budget; there is no second allowance. A provider-reported cost only reconciles the charge. A
  response whose cost cannot be known counts what the run had spent and the most that one request
  could have cost.

## CA-4 — Key custody and endpoints

Kept from PROV-4:

- API keys are sealed at rest (AEAD) and only the worker decrypts them. The API sends a key only
  while it is being added, to list its models (CA-2), before sealing it. A key never appears in API
  responses, stream frames, jobs, logs, exports or error bodies; a seeded-key absence test runs
  for every adapter.
- **Base URL guard.** Public HTTPS by default; redirects are not followed; response time and size
  are bounded; the address is resolved and checked when a request is sent. Private, loopback and
  link-local targets need the operator's explicit allowlist (`FLUX_AI_PRIVATE_TARGETS`).
  Environment variables never redirect a key.
- An API key is never passed into the CLI runtime; a key that the person types at a CLI's own
  sign-in prompt is stored by that CLI's own flow (RT-7).

## CA-5 — Plans

- A Claude or ChatGPT plan enters Flux only through the unmodified official CLI, signed in by the
  CLI's own flow in the person's isolated runtime ([where agents run](ai-modes.md)).
- Flux never collects, stores or forwards a plan credential (a pasted `claude setup-token`,
  `~/.codex/auth.json`, claude.ai or ChatGPT cookies) and never poses as another application's
  OAuth client.
- A person's local Claude Code or Codex uses its own plan on their computer, outside Flux
  ([local Claude Code and Codex](mcp-cowork.md)).

## CA-6 — Every provider is treated the same

- One set of rules for every provider and model: the same Flux tools, "What it may do", waits,
  Undo, attribution and failures ([agents](assistant.md)). No Flux feature is reserved to a vendor.
- Adapters translate only the wire format, stop reasons, usage and errors into one shared result
  set. Provider-hosted tools stay off, with one exception: the provider's own built-in **web search**
  (Anthropic's `web_search` server tool; OpenAI's `web_search` tool, for which Flux speaks OpenAI's
  Responses API), offered to a run with tools while the operator's `FLUX_WEB_READS` is on (AG-8, C-29,
  founder direction 2026-11-08, #954). A wire format without one (Chat Completions: OpenRouter,
  Gemini's compatible endpoint, OpenAI-compatible servers) has no search and its brief says so. Each
  search counts $0.01 in the key's daily budget (both vendors' price, read 2026-11-08) and every
  request that offers it reserves 5. Page reading is Flux's own `flux_read_web` on every engine.
- The UI names the chosen provider and model neutrally, for example "OpenRouter · model-id".
- **Evidence (PROV-6, kept).** One adapter contract suite runs identically in Docker against mock
  servers for each wire format (Anthropic Messages; OpenAI Responses; OpenAI-compatible Chat
  Completions), built-in search results included. A named
  provider without a dated real-key smoke test is reported unverified, not passed.

## What went away in v0.2

- The assistant's per-request money ceiling and the separate daily cap per use.
- The API key's "local allowance" for background comparisons (requests a day, 30-day and
  per-request allowances) and its four set-up checkboxes.
- Consent per use (assistant, background rule).
- The per-run reservation as a cap, and the run caps for plans (runs a day, five minutes, ten
  steps, answer size). Any input bound left is one of #843's documented technical limits.

## Revisit when

- A provider's terms forbid this use, or it cannot meet the custody and fail-closed rules. Only
  that provider is disabled; equal treatment stays.
- Anthropic changes who may use the monthly API credits, or how they are linked.
