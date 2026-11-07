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
- An API-key connection offers its provider's models that have a price in Flux's dated table, or
  a price the owner entered (zero for a self-hosted endpoint), because the daily budget needs one.
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
  the reset (a request waits for it in the queue).
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
  time zone. Background work on the key (comparisons)
  shares that one budget; there is no second allowance. A provider-reported cost only reconciles the charge. A
  response whose cost cannot be known counts what the run had spent and the most that one request
  could have cost.

## CA-4 — Key custody and endpoints

Kept from PROV-4:

- API keys are sealed at rest (AEAD) and only the worker decrypts them. A key never appears in API
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
  set. Provider-hosted tools stay off; how web reading is provided on each engine is settled in
  #856 under AG-8.
- The UI names the chosen provider and model neutrally, for example "OpenRouter · model-id".
- **Evidence (PROV-6, kept).** One adapter contract suite runs identically in Docker against mock
  servers for each wire format (Anthropic Messages; OpenAI-compatible Chat Completions). A named
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
