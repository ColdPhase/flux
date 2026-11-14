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
- **Agents use "your AI"** (founder decision, Hubert, 2026-11-14, [#1424](https://github.com/ColdPhase/flux/issues/1424),
  amending [C-3](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)):
  - With **exactly one connection**, every agent of the person simply uses it. Removing the only key and adding another (or a
    plan, or the same key again) breaks nothing: an agent whose connection is gone goes on the only connection there is, at that
    connection's own model (a key's model, a plan's default), the moment it is added and again at any run, page or change that
    finds it so. Nothing is re-pointed per agent and nothing asks. No data is converted.
  - With **several connections**, each agent has its own connection and model (CA-2). Removing one pauses the agents that used it
    until their owner picks another of the rest; Flux never switches an agent between several connections by itself.
  - An agent with **no usable connection** says "Needs a connection" where its model would show (the agents list and its page), and
    its run or task says "I can't start: I need a connection. Connect AI in Settings › AI." It never shows the name of a model of
    a key that is gone.
  - A task an agent could not take goes back to its owner with the line "(its agent couldn't take it)", not "(its agent finished)".

## CA-2 — Models

- Each agent picks its model from any of its owner's connections. With one connection the picker is only
  that connection's models, with no group name and no mention of a connection (#1424, above); with several it is grouped by
  connection, for example "Claude plan: Opus · Sonnet · Haiku" and "ChatGPT plan: GPT-6.1-Sol ·
  GPT-6-Astra · GPT-6-Luna", as the signed-in CLI lists them (below). Connect AI sets the default
  for new agents: the connection made first, at its default model (implemented on the assistant,
  #854; wave 2 #857 moves it onto every agent).
- **An API key's models come from the provider, read with that key** (founder direction, Hubert,
  2026-11-10 and 2026-11-12, [#1218](https://github.com/ColdPhase/flux/issues/1218)). There is no
  model list written into Flux anywhere in the picker: Flux's price list only prices a listed
  model and never decides which models show, so a newly released model appears without a Flux
  release. Until the provider's list is read (a key added before v0.2.1 waits for its first
  reading), the key offers only its own model.
  - **Adding a key** shows first only Provider and API key (founder decision, Hubert, 2026-11-14,
    [#1424](https://github.com/ColdPhase/flux/issues/1424)); the Model appears, already chosen, once the key is read, and the
    daily budget and the name are behind "More" (they have defaults and the name is optional). When the key is typed, the Flux server
    lists that key's models (Anthropic `GET /v1/models`, OpenAI `GET /v1/models`, Gemini
    `models.list`). That one call is also the key test: a key the provider refuses says "This key
    was refused by Anthropic" and is not saved. A list that can't be read (a timeout, a 5xx) leaves
    a free field for the model id with a plain note, and the key can still be saved.
  - **The Model control** is a dropdown of the chat models the key can use, grouped by family
    (Opus, Sonnet, Haiku, Fable…) with the newest family and model first, each with its price or
    "price unknown, enter it". The provider's own display name is shown where it gives one. **A model is
    already chosen when the list is read** (founder decision, Hubert, 2026-11-14, #1424; it replaces "nothing
    is preselected"): the only model when the list holds exactly one, and for Anthropic, OpenAI and Gemini the
    first of the list as the dropdown orders it (the newest model of the newest family), the one the owner sees at the top;
    OpenRouter's and an endpoint's long lists have none chosen until the owner picks (there is no sensible first among hundreds).
    "Other model id…" opens a field for an id the list doesn't have.
  - **A key is saved only on a model.** Enter in the key field reads the models like leaving it, Connect before a model is
    known (the list is still being read, or none was) says so, and the server still refuses a command without a model
    (422 `AI_MODEL_REQUIRED`) before it sends the key anywhere; Flux's server never picks one for a client that sends none.
  - **OpenRouter and an OpenAI-compatible endpoint** keep their `/models` list read without a key
    (an endpoint's server usually answers it without one), and the free field as a fallback.
  - **Fresh and bounded.** A key's list is read again when its picker opens and the last reading is
    more than 6 hours old, and with Try again. A saved key's list is read by the worker, the only
    process that opens a stored key (CA-4); a key being added is listed by the API with the key the
    person just typed, before it is sealed. Every listing goes through the same endpoint guard as a
    run (CA-4). A list that can't be read says so, keeps the saved model and offers Try again; no
    raw error is shown. A list is read up to 1 MB (OpenRouter's, which carries a description and a price
    per model, up to 2 MB); a server that answers more has no list ("unavailable"). The API reads one
    list at a time for each person: the same listing asked again while it runs shares it, another one
    is answered 429 `MODEL_LIST_BUSY` with `Retry-After` (#1347), and the Connect AI form asks again after
    2 s, up to 5 times, still saying "Reading the models…" (a key typed again while the last one is read).
- **Price (PROV-3): the prices update themselves** (founder decision, Hubert, 2026-11-13,
  [#1465](https://github.com/ColdPhase/flux/issues/1465)). The daily budget prices every request
  before it is sent, so a model needs a price. One rule: **the price of the place the key pays**.
  - **Anthropic, OpenAI and Gemini: LiteLLM's maintained list.** The worker fetches it every day
    (and at start when the stored one is a day old), LiteLLM's
    [model price file](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)
    (MIT licence), chosen against the providers' own pricing pages and OpenRouter's list on a dated
    sample ([research](research/2026-11-13-model-price-list.md)). It carries their text models at
    their standard price with their long-prompt prices; batch, priority, regional and cache prices
    are not read.
  - **OpenRouter: OpenRouter's own prices** (coordinator answer on #1470, 2026-11-13: that is what
    the owner pays there). They come from OpenRouter's model list, read without a key: when the
    Connect AI form lists OpenRouter's models (as soon as OpenRouter is chosen), when a key is
    connected and the stored list is a day old, and every day while anyone has an OpenRouter key.
    A model OpenRouter prices variably has no price.
  - **Read safely.** Every list is an anonymous read through the same egress guard as every AI
    request (public HTTPS, no redirect; LiteLLM's at most 16 MB in 30 s, OpenRouter's 2 MB in 8 s);
    nothing is sent. Every value is checked (a number from 0 to $1,000 per 1M tokens, a model id
    Flux accepts, at most 8 long-prompt prices, and for LiteLLM's all three providers present); a
    list that fails, or a fetch that fails, changes nothing, and the last good list stays. Each list
    is kept apart.
  - **Shipped with the release.** Each release carries LiteLLM's list as fetched on its build day
    (`scripts/update_price_list.py`, run when the release candidate is prepared; the image build
    itself stays offline), and the migrator stores it when the database has none or an older one,
    so a server without internet prices with it.
  - **Long prompts at their own price.** A model priced by prompt length (Claude Haiku 5.5 over
    100,000 tokens, OpenAI's models over 272,000, Gemini's Pro models over 200,000, OpenRouter's
    overrides) keeps each price. A request is reserved at the price of the longest prompt it can be
    (a server run's 114,000 tokens; a request through the model gateway, its own bound) and charged
    by its reported prompt length, cache reads and writes included. The model picker shows the
    standard price.
  - **A price that changes is used the next day.** A connection or a model of a key that a list
    prices runs at the list's price of the day, shown as "Flux's price list of 14 Nov 2026" (or
    "OpenRouter's prices of 14 Nov 2026"); the list wins over a price stored earlier, the owner's
    included. A model a list stops carrying keeps its last price.
  - **When no list knows a price, Connect AI asks the owner**, the same way for every provider: a
    model no list prices (an OpenAI-compatible endpoint's always, and a new, unusual or variably
    priced model of the others) stays selectable once its owner enters its price for that key
    (zero for a self-hosted endpoint): "Flux doesn't know this model's price yet. Enter it to use it
    with a daily budget." Flux never saves a key on a model without a price, which could not be used:
    Connect asks for the price in the same step ("Enter this model's price to use it with a daily
    budget…", above the form), and the server refuses such a key from any client (422
    `AI_PRICE_REQUIRED`, the same words), so no key that "can't be used" can exist (journey review,
    #1424; 0 is a price). An owner price is refused for a model a list prices
    (`AI_PRICE_ALREADY_KNOWN`), and nothing is sent on a model without any price: its agent is
    unavailable with `price_unknown` (PROV-3).
  - Neither list Flux examined carries a price the provider has announced for a later date (a
    promotion's end, a scheduled rise); the daily refresh follows such a change about a day after
    the list does, and the daily budget still bounds a key's spend.
  Prompt caching (#1410): an Anthropic run's request asks the provider to cache its prefix only while
  its largest cost with every input token written to the cache (1.25×) still fits what is left of the
  run's reservation; a cache write is charged at 1.25× and a read at 0.1× of the input price
  (`PROMPT_CACHE_RATES`, dated), which is never below what Anthropic bills. Cached input on other
  providers is charged at the full price. The run's stored input tokens are the whole prompt; its
  cached tokens are not stored separately (v0.2.1): the charge is what reflects the cache. A key is
  its owner's, so Anthropic's cache (kept per Anthropic workspace) is never shared through Flux
  between people who did not add the same key.
- **A model the provider retires** (in an earlier list of the key, missing from a later one) shows
  as "no longer offered by Anthropic", wherever its agents show it. The agents on it pause until
  their owner picks another model (like C-3); Flux never switches the model by itself.
- **One name per model.** A listed model carries the name its provider gives it ("Claude Opus 5.5") on
  the Connect form and on the agent page alike; Flux's short names serve only a model the list does
  not name (the key's own, a retired one).
- **A plan's models come from the signed-in CLI, not from a list in Flux** (founder direction,
  Hubert, 2026-11-12, [#1332](https://github.com/ColdPhase/flux/issues/1332); F-022 amended).
  After Claude Code or Codex signs in, Flux reads the models that CLI offers that account and fills
  the plan's choices from them; nothing about a plan's models is written into Flux, so a model the
  vendor adds or removes shows up without a Flux release.
  - **Where the list comes from.** Claude Code: the `models` of its headless initialization answer
    (`claude -p --input-format stream-json`, one `initialize` control request; observed with
    Claude Code 2.1.285, 2026-11-12; Agent SDK `supportedModels()`), which needs no model call: each
    entry's alias (`opus`, `sonnet`, `haiku`), display name and description. Its `default` entry only
    names which listed model is the account's default. Codex: `codex app-server` `model/list`,
    paged (observed with Codex 0.160.1, 2026-11-12): id, display name, description, whether it is
    the default, hidden, and its input types. Both are read by the supervisor in the person's own
    runtime, in memory, and reach Flux as ids, names and one-line notes; never a credential.
  - **What shows.** Exactly that list, in the CLI's own order, minus three kinds: a hidden model
    (Codex marks it; it is not in the CLI's own picker), **Fable**, which can bill usage credits
    that Flux cannot see (it is dropped where the list is read, and again where it is shown), and a
    Codex model that Flux's reviewed copy of the pinned catalog does not hold (no run could use it,
    below; coordinator review of #1340, 2026-11-13: don't offer what will fail). A model
    whose id could be read as a flag or a path is not shown either. The CLI's own default is the
    plan's default for a new agent, else its first model; an agent without a model of its own runs on
    that default once the list is known (so a CLI default Flux does not offer, such as Fable, never runs). A model the CLI lists carries the name the
    CLI gives it, on the agent's page and everywhere else, as an API key's models do.
  - **When it is read.** When the person signs in (and not before, so a plan that is not signed in
    shows no models), and again about every six hours, in the worker's existing runtime
    reconciliation tick: at most one plan per tick, a failed read tried again after five minutes,
    and a read never waits behind a run nor holds one up (the supervisor answers busy, and a run that
    finds only a read in the person's lane ends it and goes next; the last list stays). Signing out or a different account clears it.
  - **When the CLI can't be reached** the last known list stays and keeps working; the agent page
    does not call it stale. A plan whose list was never read shows no models yet and its agents keep
    running on the model they have: nothing is paused for a list Flux could not read.
  - **A model the plan stopped offering** (in an earlier list, missing from the latest) reads
    "no longer offered by Claude" or "…by ChatGPT", wherever its agents show it, exactly as for an
    API key; the agents on it pause until their owner picks another model, and Flux never switches
    the model by itself.
  - **Codex runs only models its account lists.** Flux's reviewed copy of the pinned catalog
    ([RT-5](ai-modes.md#rt-5--tools))
    is cut down for each run to the models the account's own `model/list` returns just before the
    run, so it can never offer a model the account lacks. A model the account lists that the pinned
    catalog does not hold is not offered until the pin moves, and an agent already on it reads "no
    longer offered by ChatGPT" and pauses, as above; a run that still names one ends with the line below.
- A model the plan refuses gives one line: "Your Claude plan didn't accept Opus". Nothing switches
  to another model.
- Only a model that calls tools can be an agent ([RT-1](ai-modes.md#rt-1--engines-on-the-server), #1441): adding a key, or
  choosing another model of its list, sends one small request with a `ping` tool the model must call; otherwise the form says
  "This model can't use tools. Choose another." (`AI_TOOLS_REQUIRED`), and only that: the model is refused, not the key, so the key
  stays in its field for another model of the list (coordinator decision, 2026-11-13). **The check, in detail.** One request in the provider's own wire
  format (Anthropic Messages, OpenAI Responses, Chat Completions for OpenRouter, Gemini and a compatible endpoint), on the model chosen,
  with the key's own address and the same endpoint guard as every request (CA-4): one tool, `ping`, with no arguments; the system line
  "You are being checked by Flux. Call the ping tool now. Do not write anything else."; the input "ping"; at most 256 output tokens, low
  effort. The model is accepted when the answer holds a call of `ping`. An answer in words only, a refusal by the provider or the
  model, a failure or a timeout (30 s) is the same refusal; nothing is retried. **When it is sent:** when a key is added, after its
  listing (the key's test), the price and the budget checks, and before it is saved, with the key being added, so a model that
  cannot call tools saves nothing; and when an agent is put on a model of a key, with the key opened for that one request, unless
  that key and model already passed (the pass is kept, so a model is never checked twice; choosing the model an agent already has
  checks nothing). A model without a known price is checked the first time an agent is put on it, once its price is known: the check
  needs a price to be charged. The same check, whatever the provider: no table of models and no owner's switch decides it.

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
- **The check that a model calls tools (CA-2) is a request like any other.** Its cost is the provider's reported usage at the model's
  price (a few hundred tokens: well under a cent on any model), the most one such request could cost when the usage is unknown, and
  nothing when the provider documents no charge for the failure. It is kept with the key (`api_key_checks`: the model, the cost and
  whether it called `ping`) and counted on the day it was made, with the runs, in "spent today" and against the budget. A check made
  when the key is added is saved with the key in one transaction. The one request sent for a key that is then refused (its model did
  not call `ping`) has no key to be counted on, so Flux counts it nowhere; only the provider's own bill has it.
- **A run on an API key in the runtime is metered request by request** at the model gateway
  ([#1441](https://github.com/ColdPhase/flux/issues/1441), [RT-4](ai-modes.md#the-model-gateway-1441)), with the same prices and
  cache rules: each request holds the most it can cost against what is left of the key's day before it is sent, and is charged
  the provider's reported usage after it. One whose usage is missing, malformed or beyond its bounds keeps all it held; a complete
  error answer of the provider costs nothing. A request the day cannot hold is refused, and the run ends with "budget".

## CA-4 — Key custody and endpoints

Kept from PROV-4:

- API keys are sealed at rest (AEAD). The worker decrypts a key for each model request of its model gateway; the API decrypts
  one only for `flux_web_search`, one search of a run in pi on the run's own key (#1441, RT-5), and for the one `ping` check when an
  agent is put on a model of the key that has not passed it (CA-2, RT-1 rule 2). The API sends a key while it is being added, to list
  its models and check that the chosen model calls tools (CA-2), before saving it. A key never appears in API
  responses, stream frames, jobs, logs, exports or error bodies; a seeded-key absence test runs
  for every adapter.
- **Base URL guard.** Public HTTPS by default; redirects are not followed; response time and size
  are bounded; the address is resolved and checked when a request is sent. Private, loopback and
  link-local targets need the operator's explicit allowlist (`FLUX_AI_PRIVATE_TARGETS`).
  Environment variables never redirect a key.
- An API key is never passed into the CLI runtime; a key that the person types at a CLI's own
  sign-in prompt is stored by that CLI's own flow (RT-7).
- **The model gateway holds the key for runs in the runtime** ([#1441](https://github.com/ColdPhase/flux/issues/1441),
  [RT-4](ai-modes.md#the-model-gateway-1441)). The run has only a short-lived gateway token, bound to that run. The gateway is the
  worker: it opens the key for one request and puts it only into the provider's own header of the request it sends (`x-api-key`,
  `Authorization` or `x-goog-api-key`), to the connection's own address. The key never reaches the runtime's environment, files,
  command lines or logs, the egress, the run row, a response or a log line; a provider's error answer is passed on with the key
  and anything shaped like a key taken out.

## CA-5 — Plans

- A Claude or ChatGPT plan enters Flux only through the unmodified official CLI, signed in by the
  CLI's own flow in the person's isolated runtime ([where agents run](ai-modes.md)).
- Flux never collects, stores or forwards a plan credential (a pasted `claude setup-token`,
  `~/.codex/auth.json`, claude.ai or ChatGPT cookies) and never poses as another application's
  OAuth client.
- A person's local Claude Code or Codex uses its own plan on their computer, outside Flux
  ([local Claude Code and Codex](mcp-cowork.md)).

## CA-6 — Every provider is treated the same

- One set of rules for every provider and model: the same Flux tools, Ask me first, waits,
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
