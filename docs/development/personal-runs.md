# Personal assistant runs (#68)

This is the implementation contract of #68 (slices 1 and 2), under the accepted
decision [O-008](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/personal-runs-compute.md) and the
[interaction design](../design/personal-ai/README.md). A person enables their own
assistant, invokes it in a project conversation, and gets an answer that the
conversation's audience reads as "Jo's assistant · asked by Jo". A consequential
change waits for its owner's Approve (the change line of F-036). The assistant proposals of this
history, which could only record a result, went with the Result object (#1054).

**Since v0.2 (#842, F-036 AG-4) the answer to `/ai` is private, and a run has a place.** The text
above is the history of #68; read [Places and private answers](#places-and-private-answers-842)
for what holds now.

**Production still fails closed.** Slice 2 adds the UI, owner-only progress events
and the real Anthropic adapter, but there is still no key storage. The owner's key
connection belongs to [#124](https://github.com/ColdPhase/flux/pull/124). Until it
lands, production composes no connection lookup and the provider switch off. So
enabling fails with `PERSONAL_RUN_CONNECTION_REQUIRED`, every invocation fails with
`503 PERSONAL_RUN_UNAVAILABLE`, the worker ends any queued run as `unavailable` at
zero cost, and the UI says exactly that. Runs past dispatch are tested with the
fakes in `app/tests/app/support/personal-runs.ts` (API suite) and, in the browser
suite, with the real adapter against a mock provider server (see
[Test-only switch](#test-only-switch)). No test is a provider, billing or
compatibility pass.

**Any provider (F-020, #179).** A run goes to the owner's connection, whatever its provider kind
and model: the same use cases, rechecks, reservation and commit, with the wire format chosen by
the adapter registry of `@flux/agent-runtime`. See [AI providers](ai-providers.md). The production
connection lookup is still `noPersonalConnections`.

## Layout

| Path | Role |
| --- | --- |
| `app/packages/contracts/src/personal-runs.ts` | Paths, wire types, the consent versions (`o-008-2026-10-02` for new consents; `o-008-2026-09-28` stays valid for Anthropic) and the O-008 limits (`PERSONAL_RUN_LIMITS`), the same for every provider. |
| `app/packages/core/src/personal-runs/` | Ports, input and output rules, use cases (`service.ts`), and the worker processor (`processor.ts`). |
| `app/packages/core/src/access/personal-run-access.ts` | The access policy as the `PersonalRunAccess` port. |
| `app/packages/core/src/access/policy.ts` | New agent action `agent.invoke`: only the person who owns the unrevoked agent. A workspace role never grants it. |
| `app/packages/db/migrations/0001_v0_1_baseline.sql`, `app/packages/db/src/repositories/personal-runs.ts` | Tables and rows. |
| `app/apps/server/src/personal-runs/` | Routes and the per-transaction composition. The server only queues runs. |
| `app/apps/worker/src/personal-runs/` | The `personal-run.dispatch.v1` handler and its composition (`composition.ts`). The queue never retries a job (`PERSONAL_RUN_QUEUE`). |
| `app/packages/core/src/personal-runs/progress.ts` | Owner-only progress events (`assistant_run.changed.v1`). |
| `app/packages/core/src/access/policy.ts` (`evaluateAssistantRun`) | The `assistant_run` object: its only reader is the run's owner. |
| `app/packages/agent-runtime/src/anthropic.ts`, `responses.ts`, `openai-compatible.ts`, `registry.ts` | The adapters behind `PersonalCompute`, one per wire format (`@anthropic-ai/sdk` 0.129.0, pinned; fetch clients for OpenAI's Responses API and for Chat Completions), and `providerPersonalCompute`, which picks one by the connection's provider. |
| `app/apps/web/src/assistant/` | The UI (AC-8): ask mode, working line, answers, settings. |
| `app/packages/core/src/personal-runs/test-fixture.ts`, `app/tests/ui/anthropic_mock.py` | TEST ONLY: fixture key connections and the mock provider of the browser suite. |

## Ports

- `PersonalConnectionLookup.resolve(ownerUserId)` returns the owner's own
  connection: its id, status, payer, an opaque `keyRef`, and its provider kind,
  model, base URL and price (F-020). There is no lookup by connection id, and core
  never sees key material. Production composes `noPersonalConnections` until the
  real lookup over #124's custody is wired (#68).
- `PersonalCompute` has `enabled` (the instance operator's switch, O-008 §6), an
  optional `countInputTokens` (a provider count, which may only raise the Flux
  estimate) and `dispatch(request, signal)`. A dispatch is one bounded request to
  the connection's provider and model, at most 1500 output tokens, low effort where
  the wire format has it, and no tools unless the run has the Flux tools of the [tool loop](#tool-loop-f-027-ast-8-406-first-part). The result is either `completed` with text,
  `stopReason` and usage (with the provider-reported cost when there is one), or
  `failed` with `billed: 'none' | 'unknown'`. Production composes
  `unavailablePersonalCompute`; the adapters are described below.
- `PersonalRunUnitOfWork` bundles, in one transaction, the access port, the rows,
  the queue (the job is sent in the same transaction) and the event log.

**Price and model (F-020).** The model and its price belong to the owner's connection
(see [AI providers](ai-providers.md#prices-reservations-and-the-input-bound)); there is no
pinned model. Claude Sonnet 5 is in Flux's price table at $2/M input and $10/M output, read
from the Anthropic [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
on 2026-10-02 (2026-09-30: the page called it the standard price, and the scheduled rise to
$3/$15 "will not occur"). Check again when production dispatch is switched on.

## Provider adapters

`providerPersonalCompute({ enabled, resolveKey, policy, ... })` in `@flux/agent-runtime` picks
the adapter of the connection's wire format: `anthropicPersonalCompute` for Anthropic Messages,
`openAiResponsesPersonalCompute` for OpenAI (the Responses API, #954), and `openAiCompatiblePersonalCompute`
for OpenRouter, Gemini's compatible endpoint and OpenAI-compatible servers. All use the guarded transport, refuse a request outside the O-008
limits before a key is resolved, send no tools unless the run offers its Flux tools (see
[Tool loop](#tool-loop-f-027-ast-8-406-first-part)) and never retry; the Chat Completions details are
in [AI providers](ai-providers.md#provider-kinds-and-wire-formats).

`anthropicPersonalCompute({ enabled, resolveKey, baseURL?, timeoutMs?, policy? })` implements
`PersonalCompute` with the official SDK:

- one client per request, with the owner's key from `resolveKey(keyRef)`, an explicit
  `baseURL` (so `ANTHROPIC_BASE_URL` in the environment never redirects a key) and
  `maxRetries: 0`;
- SDK 1.x (`@anthropic-ai/sdk` 1.6, #1240) sends API version `2026-10-21` (checked 2026-11-12 in the vendor's
  [API versions](https://platform.claude.com/docs/en/api/versioning)). That version removes `temperature`,
  `top_p` and `top_k` (a 400 on every model) and rejects a `document` block in an assistant message and a cited
  `text` block in a user message; the adapter sends none of them (the contract suite asserts the header and the absent
  parameters). SDK 1.x also sends an API key as `Authorization: Bearer <key>` instead of `X-Api-Key` (the same page, "API
  keys are sent as `Authorization: Bearer`"): the key is still the owner's, passed as the client's explicit `apiKey`, so the
  environment and the SDK's profile lookup are never consulted;
- `messages.create({ model, max_tokens, system, messages: [user input], output_config: { effort: 'low' } })`
  with no tools, and the `AbortSignal` of the owner's Stop;
- `messages.countTokens` with the same model, system and input for the preflight;
- a request outside the O-008 limits (a malformed model id, `max_tokens` above 1500, another
  effort) is refused before a key is resolved;
- usage: `input_tokens` plus cache tokens counted conservatively (reads as full input,
  5-minute writes ×1.25), and `output_tokens`. Core charges them at the connection's price.
- failures: only a request that was never sent (no usable key; the O-008 limits refuse before a
  key is resolved, and an endpoint the guard refuses) is `billed: 'none'`. Every failure after the
  request reached the provider — 429 `rate_limited`, 529 and 503 `overloaded`, other 4xx and 5xx
  `provider_error`, timeouts, lost
  connections and aborts — is `billed: 'unknown'` and keeps the reservation counted: the
  provider's error and pricing references (checked 2026-09-30) define these errors but promise
  no billing outcome. Token counting is free per the provider's documentation. Retry is a new
  capped run. A failed preflight count ends the run as `provider_failed` at
  zero cost (nothing was dispatched).

## Tool loop (F-027 AST-8, #406 first part)

Contract: [F-027 AST-8](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/assistant.md#ast-8--engines-the-server-tool-loop-and-the-runtime).
This part is the provider side and the loop's limits; the tools themselves are the worker's MCP
client of `/mcp` with the run token (below, #484). With the provider switched on the worker composes
that `PersonalToolHost` and the API composes `toolTurns` (10); switched off, every run stays one request.

- **Port.** `PersonalComputeRequest` gains optional `tools` (neutral `PersonalTool`: name,
  description, JSON Schema) and `turns` (the earlier turns, each with the calls the model made,
  the results that came back and `replay`, the provider's own assistant message). A completed
  result gains the stop reason `tool_use` with `toolCalls`, only when tools were offered and the
  answer was neither cut off nor refused. Without `tools` the request has no `tools` key on the
  wire. One `dispatch` is still exactly one HTTP request.
- **Wire formats** (`@flux/agent-runtime` `tool-wire.ts`, shapes read 2026-10-11 from the vendors'
  documentation): Anthropic Messages writes `tools[].input_schema`, reads `tool_use` blocks and
  returns `tool_result` blocks first in one user message with `is_error`; Chat Completions
  (OpenAI, OpenRouter, Gemini's compatible endpoint, self-hosted servers) writes
  `tools[].function.parameters`, reads `tool_calls` (a JSON-string `arguments`; not an object
  means `invalid`, never run) and returns one `role: "tool"` message per call, with failures
  starting "Error: ". `tool_choice` is never sent. The provider's own assistant message is sent
  back unchanged, so reasoning blocks and thought signatures survive. The Anthropic token count
  carries the tools and the turns. `checkRequestLimits` refuses a bad tool name, schema,
  duplicate, more than 64 tools, a turn whose calls and results do not match one to one, more
  turns than the cap, and tools offered to a model Flux knows cannot call them, all before a key
  is resolved.
- **No-tools model** (AST-8.3). `connectionCallsTools`: false when the owner marked the model
  (`PersonalConnection.toolCalling === false`) or Flux's dated table `AI_MODELS_WITHOUT_TOOL_CALLING`
  lists it. The table is empty since #954: OpenAI's function-calling guide (read 2026-10-11) says GPT-6
  Astra and GPT-6.1 Sol need the Responses API for tool calling, which Flux now speaks to OpenAI.
  Persisting the owner's mark and the account row's "This model can answer but can't make changes"
  are not part of this change.
- **Reservation** (#854). `budgetedReservationMicros`: when the worker claims the run, turns × the
  largest request of a tool run (64,000 × input price + 4,000 × output price;
  `PERSONAL_RUN_LIMITS.maxToolInputTokens`, #484, #843), never above what is left of the key's one daily
  budget and never below one request. Asking only checks what the key has already been charged today;
  a run that finds not even one request's room left waits, queued, for the key's next day
  (`end_reason = 'budget'`, `resume_at`). `PERSONAL_RUN_LIMITS.maxTurns` is 200, a safety bound.
- **The loop** (`core/personal-runs/tool-loop.ts`, driven by the processor when its `tools` host
  returns a session with tools). It sends the first request, and while the model asks for tools
  checks, before running anything it asked for, the turn bound, the money reservation (the largest
  possible next request must still fit what the reservation has left) and the clock (one hour,
  `RUNTIME_RUN_LIMITS.wallClockSeconds`);
  runs each call once through the session (a call the provider could not state as JSON, or outside the
  offered tools, is answered with an error and never sent); rechecks the run's standing (stop,
  enablement, connection, access, the key's daily budget; the same recheck as before a dispatch) before the calls
  and before the next request; and bounds the next request's input like the first. A run that
  reaches a bound ends **`cap_reached`** with `stopped_at_stage = before_dispatch`, cost `observed`,
  nothing posted and its own `end_reason` (`budget`, `max_turns`, `wall_clock` or `input_too_large`);
  the calls already made stay made.
- **Per-request reconciliation** (PROV-3). Each response is charged at the connection price or as the
  provider reported it, within what is left of the reservation. A request outside its token limits,
  or one that would take the run above its reservation, is a lost response: cost `unknown`, charge 0,
  the earlier requests and the most this one could have cost stay counted and the rest of the
  reservation goes back (#854), nothing posted (`provider_failed`), the earlier calls kept. A
  request that failed after it may have been billed does the same; one that was never sent
  (`billed: none`) keeps the earlier requests' charge. A run's input and output tokens are the sums
  over its requests.
- **Tests.** `provider-tool-calling.test.ts` (AST-8.1: every wire format against documented-shape
  fixtures in `support/provider-tool-fixtures.ts`, a local mock server), `personal-runs-tool-loop-core.test.ts`
  (reservation, reconciliation and the loop with fakes) and `personal-runs-tools.test.ts` (AST-8.2 and AST-8.3
  through the real worker and database, with a fake provider and a fake tool session).

## Web search (#954)

Contract: [AG-8](../product/assistant.md#ag-8--what-server-agents-may-do), C-29 and C-30 (founder direction 2026-11-08; no limit on searches or
pages, founder direction 2026-11-09, #1113).

- **What is offered.** A run with tools (`session` non-null) on a provider with its own search
  (`AI_PROVIDERS[kind].searchesWeb`: Anthropic, OpenAI), while the worker's `FLUX_WEB_READS` is on (the
  default; `webSearchSwitch`, the same variable the API reads for `flux_read_web`), gets
  `PersonalComputeRequest.webSearch`. The Anthropic adapter adds `{ type: 'web_search_20250305', name:
  'web_search' }` (the basic version every model and platform has; no `max_uses`: a run searches as much as its question needs, #1113);
  the Responses adapter adds `{ type: 'web_search', external_web_access: false }` with `include: ['web_search_call.action.sources']` and no
  `max_tool_calls`.
  Chat Completions has none, and `checkRequestLimits` refuses `webSearch` there or without tools. A model in
  `AI_MODELS_WITHOUT_WEB_SEARCH` (o3-mini, checked 2026-11-09) is not offered it. Every run with tools is told in
  its brief whether it can search (`buildBrief` with `webSearch`: `WEB_SEARCH_LINE`, and the search results as readable
  addresses in the web rule; `NO_WEB_SEARCH_LINE` otherwise). The runtime engine's brief has `RUNTIME_WEB_SEARCH_LINE`
  on Claude Code or Codex with the switch on (see "The CLI's own search" below).
- **A refused search.** When the provider refuses the tool, recognised only from the error's own `type` and `message`
  (`anthropicSearchRefusal`: a 400 `invalid_request_error` saying web search is not enabled, an organization whose admin
  turned it off; `openAiSearchRefusal`: a 400 `invalid_request_error` saying the tool `web_search` is not supported, a model
  without it), the adapter returns `searchRefused` with `billed: 'none'`; the loop sends the same request once more
  without the search (`withoutSearch`: the brief built again with `webSearch: false`) in the same turn. Anthropic's token
  count carries the search tool too: a refusal there throws `WebSearchRefusedError`, and the preflight `fit` and the
  loop's count count again without the search. Either way the worker does not offer the search to that key's model for
  6 hours (`searchRefusedUntil`, in memory), and a Connect AI budget is checked without search room for a model in
  `AI_MODELS_WITHOUT_WEB_SEARCH`.
- **What comes back.** The adapters read the provider's structured answer, never the model's words:
  Anthropic's `server_tool_use` queries, `web_search_tool_result` addresses and `web_search_result_location`
  citations; OpenAI's `search` actions' queries and `action.sources` and the message's `url_citation`
  annotations (`WebSearchFound`). An `open_page` or `find_in_page` action's address is the model's choice and is
  never taken (the review of #1073). Usage gains `webSearches` (Anthropic's
  `usage.server_tool_use.web_search_requests`, OpenAI's number of `web_search_call` items). The replay of a
  turn carries Anthropic's own blocks unchanged (it needs the results' `encrypted_content`); on OpenAI it is the
  model's words and its function calls without item ids (`responsesReplay`): no reasoning is carried between
  turns and no encrypted reasoning is asked for.
  A `pause_turn` (#1116) is continued: without `max_uses` a request that searches ten times in one turn reaches the server's own loop limit and
  pauses, and the adapter returns it as `stopReason: 'pause_turn'` with the paused blocks as `replay`. The tool loop sends them back as the
  last message (a turn with no call and no result, so no user message follows) and the model goes on. It is one more request like any other,
  reconciled by itself and held to the turn cap, the money, the clock and the input bound; a pause is never the run's answer. Unverified
  without a real key: the Docker mock only has the documented shape.
- **Before the calls.** The loop awaits `onWebSearch` for every response that searched or cites, before
  any call of that response runs; the processor writes `personal_run_web_searches` (`boundedWebSearch`:
  normalized web addresses only, each once, at most 1,000 results and 1,000 cited, 100 queries of 300
  characters for one response, written in as many rows of `personal_run_web_searches` as they need, since a row holds 10 queries and 100
  addresses; a run has as many responses as it makes requests). A cited address is listed only when the run's search returned it.
- **Any address opens (#1065, founder direction 2026-11-09, C-30; #1136).** `flux_read_web` opens any public address on every engine, and
  refuses one that carries private Flux text the run read (`privateFragmentIn`, `WEB_READ_PRIVATE_TEXT`, with the fragment in its words, the
  same words on every engine). **What is kept** (`keptPrivateText`; `keepPrivateText` does a long text in slices of about 32 KiB with a turn of
  the event loop between them; `personal_run_private_texts`): `body`, the words compared (percent-decoded up to four times, hidden text in
  tag characters or variation selectors revealed, lower case, NFKD without accents, invisible format and control characters dropped, `+` as
  a space, runs of space as one) with each web address written in it cut out (an address with `http(s)://`, or a site name with a lower-case
  top level such as `wiki.example/lamp`, never inside an email address; only the address, never the words around it, since a tool's JSON has
  no spaces), a cut being a line break no compared address holds; and each real date, with its time, read as one mark (`datesMarked`: a
  month 1–12, a day 1–31, a year 1900–2099; a time alone is not a date). `addresses`, those links compared the same way, without scheme
  and `www.`, and the link inside a redirect wrapper's query (`?q=`, `?url=`, two deep). The worker writes the brief's private part when the
  run is dispatched (`briefPrivateText`: names, ids, the agent's instructions and memory, the task, every source given, the earlier exchanges
  and the request, one per line; never Flux's own rules, headings or clock), and the API writes each Flux tool result in `boundRunResult`
  (every part, an error too, a result that is only links too; never `flux_read_web`'s page). `addPrivateText` inserts only while the run is
  `reading` or `dispatching`, with its row share-locked, and migration 0050's trigger deletes the run's rows when its status leaves those
  (any end, the stale sweep's included), so nothing outlives the run.
  **The index** (`PrivateTextIndex`, `apps/server/src/agent-connection/run-private-text.ts`): one per run in each API process, built as the
  run keeps text and reused by every check. A check reads the ids of the run's rows and fetches only those it does not hold (the worker
  writes the brief and any API process a result; the links come joined by `array_to_string` and are split natively), adds them with a turn
  of the event loop every few thousand links, and keeps the words and the links each once (the links in 256 small maps by hash, never one
  big map, and in one joined block per text, with where each starts and its site). An index goes when its run's rows are gone (the run
  ended), when its token is refused, after 10 minutes unused (a minute's timer checks), or least recently used first past 16 runs or 48 Mi
  characters. **One gate** per process runs one check at a time, so parallel reads of a run, or of many, wait their turn (the runs take turns:
  one check of each waiting run in turn, #1144).
  **The check**, per address: an address longer than `ADDRESS_MAX` (2,048) as it is sent, a redirect hop's included, is not checked or asked
  (`AddressTooLong`, `WEB_READ_TOO_LONG`). Otherwise it is read as the server sends it (`new URL(…).href`, the parser drops tabs and line
  breaks) and with its host in Unicode, its host and path and its query each percent-decoded until they stop changing, revealed, folded and
  date-marked, and the hex, base64 (either alphabet) and base32 runs of the decoded address decoded at every alignment; the fragment (`#…`)
  is never sent and is not read. Every 12-character window with at least 6 letters or digits and a space, a digit or an `@` is a candidate,
  marked as lying in the host and path or elsewhere. Dropped: the windows of the written link the address equals or begins with
  (`writtenPrefix`: one pass of prefix hashes, looked up at each mark of a path or a query, never past the longest link kept), and on a
  redirect hop the windows of the written link the read's first address was or began with (`AddressChain`; nothing that opened only by the
  same-site rule carries over). An address equal to a written link opens at once. The rest are hashed (Rabin-Karp, a random multiplier per
  process, a bitmap in front of a `Map`) and the kept text is read once: the link blocks (a window found in a link of the address's own site
  or its one named pair (`github.com` ↔ `api.github.com`, `SITE_PAIRS`; no general subdomain rule: a `www.google.com` link may never lend its text to `script.google.com`), in the host and path, is that link's own text and allowed; one found anywhere else in the query or a
  decoded run is refused at once; a host-and-path window found only in another site's link is refused), then the words (any window found is
  refused unless it lies in the host and path and a same-site link holds it). The scan yields every 256 Ki characters and after every block.
  Cost on the review's repro (8 MiB of words and 30,000 links, a 2 KB address of `[a-f2-7]` runs): about 40 ms; #1134's check took 21.8 s.
  Each redirect hop is checked in `beforeRequest` before it is asked, under the same gate and with the read's index; the hop already sent is
  listed as redirected. **A run's change** (`tool-registry.ts`'s effect wrapper, `refusedPrivateAddress`, #1138) is checked the same way: each
  web address its arguments hold (`writtenAddresses`) against the run's index; one that carries private text refuses the change
  (`CHANGE_PRIVATE_ADDRESS`) before anything is prepared. **A run's answer** (`answerCleaner`, #1143, #1149) is cleaned by the worker before the
  commit's transaction (#1156: that transaction holds the space's task lock), while the run's kept text still exists, in its final form:
  `preparedAnswer` runs after `parseOutput`, takes the `<schedule>` block out and cleans its instruction and its name (`titleFromText` when it gives none), cleans the text (`cleanAnswer` also
  decodes the `<ask>` block's JSON, cleans its fields and writes it back) and works out the listed form of each cited result; inside the
  transaction `answerWithSchedule` only prepares the cleaned schedule and `answerWithWebSources` only lists. Each address that carries private
  text, or is too long to be read, becomes `[address left out]` (`withoutPrivateAddresses`, with `sameSitePaths: false`: what a run writes
  never gets rule (2); the change check of #1138 uses the same option and refuses an over-long address too). `privateFragmentsIn` gives
  both answers from one pass. `parseOutput`, `takeScheduleBlocks`, `takeAsk` and `withoutCitationMarks` take pieces out with no gap only
  when that joins no new address (`joinsAddress`); otherwise a space stands in their place, and `takeAsk` reads a block only before Flux's
  list (`webSourcesAt`). Each address `flux_read_web` asks is marked when it is asked (`personal_run_web_reads.writable`, migration 0051:
  `checkRunAddress`'s second answer), and `webSourcesLine` lists one that is not writable defanged, so a list needs no kept text; a search
  result a run may not write is listed defanged (`AnswerCleaner.cited`; `endedSourcesLine` defangs every one, as a run without an answer has
  no kept text left), and search queries are listed with any address in them defanged (`defangedAddresses`): a query is never checked. A
  site on object storage's path-style hosts (`pathStyleStorage`: the same list as C-30) is the host and the bucket (#1144, #1149), and on
  Backblaze B2's download hosts the host and `/file/<bucket>` (#1156); a window that ends at the `/` after the host is the host's. The brief says the rule (`OPEN_ANY_ADDRESS_LINE`, and with a search "use your web
  search, not the address of a search page"). How many addresses a run reads is not limited, and there is no limit per minute (#1116): only
  the fetcher's guard of 6 pages read at once across the server (`READS_AT_ONCE`; `WEB_READ_BUSY`). What the agent rewrote (other words,
  hyphens for spaces, pieces under 12 characters) is not caught, nor a search query, which runs at the provider or the CLI's vendor before
  Flux sees it: the founder's accepted risk. Link cards fetch nothing for a line an agent that runs on the server wrote
  (`messageReferenceRows.writtenOnServer`, the same rule as who its line notifies), so that fetch cannot carry what a run read past this check.
- **Input.** The estimate does not count Anthropic's opaque `encrypted_content` and `encrypted_index` byte for
  byte (`requestParts`); Anthropic's token count, which counts the results as the provider does, may only raise
  it. A request that offers search has room for the results (`WEB_SEARCH_INPUT_TOKENS`, 50,000 tokens in all, an assumption) in its input
  bound and its reservation (`personalRunMaxInputTokens(true, true)`); the searches are not counted. What a request that searched reports as
  input is held to the money the run has left and not to that bound (`reconcileRequest`), because the provider adds the results of every round
  of its own search loop on its own.
- **Long research** (#1113). The tool loop keeps the pages the model read and has not noted (`page-notes.ts`: the results of `flux_read_web`
  that are a page). When a later step's words are at least `PAGE_NOTE_MIN_CHARS` (40) characters long they are the note of every page read
  before that step: the text of those results is replaced in the turns of every later request by the page's address and title with the line
  that it was left out and can be read again (`notePages`, `notedPageResult`). The pages that step read are not noted yet: the model has not
  seen them. Turns are replaced, never changed, so a request already sent keeps what it carried. The brief of an API-key run asks for the note
  (`PAGE_NOTE_LINE`); the Claude Code and Codex engines are not touched. A page that is never noted stays in later requests, and a run that
  outgrows the request's input bound ends at it ("Limit reached"). The provider's own search results are replayed unchanged.
- **Sources.** `webSourcesLine` lists "Searched the web for:" (queries) and "Found on the web:" (cited
  addresses) before "Read on the web:" and "Requested, not read:", at most 20 of each search list (the pages read are all listed), under the
  answer or in the end line (the run view's `webSources`, and the task's discussion).
- **Money.** Each search is charged `WEB_SEARCH_MICROS` on top of its tokens, as the provider reports it, and none is reserved
  (#1113): `nextRequestFits` and `budgetedReservationMicros` hold a request's tokens and the room for results, so a small budget stays usable.
  A request whose searches take the run above its reservation is a lost response (the reservation is counted as spent, the answer withheld), so
  what Flux records never passes the key's day; one request's own bill can pass it by that request. A response that reports searches when none
  were offered is outside its bounds. A key's budget is refused when saved if it cannot hold one request with the room for results on a
  provider that has a search.
- **The CLI's own search (#1065, RT-5).** With `FLUX_WEB_READS` on, `managerPersonalRuntime(…, { webSearch })` marks the runtime, and a
  run sends `webSearch: true` in the supervisor's run request. Claude Code's template then keeps exactly one built-in, `--tools WebSearch`,
  with `WebSearch` in `--allowedTools` (never `WebFetch`), and the `system/init` read-back (the slot's and `localToolInInit`) accepts it;
  Codex's has `web_search="cached"` instead of `"disabled"`, the preflight requires it, and the JSONL check accepts its `web_search` items.
  The slot reduces each search to two closed frames: `search` (`n`, the query when the CLI shows it then: Claude Code's tool use) and
  `found` (`n`, the result addresses, and for Codex the queries): Claude Code's from the result entries of the `user` event's structured
  `tool_use_result` (`searchResultAddresses`; never an address from the tool's text, which interleaves the CLI's own summary, and none for an
  error); Codex's from a completed item with a search action (`codexSearchFound`: its queries, and the `text_result` entries whose `ref_id`
  is `turn<N>search<M>` in the item's `results`, which the standalone `web.run` search of the pinned Codex fills; an opened page's entry has
  the address as its `ref_id` and is left out; see RT-5 for what was observed with the real binary). The worker
  writes them in stream order through one promise chain (`record`): `startWebSearch` writes a `personal_run_web_searches` row,
  `settleWebSearch` fills its results and queries. Neither CLI hands Flux citations: at the commit, the addresses the answer names
  (`addressesIn`) are written as the run's cited row, and `searches` lists those its search returned under "Found on the web:". Claude
  Code's tool result asks the model to cite its sources as Markdown links, which the message renderer does not draw (only a bare address becomes a link) and would show raw, so the brief's
  `RUNTIME_WEB_SEARCH_LINE` says not to (#1116). A Claude Code search whose tool use has no string id cannot be matched to a result: the slot
  sends its `found` at once, with no addresses. A `user` event that carries several tool results (a CLI running tools in parallel) is not
  read as a search's: each of its searches is `found` with no addresses (checking a real plan's parallel results is for release
  acceptance). Local clients use their own tools.
- **Tests.** `web-search.test.ts`; the UI test `test_private_ai.py` `test_02b` shows the sources under an
  `/ai` answer.

## Run token and the worker's MCP client (F-027 A2 and A6, #280, #484)

- **Minting** (`apps/server/src/personal-runs/run-tokens.ts`, INTERNAL `POST /api/internal/v1/personal-runs/:id/run-token`).
  The API is the authorization server: it signs the token with the same JWKS as every MCP access token
  (`auth.api.signJWT`). The worker stores the SHA-256 of a one-time nonce on the in-flight run
  (`personalRunTokenRows.arm`, `reading` or `dispatching` only) and sends the nonce once. The API mints one
  token per run for the owner's `owner_assistant` connection in the run's workspace: `sub` and
  `flux_owner_user_id` the owner, `flux_connection_id`, `scope` `flux.context.read`, `flux_run_id`,
  `flux_place` (project and conversation), `jti`, audience `/mcp`, lifetime `RUN_TOKEN_LIMITS.lifetimeSeconds`
  (the run's clock plus 300 s). It records the `jti`, the expiry and the exact tools (`assistantRunTools`: the read tools the
  owner's switches enable, sorted; the co-work bootstrap and playbook never). Every refusal is the same 404.
  Migration 0100 adds the columns; the token itself is never stored.
- **At `/mcp`** (`agent-connection/run-token.ts`). A bearer with run claims also needs: the run in flight
  for its owner, the minted `jti`, not closed, not expired, not stopped, its place, and the owner's
  assistant connection. Each request lists exactly the run's tools that the live switches still allow
  (`restrictTo`); any other tool call gets the S6 refusal (`MCP_ENTRY_UNAVAILABLE`) before anything runs;
  resources and prompts are not offered. Every tool reaches only the run's project: a change that names
  an object elsewhere is refused with `OUTSIDE_RUN_PLACE`, as a read of it is. Results are bounded
  (`boundRunResult`): over 256 KiB per result or 8 MiB per run (safety bounds, #843), the result is replaced by an error and the
  run records `mcp_limit`; the processor ends it `cap_reached` with `end_reason = mcp_results_too_large`.
  The delivery fence rechecks the run, so nothing reaches a token after its run ended.
- **No run posts (#1063).** An agent's run posts in no conversation by itself, whatever its "What it may do" (F-036 AG-3
  "Never possible", AG-8, C-39). Its tools never include `flux_start_conversation` or `flux_reply_in_conversation`
  (`RUN_NEVER_POSTS`; a local client keeps them, LC-2), and the change executor refuses a run's `conversation.create` and
  `conversation.reply` with `RUN_POSTS_NOWHERE`, on its call and on an Approve of a saved one. Its answer reaches others only
  where Flux puts it: the asker's Show everyone, the task's discussion for a run on a task, the agent's private chat. Every brief of
  a run that can change things says so (`NO_POSTING_LINE`). `agent-runs-post-nowhere.test.ts` has a model obey a message in the
  conversation that tells it to post, and nothing is posted.
- **No run tells another person (#1089).** A run's change that would notify someone other than its owner waits for the owner's
  OK with the reason `tells` (AG-3 "Telling another person"): a task created or changed to wait for another person
  (`waitingFor`, unless it already waited for them), a new title or blocker on a task that goes on waiting for another person (their
  Needs-you item shows both), or a decision (`affects`) or result (`work`, `finishes`) linked to a task another person owns. These are
  the notifications that would carry the agent's words (`toldPerson` in `assistant-changes.ts`). The waiting change keeps that person
  (`told_user_id`, migration 0043) and shows everyone it would tell (`tells`: that person, and for a decision or result every other owner
  of a task it is about, read when it is shown, #1102) and the words (`after`) on its card and in the Inbox, also when it waits for
  another reason (a task for Jonas that would tell Maja shows both); long words take three lines and "Show all", and on a phone the
  names go under the words. The owner's Approve
  makes the change and Flux then notifies them. A local client is not held to this (LC-2).
- **A server agent's line notifies only its owner (#1089, AG-4).** A message written by an agent that is not a local client (a run's
  blocker or result line, a task's report from the drain) still shows in the discussion, but the notification generator gives it to
  nobody but the agent's owner (`ProjectMessageFacts.onlyNotifies`), so an @name in it sends no mention, push or email. A local client's
  message notifies as before. An identity is one or the other: one with a server setup (`assistant_settings`) is a server agent whatever
  else signed in as it, and `POST /api/v1/my-agents {agentId}` refuses a server setup on a local client's identity
  (`AGENT_IS_LOCAL_CLIENT`, 409).
- **Worker** (`apps/worker/src/personal-runs/mcp-session.ts`, `run-tokens.ts`). `mcpToolHost` mints the
  token, lists the tools (MCP 2026-07-28, stateless HTTP) and offers the model only the minted ones; a
  refused call (401/403 or a JSON-RPC error) is an error result; `close` ends the token
  (`run_token_closed_at`). `FLUX_API_INTERNAL_URL` (default `http://api:8080`). A revoked assistant
  connection ends a run that holds a token `revoked` at the next standing check.
- **Ambient context** follows the switches too: with conversations, tasks or maps Off, a `server`
  request carries none of their messages, open work or selected thought; the owner's request is input.
- **Tool definitions and the input bound** (2026-10-16, founder direction on #484). Measured with
  `assistant-run-tokens.test.ts` (a test diagnostic, every switch on): the run lists 18 read tools whose
  definitions took 14,464 bytes, so at one token per byte (PROV-3) and the 16,000-token bound a fake
  provider that kept calling `flux_list_contexts` reached the input bound at its 2nd request. Now the
  definitions take 7,729 bytes (-47%) and ten turns fit. Two changes: the tool descriptions are shorter
  (`agent-connection/domain-reads.ts`, `bootstrap.ts`, descriptions only; the schemas `/mcp` serves are unchanged), and the
  worker drops from each schema what costs tokens but tells the model nothing (`compactToolSchema` in
  `apps/worker/src/personal-runs/mcp-session.ts`: the `$schema` URL, zod's regular expression beside
  `format: "uuid"`/`"date-time"`, the unbounded safe-integer range; `/mcp` still validates). The
  per-request input bound of a run with tools is `PERSONAL_RUN_LIMITS.maxToolInputTokens`, now 64,000
  (`personalRunMaxInputTokens`); a request without tools has 32,000 (#843). There is no per-request
  money ceiling any more; only the key's one daily budget (#854).

## Runs on the owner's own Claude Code (F-022 T5, #280)

`createRuntimeRunProcessor` (`core/personal-runs/runtime-run.ts`) handles a run whose `engine` is
`runtime`: the same standing checks before the CLI starts, while it runs (stop, a result bound, a
revocation, about once a second) and inside the commit; no source reading (the CLI reads through the run
token); `RUNTIME_RUN_LIMITS` (#843: no runs a day; safety bounds of 200 turns, one hour of wall clock,
10 minutes without an event and a 64 KiB answer). A plan limit pauses an owner's
request: `pauseUntilReset` queues a new run (`retry_of_run_id`, `resume_at` at the reset,
`end_reason = plan_limit`) that `startableQueued` starts after the reset, at most three times in a row
(`MAX_AUTO_RESUMES`); without a reset time it tries again after `PLAN_RETRY_MS`. A request with a row in
`assistant_changes` is not resumed: a second try would repeat it. It never moves the request to another connection.
The worker's `managerPersonalRuntime` resolves the owner's own slot and binding from the database and
streams the run through `runtime-manager` (`streamManagerRun`); the slot's `run.ts` runs the fixed
template, checks `system/init`, reduces the JSONL to closed frames and ends each run in its own outcome.
Each end has its own `end_reason` (0100); a dispatched runtime run costs nothing in Flux and its usage is
`unknown` (not visible to Flux). The committed answer has token-shaped strings and the run token replaced
by "[removed: looked like a secret]" (`answer_redacted`). A `server` run on an API key is redacted the same
way before its answer or proposal is committed (token patterns only: its context holds no run token;
2026-10-16, #484). An enablement names its engine; a runtime
enablement has no key connection and its own consent. Operator view: [agent runtime](../operations/agent-runtime.md#runs).

**Observed 2026-10-16 with the pinned real Claude Code 2.1.285** (`tests/app/e2e/runtime-run-claude.e2e.ts`, run in
the `mcp-clients` image against the scripted local model, no account): started with the run template's exact argv and
the slot's environment, its `system/init` has the fields `agents, analytics_disabled, apiKeySource, capabilities,
claude_code_version, cwd, fast_mode_disabled_reason, fast_mode_state, mcp_servers, messaging_socket_path, model,
output_style, per_turn_effort_active, permissionMode, plugins, product_feedback_disabled, session_id, skills,
slash_commands, subtype, tools, type, uuid, view_mode`; `tools` lists exactly the run's 18 switch-derived Flux tools
(no built-in tool and no `EndConversation`); `mcp_servers` is `[{"name":"flux","status":"connected","source":"dynamic"}]`;
and its Flux call was answered through `/mcp`, so `FLUX_RUN_TOKEN` reached the MCP `Authorization` header through
`${FLUX_RUN_TOKEN}` expansion (no `headersHelper` is needed). Plan-limit, expired-login and refusal wording still
needs a real account (T10). The same live check found that `runtime-egress`'s `/mcp` forwarder dropped MCP
2026-07-28's `Mcp-Method` and `Mcp-Name` headers (the route answered 400); it now forwards them, `Mcp-Wire-Codec`
and `Mcp-Param-*`.

## Switching production on

Done in #179 (F-020 PROV-1), 2026-10-03:

1. `personalConnectionLookup(db)` (`packages/db/src/repositories/personal-connections.ts`)
   over #124's owner key custody. It returns only the caller's own active connections with a
   stored key: exactly the one the enablement names, and without a name the newest, used only to
   describe enabling. A removed connection is gone with no fallback. No foreign key is added from
   `personal_run_enablements.connection_id`: the test-only fixture connections are not rows.
2. `personalKeyResolver(db, masterKey)` opens only that connection's sealed key for one
   dispatch, bound to its owner and id.
3. The operator switch `FLUX_PERSONAL_RUNS=on`. The API composes the real lookup with
   `providerEnabled: true`, and the worker composes `providerPersonalCompute({ enabled: true,
   resolveKey, policy })`. Empty or `off`, the default, keeps the real lookup and a disabled
   provider, so every run is `provider_off` at zero cost. Any other value stops both apps.

Before an instance switches it on, its operator repeats the price and model check of
[Price and model](#ports). There is no independently verified real-key provider pass (PROV-6) as a gate
for O-008: the gates are the mock verification gates of 2026-10-08 (founder direction 2026-10-16).

## Test-only switch

`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`, accepted by the API and the worker only together
with `FLUX_TEST_FAILURE_INJECTION=true` (any other value refuses to start), composes
`testFixturePersonalConnections` (every person has one stable fixture connection) and turns
the switch on. The worker then uses the **real** adapter registry with Anthropic's URL =
`FLUX_TEST_ANTHROPIC_URL` (a plain `http://host:port` origin, whose host the endpoint policy then
allows; the fixture connection is Anthropic `claude-sonnet-5` at its table price) and a fixed non-secret fixture
"key". Only `scripts/check_ui.sh` sets it, against the `anthropic-mock` Compose service. It
lets the browser suite drive a whole run through the production code paths without a model.

## Progress events

The worker recovers at most 100 stale runs on startup and every minute, without
overlapping passes in one process. Runs untouched for 15 minutes (the dispatch
job expires after five) end without another owner invocation: queued/reading as
`unavailable` with zero charge and a released reservation; dispatching as
`provider_failed` with its reservation retained as `unknown`. Recovery never
calls the provider or enqueues a retry. Concurrent workers skip locked rows;
terminal state and owner-only progress commit together. A late worker cannot
publish after recovery. Shutdown waits for the active pass before closing the DB.

Every status change of a run — queued, reading, dispatching and each end (completed,
truncated, stopped, denied, paused, revoked, cap_reached, unavailable, input_too_large,
provider_failed), and a stop request during dispatch — records `assistant_run.changed.v1`
with `objectType` `assistant_run` and the run id as object. The access policy gives that
object one reader, the run's owner while active in its workspace, so the event's audience
rows and its stream delivery are the owner's alone. The run, its prompt, its status and its
progress never leave the owner. The event carries identifiers and the status only; the owner's
client refetches `GET /api/v1/assistant-runs/:id`.

F-027 AST-6 ("Visible to everyone", 2026-10-17, #404) told the others that an assistant was working
(`project.assistant_working.v1`; the route `GET /api/v1/conversations/:id/assistant-activity` that listed who was working is gone, and
it answers 404). Since #842 that is gone for `/ai` and for a chat: the others hear nothing about a private run. The event is still
sent for a task's run, which posts its result as a message in the task's discussion.

## Changes, Undo and the owner's lane (F-036 AG-3, #855; F-027 A3 and A4, #403, #404)

The run's change tools go through `assistantChangeExecutor`
(`apps/server/src/agent-connection/assistant-changes.ts`): each call is applied, waiting or refused, and
recorded in `assistant_changes` in the same transaction. `classifyAssistantChange`
(`packages/core/src/assistant/changes.ts`) decides from the agent's "What it may do" and the facts of the
change, in this order: Only read refuses; a change the owner cannot make is refused and prepares nothing; a
deletion waits (`removal`); something of another person's, or a task for another person, waits (`others`); Ask
me first waits (`ask`); anything else is made at once. "Yours" is what you or any of your agents made and nobody
else edited. Nothing that waits ever expires.

- **Who decides.** A waiting change is the owner's alone: Approve (Delete), Edit, Skip (Keep) and Approve all
  answer everyone else with the same 404 as for a change that does not exist (another member, a workspace admin,
  a guest, a stranger). The routes take only a signed-in session, so an agent's bearer or a run token is
  refused, and no tool of any agent decides anything, even its own item. Approve re-executes the saved call with
  every check under the server-owned `owner_approval` purpose: the source run must be live or normally completed
  (a stopped, failed or cancelled one supplies nothing); Pause blocks it and a resume does not apply anything by
  itself; Off, Only read, the owner losing the rights, a revoked binding and Skip close the saved change for good.
  Edit changes the title of a waiting new task and nothing else.
- **Inbox.** One item per run with something waiting (`assistant:<runId>`, "3 things wait for you", with Approve
  all and Open). A run that only made things reports on its message, not in the Inbox.
- **Hand-off to the owner's own agent.** `flux_create_unit` is listed to a run under the Tasks switch with its own
  strict input (`assistant-unit-create/v1`: exactly `projectId`, `clientCommandId`, `peerRequestClass`, `taskId`,
  `unitKey`, `expectedTaskVersion`, `assignmentConnectionId` and the literal `parent: null`; no runtime session, no
  grant). The server chooses the view from the verified run token, never from the input; the ordinary external
  schema is unchanged. The adapter is `ownerAssistantUnitCreationInTransaction`
  (`apps/server/src/co-work/assistant-units.ts`): the recipient must be a different, live, unrevoked, external
  connection of the same owner that works in the project; another person's agent, the assistant itself or an
  unknown id is refused before anything can wait; the root run id lives in its own namespace
  (`assistantHandoffRunId`); review is separated from execution across every unit the task has had, not only the
  run's. It opens a *pending* unit and grants nobody a claim. In "Ask me first" the saved call carries the view's
  name and the stored arguments are decoded by exactly that view on Apply (an unknown version needs Ask again).
  Undo cancels exactly the unit this change opened, at the version it was created at, never claimed, under the same
  lock order a claim takes (the assistant's and the recipient's connection slots, the project graph, the task set,
  then the unit row); after the recipient started it changes nothing and says "Your Codex already started. Open the
  task". The cancelled unit, its audit and its run count remain, so a replay meets the stopped unit.
- **Undo** is a set of compensating, versioned writes through the domains' own commands (`work.updateWork` with
  `restore`, `docs.updateDoc`, `maps.updateThought`/`moveThoughts`/`rename`/`removeThought`/`removeLink`,
  `work.undoTaskCreation`), run as the person who undoes: the owner, or anyone who may edit in the project (a
  stranger gets 404). What was done is the run's message for everyone who can read the conversation
  (`GET /api/v1/conversations/:id/assistant-changes`: the owner sees all of their own rows, others only what was
  done); a waiting change or a refused Approve never leaves its owner. The web shows this as one line on the
  message with Undo beside it (`assistantChangeLine`), then "Undone by Ada"; there is no Activity list. A local client's changes to a task,
  a Wiki page or a map show the same line on that object (#868): `assistant_changes.scope_id` (migration 0047) names the task, the page or the map
  (also for a thought, a link or a move on it), `GET /api/v1/projects/:id/assistant-changes?kind=work|doc|map&id=` lists them, and the web's
  `ClientChanges` shows the newest three with the change line's own Undo. The restore is recorded as "Jonas
  undid Ada's assistant's change". Task fields come back where untouched since: title, outcome, status (with the
  blocker and who it waited for, when leaving Blocked), done-when, prerequisites and who a task waits for; a map's
  name; a page's text; a thought's text and position; created thoughts, links and tasks are removed. **A created map, a proposed decision and a posted message** (founder direction
  2026-10-29, #68 closeout) are taken back by `assistantRemovalRows` (`packages/db/src/repositories/assistant-removals.ts`), reachable only
  from this Undo, only for the assistant's owner, only for what this agent made and only while nobody used it (edited, decided,
  replied to, cited; the reason comes back in words).
  Taking one of these back takes the project's task-graph lock first (a map's own row before that, `FOR NO KEY UPDATE`, as the writers
  of its thoughts do), and every work path that cites one of them re-checks its targets right after taking the same lock. (A message reference once held the cited message `FOR SHARE` through
  `lockCitable`; messages are no longer citable, #867.) A citation and the
  Undo serialize and the loser is refused (race tests in `assistant-changes.test.ts`). A message stays as a tombstone (`project_messages.removed_at`, migration 0129, text "[Removed with
  Undo]"); a map and a decision
  are deleted with the links and notices only they owned. The change row keeps who and when, a hash and length for a message, and
  the event `project.assistant_change_undone.v1` carries ids only. Refused while the workspace's AI is off (F-029, F-030).
  **A page the assistant started** (#1021) is the one exception: it is taken back by the page delete of #941 (`docs.deleteDoc`), as the owner,
  and only for the owner, with the AI switch on. `untouchedDoc` first checks, under the page's row lock, that every version was written by
  that agent (or is the version the owner's own Undo of that agent's edit wrote; the receipt of that undone `doc.update` names it as
  `undone.version`, so an Undo of a whole run, which takes the edit back first, can then take the page), that nothing names the page
  (a link to it, a message that cited it, an agent suggestion or a task plan item made from it), that no call is held on it
  (`live_sessions`, available or rotating) and that nobody has unsaved text in its shared copy. Otherwise it says "Changed since. Open
  it" or "Used since. Open it" and the page stays. Unlike the map, result, decision and message, taking a page back does not take the task-graph lock first: the page delete takes
  the page's row, then the graph, and the Undo follows that order.
- **The lane.** One working run and one waiting request per owner. `personal_runs.authority`
  (`owner_request|owner_schedule`, migration 0108; `owner_reaction` went with reactions, #858) and `background_label` (a schedule's name) say what
  started a run; A8 sets the last. The owner's own requests start before queued background runs, and a
  queued request carries `behind` (the working run's authority and label) so its line reads "Next: '…'" or
  "Finishing your Daily check first. Yours starts next. · Stop the daily check".

## Places and private answers (#842)

A run belongs to a **place** (`projectId`, `conversationId` and `dmId` on `personal_runs`, all nullable; migration `0022`):

| Place | Columns | Audience of the answer | Reads | Tools of its run token |
| --- | --- | --- | --- | --- |
| A conversation, thread or task thread of a space | `project_id`, `conversation_id` | the people who read the space | the conversation and the space's open work | the space's, as before |
| A space's main conversation | `project_id` | the same | the latest messages of the space's conversations and its open work | the space's |
| A direct message | `dm_id` | the DM's participants | the DM's latest messages, given in the request | `flux_read_web` and the provider's web search only |
| A thread of a direct message (#1016) | `dm_id`, `dm_thread_root_id` | the DM's participants | the thread's root and replies, given in the request | `flux_read_web` and the provider's web search only |
| An agent's private chat | none | its owner | the chat's earlier turns, and what the owner can see through the tools | every read tool of the owner's reach, no change tool |

Only a run in a space has an AI epoch and is held to the space's switch (`place.ts`); a run in a DM is held to its owner still taking part
in it; a chat's tools are gated by each space on every call. `flux_place` in the run token carries `{ project, conversation, dm }`, and
`runReaches` is the one test the MCP route uses: a run in a space reaches that space, a run in a DM no space, a chat every space of its owner.

**Routes.** `POST` `/api/v1/conversations/:id/assistant-runs`, `/api/v1/projects/:id/assistant-runs` (the main conversation),
`/api/v1/dms/:id/assistant-runs`, `/api/v1/dms/:id/threads/:rootId/assistant-runs` (a DM's thread, #1016) and `/api/v1/my-agents/:id/assistant-runs`
(a chat) start a run through the one `start`. `GET /api/v1/assistant-runs` lists the caller's own runs, narrowed by `conversationId`, `spaceId`,
`dmId` (the DM's main line; with `dmThreadRootId`, that thread) or `chatAgentId`.

**The answer is its asker's alone.** `isPrivateAnswer(run)` (kinds `ask`, `summarize`, `map_thought`, `scheduled`) means: no working event, no
proposal, nothing for the space. (There is no list of "posted answers" and no answer-committed event for any run, #1120: what an agent says to the
people of a task is a message of the task's discussion, posted by the agent-task drain as the agent, with the access of any message.) The asker sees it as a card
(`PrivateAnswer`) with **Dismiss** (`POST /assistant-runs/:id/dismiss`, final) and **Show everyone** (`POST /assistant-runs/:id/show`): the
core plans it (`planShow`: their own, committed, not dismissed, still allowed to write there, and AI still on in the space), the adapter posts
it as their own message with `via` set to the agent's name, under the run's id, and `markShown` records it (a reply in the thread for a run in a
DM thread). A DM also gets the line "Ada used AI here (Claude)" (`dm_messages.kind = 'ai_used'`, in the DM's main line, also for a thread) when the
run is made.

**An agent's own lines in its chat (#919 builds on this).** The owner's words and the agent's answers to them are runs; what the agent says on its
own (a report: "Done: #4 … · 3 changes · Undo", "Stopped by Maja") is a line in `agent_chat_messages`, each about one run of that agent. There is one
way in, `postToAgentChat(ports, { agentId, runId, key, body })` (`packages/core/src/personal-runs/agent-chat.ts`), usable from the server or the
worker in the caller's unit of work: once per `key` for the agent, redacted like every agent text, and it sends the run's owner-only event so an open
chat reads again. What is unread is `unreadAgentChats(ports, ownerUserId)`: per agent, the lines and chat answers after `agent_chat_reads.read_at`, which
opening the chat sets (`POST /api/v1/agent-chats/:agentId/read`); `GET /api/v1/agent-chats` lists it and
`GET /api/v1/agent-chats/:agentId/messages` the lines, with `readAt` (#1246): when the owner last had the chat open, read before the chat's own "read" moves it, so the open chat
can put its "New" divider above what the agent said after it. An agent has one owner, so per agent is per person.

**Locks (#921).** Unchanged: the owner's lock first (`enablement(…, { lock: true })`), then the task graph (`prepareTaskUse`, which holds nothing
for a run outside a space), then the run row. Dismiss and `markShown` take only the run row; Show everyone posts in its own transaction
before it.

**Schedules (#858).** A schedule (`assistant_jobs`, migration `0024`) belongs to one of its owner's agents and to no space. The worker's per-minute tick
fires it through `startBackground`, which makes a `scheduled` run in the agent's chat place (no project, conversation or DM; `authority: owner_schedule`).
It reads like a chat run and changes nothing; the answer is a private one (`isPrivateAnswer`). The chat lists what its owner said and the answers to it
(`GET /assistant-runs?chatAgentId=`), not a schedule's run: when the firing settles (`job-settle.ts`, by the tick or by the owner's own list, which reads
first and locks only what has ended) the result is one message in the agent's chat through `postToAgentChat` (key `job:<firing>`, `schedule` = its name,
times and whether it failed), except "Nothing to report". A firing that fails or cannot start ("Sign in to Claude again", no budget, Flux was off) has no
run: `fireJob` writes its history line and the same words in the chat (`run_id` null, no event: the open chat reads them when it next reads) once, not again
while the same line repeats, and trims the history. There is no failure count and no pause (C-14). Deleting an agent deletes its schedules.
What the owner says to the agent in its chat can prepare a schedule: the chat's brief tells the model to end its answer with one `<schedule>` block,
`answerWithSchedule` takes it out and prepares the job off, and the owner's tap (`PATCH` with `enabled: true`) turns it on. `/ai` in a space and a
schedule's own run drop the block. The routes are `/api/v1/my-agents/:agentId/schedules`.

A scheduled run cannot be retried (`ASSISTANT_RUN_NOT_RETRYABLE`: Run now is the way). Deleting an agent locks its schedule rows before the owner's lock (`removeAgent`), the order a firing has, and
settling a firing takes the schedule row before the firing's own, so none of the three can deadlock with another. No run is posted for its owner (#1104): a `scheduled` run is a private answer like a chat's (`isPrivateAnswer`), and there is no "silent" run (migration `0048` dropped the column). A schedule whose owner is a guest of the company
(C-50, #1059) neither fires nor writes a history row or a chat line; its next time moves on.

## The brief (#1064)

Every run is told what to do by one builder, `buildBrief` in `app/packages/core/src/personal-runs/brief.ts`, for every place (`/ai` in a
space's thread, task discussion or main conversation, a DM and its threads, the agent's private chat, a task run, an answer to another agent,
a schedule's run) and for both engines. An API-key run sends its `system` as the system prompt and its `request` as the one user message;
the owner's Claude Code or Codex gets `runtimeBrief`, the same two texts in that order, on standard input. The runtime appends only a short,
place-neutral line to the CLI's own system prompt (`RUN_BRIEF`), and the MCP route's run instructions are place-neutral too. The full text of
each case is pinned in `app/tests/app/snapshots/ai-brief/`, so a change to what a model reads shows as a diff in review (rewrite them with
`FLUX_WRITE_BRIEF_SNAPSHOTS=<dir>` on `ai-brief.test.ts`).

- **System**: who the agent is and whose (names the owner gave: the agent's and their own), where it was asked (the kind of place only),
  the time now in the owner's time zone (`personTimeZone`: their browser's zone, which the web app saves on them, `auth_users.time_zone`, C-57; the zone a schedule they ask for runs in); who reads the answer and so what it may
  use of Flux (AG-4, C-37); how to answer (in the asker's language, short, in the message subset of Markdown that the one renderer draws (`FORMAT`, #1247; `assistant.md` AG-4), written so the asker can post it
  as their own message with Show everyone, with no "You asked…" or lead-in and only the text when asked to draft one, `[S<n>]` marks where
  sources are numbered, `#12` and `[[Wiki page]]` that stay links after Show everyone, names without `@`, general knowledge never passed off
  as what the conversation says, an honest "not in the conversation", files it cannot open); the tools and the ids they need, the
  no-posting rule of #1063 (`NO_POSTING_LINE`) whenever the run has change tools, the web rule of C-30 when `flux_read_web` is listed; the
  schedule block for the agent's private chat (C-53: `/ai` in a space and a schedule's own run make none); what is data, with what a message's `via`, `kind`,
  `edited` and "(agent)" mean; and last what the owner gave the agent (C-7, C-8).
- **Request**: `<place …/>` with the names of the space, the task or the DM's people; for a task run the whole task (outcome, done-when,
  prerequisites, due day, blocker); the space's open tasks and the place's messages, each with its mark, author, time, `kind`, `via`,
  `edited`, attachments by name (with their file id when the run's model sees pictures and has `flux_view_image`, #1217), and in a space's main conversation the opening words of its thread where the thread changes; a line that says when older messages
  were left out (the window reads one message more than it gives, and the fit that drops the oldest ones says so too); the chat's latest
  exchanges; then the request, the schedule's instruction, the task's assignment or the other agent's question, last.
- **Rules of the text.** Nothing other people wrote is in `system`: a space's or task's name, a message, a DM's other people. Content is
  fenced in tags with `<` and `>` escaped, so a message cannot close its tag or forge the request; `&` stays, so an address is read exactly
  as a person wrote it (C-30). The `<ask>` block of a task run's assignment stays as written. The old "Label statements as Fact,
  Interpretation or Proposal" is gone.
- **The engines differ only in what each can do.** An API-key run is given the place's messages and open tasks as numbered sources it
  cites. The CLI reads a space itself with the Flux tools (it is told the ids and where to start), and is given a DM's messages and a chat's
  turns, without marks. The worker reads the brief's names for the CLI after the same place checks as an API-key run's read
  (`brief-facts.ts`); if that read fails, the brief goes without the names (the agent's instructions and memory are read on their own) and
  the tools and the commit's checks still decide.

What a run may read and change is decided by the server, never by the brief: the audience of each place, deleted messages, encrypted spaces,
guests and the address rule are unchanged.

## WebSocket commands

Not planned (founder direction 2026-10-16, [#68](https://github.com/ColdPhase/flux/issues/68)).
The HTTP requests are enough and there is no user-visible difference. `GET /api/v1/stream` stays
server-to-client only: the connection ignores every client frame, and the API test pins that an
`assistant.run` or `assistant.stop` frame does nothing. The UI invokes and stops through the HTTP
API, which resolves the owner from the session.

## UI (AC-8)

`app/apps/web/src/assistant/`, on the existing conversation, Details and settings patterns and
tokens:

- **Ask mode.** A ✦ *Ask my assistant* button in the composer, or `/ai <prompt>` at the start
  of the box, shows "Your assistant ×" and one line: who sees the answer and "paid by you, up
  to $0.08" — or, calmly, why not (not set up → *Connect your AI*; paused → *Resume*; capped →
  *Raise cap*; unavailable → the reason, e.g. "In-app AI is turned off on this Flux server").
  Send stays disabled when blocked; Esc, × or Backspace in an empty box return to a plain
  reply, which always works. One request, then the composer is a reply again. A refused ask
  explains itself; a manager whose assistant lacks access gets *Let your assistant read this
  project* (a space member grant).
- **Working line.** Owner only, where the answer will appear: "Your assistant is reading this
  conversation…" with **Stop**; afterwards "Stopped. Nothing was posted." or the failure, with
  Retry where it makes sense. It follows the owner's progress events, and polls while the
  stream reconnects.
- **Answer.** Since #842 it is the asker's private card, see above: the body and `[n]` citations that open exactly
  their source (a message in the conversation, a work item in Details, a map thought).
  Committed answers renumber the model's `[S<n>]` labels to `[1]…` in the order of `sources`.
  No cost is shown. A run on a task has no card of its own for the people: its result is the agent's message in the
  task's discussion, like any other agent-posted message (#1120).
- **Settings** at `/settings/assistant` (Settings → AI, and Details → *Connect your AI*): the
  model picker grouped by connection (Connect AI's default first), the assistant per workspace
  (create one there) and *Turn on*; then state, Pause/Resume, the connection's line (the plan's
  remaining usage or the key's spend today against its daily budget) and *Turn off*. Without any
  connection it points to Connect AI (#854). There is no consent checkbox and no cap of Flux's own.
- `GET /api/v1/personal-assistant` adds `setup: { provider: 'on' | 'off', connection: 'active' | 'none' }`,
  the caller's own, so the UI can state why an assistant cannot run.

## Data

- `personal_run_enablements` has one row per person. It holds the consent
  snapshot: version, time, provider, model, and the payer organization and
  workspace copied from the connection. It also holds `per_run_cents` (6–50,
  default 6), `daily_cap_cents` (10–1000, default 100), the IANA `time_zone`
  whose midnight resets the cap, `status` (`active` or `paused`) and `version`.
  The consent provider is any F-020 provider kind (`0042`).
  `connection_id` is a nullable uuid **without a foreign key**. It will reference
  #124's connection table when that table lands. Until then, every step compares
  it with the connection the lookup returns, and every run uses exactly that connection.
  When it is removed, the status is `connection_changed` if the owner still has another
  connection (which needs its own consent) and `no_connection` otherwise.
- `personal_run_agents` maps each workspace to the owner's assistant agent in it.
  The owner's own access bounds what a run may read (F-036 AG-3).
- `personal_runs` stores the request, place, agent and connection snapshot
  (with the connection's `provider` and `model`, shown as the answer's provenance),
  status, reservation (`reserved_micros`), `cost_state`, observed usage and
  charge. It stores the committed answer only after the final recheck. A partial
  unique index enforces one run in flight per owner.

There is no table of assistant proposals: migration 0044 (#1054) dropped `assistant_proposals`, which stored a drafted result
for a person to accept, with the Result object. The #52 `agent_proposals` table (an MCP client's `flux_create_proposal`) is a separate thing and stays.

## Money

Amounts are integer micro-dollars. Only runs on an API key cost money in Flux; a run on a
Claude or ChatGPT plan is the plan's (#854). Each key has **one daily budget** in its own time
zone (`background_compute_connections.daily_budget_cents`, `time_zone`); there is no per-run
ceiling and no second allowance. `apiKeySpendToday` counts the key's spend since its local
midnight: the charge of `observed` runs and comparisons plus the most an `unknown` run could have
cost, and apart from that what in-flight work holds, which no usage line shows as spent; `released`
runs cost nothing. Asking admits a request while the key's charged
spend is under the budget. When the worker claims the run, it reserves turns × the largest request
(64 000 × the input price + 4 000 × the output price with tools, 32 000 × input without; F-020
PROV-3, #843) at the key's price, rounded up and never above what is left of the budget; with
not even one request's room left the run waits for the key's next day (`end_reason = 'budget'`,
`resume_at`). The claim stamps `reserved_at`, the day the run counts on, so a request that waited
overnight counts when it runs, and `largest_request_micros`. Each turn keeps what was spent so far
in `charged_micros`, so a run lost with its worker counts that and one more request, not its whole
reservation. A connection without a price is `PERSONAL_RUN_PRICE_UNKNOWN` / `price_unknown`.
Usage is charged at the connection's price, or at the provider-reported cost when the response
carries one (OpenRouter), and each search of the provider's own web search at $0.01 on top, with 5
searches reserved for each request that offers it (#954).

## HTTP API

Every route needs a session. None of them reads an owner, agent or connection
from the request.

| Route | Who | Result |
| --- | --- | --- |
| `GET /api/v1/personal-assistant` | the caller | Own state `not_enabled`, `ready`, `paused`, `capped` (the key's daily budget is used) or `unavailable` (with `unavailableReason`), the enablement with its connection and model, and the key's spend today. |
| `GET /api/v1/my-agents/:id/status` | the agent's owner | The same state for one of the caller's own agents, on that agent's own connection and model: an agent's private chat reads this one, so removing a connection pauses only the agents that use it ([C-3](../product/decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). Anyone else's agent, a deleted one or a malformed id is 404. |
| `POST /api/v1/personal-assistant` | the caller | Enable with `{ agentId, connection, model }` (#854; `connection` is `claude_plan`, `chatgpt_plan` or one of the caller's API key ids): 201. It needs the caller's own agent (`agent.invoke`) and that connection. |
| `GET`, `PUT /api/v1/personal-assistant/model` | the caller | The models of every connection the caller has, grouped by connection, the current pick and Connect AI's default; `PUT { connection, model }` changes it. |
| `PUT /api/v1/personal-assistant/agents` | the caller | `{ agentId }`: the caller's assistant for that agent's workspace. |
| `POST …/pause`, `POST …/resume`, `DELETE /api/v1/personal-assistant` | the caller | Pause ends queued work at zero cost. Delete also removes the consent. |
| `POST /api/v1/conversations/:id/assistant-runs` | the caller | Invoke `{ clientRunId, kind, prompt, target?, continuesRunId? }`: 202 with the run; the same `clientRunId` returns it again (200) and never charges twice. |
| `GET /api/v1/assistant-runs`, `GET /api/v1/assistant-runs/:id` | the run's owner | Own runs with status and cost. Anyone else gets 404. |
| `POST /api/v1/assistant-runs/:id/stop` | the run's owner | Before dispatch: `stopped` and free. During dispatch: best-effort abort, the charge is kept and nothing is committed. |
| `POST /api/v1/assistant-runs/:id/retry` | the run's owner | `{ clientRunId }`: a new, separately capped run with the same request (202). |
| `GET /api/v1/conversations/:id/assistant-changes` | project readers | The run messages of the conversation: the owner's own rows in every state, everyone else's what was done (applied, approved, undone, skipped) with `undoable` true only for someone who may edit (F-027 A4). Non-readers get 404. |
| `GET /api/v1/projects/:id/assistant-changes?kind=work\|doc\|map&id=` | project readers | The local clients' applied changes (applied, approved, undone) to one task, Wiki page or map of the space, oldest first, the newest 50, with `via` ("Claude Code", "Codex" or the client's name) and `undoable` as for a conversation's list (#868, LC-2). A waiting change and a run's change are not listed. Non-readers get 404, a wrong `kind` or `id` 400. |
| `POST /api/v1/assistant-changes/:id/apply`, `…/skip`, `…/edit`; `POST /api/v1/assistant-runs/:id/changes/apply`, `…/skip` | the owner only, in their own session | Decide waiting changes (F-036 AG-3). Everyone else gets 404. |
| `POST /api/v1/assistant-changes/:id/undo`, `POST /api/v1/assistant-runs/:id/changes/undo` | the owner, or anyone who may edit | Take back one change or the whole message (F-027 A4). A reader who may not edit gets 403, a non-reader 404; only the owner takes back a created task. |

**Working-card document lifetime, 2026-10-11.** The bounded #380 repair was peer
accepted after actual WebKit observations at `216f0018`: an irrelevant stream
event started a private working-run read between `beforeunload` and `pagehide`,
with no HTTP request reaching the server. The card refreshes for its owner-only
`ASSISTANT_RUN_CHANGED_EVENT`, resync, working poll and focus, retaining current
owner/read/Stop revision fences. Document retirement suspends and aborts reads;
pageshow, focus or explicit interaction after a cancelled navigation restores
the current owner's lifetime and rechecks canonical state. It sends no automatic
Stop or other write. Genuine subsequent own-run progress and cancelled-navigation
recovery require actual browser checks; errors and existing race guards remain.

The invoke checks run in this order. A body that names another `ownerId`,
`agentId` or `connectionId` gets `403 PERSONAL_RUN_NOT_OWNER`. A conversation the
caller cannot read gets 404. Because the answer is posted into the conversation,
the caller needs project write access there, as for a message (403 otherwise). Then come the idempotent replay, the caller's own
continued run (404 otherwise) and the target thought. After that the caller's own
enablement is checked: `409 PERSONAL_RUN_NOT_ENABLED` or `409 PERSONAL_RUN_PAUSED`.
Then the provider and connection (`503 PERSONAL_RUN_UNAVAILABLE` with `reason`),
the caller's own agent in this workspace (`409 PERSONAL_RUN_NO_AGENT`), the agent's project access
(`409 PERSONAL_RUN_NO_PROJECT_ACCESS`), the one run in flight
(`409 PERSONAL_RUN_IN_FLIGHT`) and the cap (`429 PERSONAL_RUN_CAPPED`). A refused
invoke writes nothing and reserves nothing.

## Worker

The job payload is `{ runId }`. The processor checks again before the read,
before **every** preflight token-count request (a count sends the input to the
provider, so it gets the same check as a dispatch), before dispatch and inside
the commit transaction:

- the enablement (not paused or removed, same workspace agent);
- `agent.invoke` for the owner;
- the provider switch;
- the owner's connection, which must be the one the run reserved on;
- the owner's current write access and the agent's current read access to the project;
- before dispatch, the cap.

A refusal before dispatch ends the run as `denied`, `paused`, `revoked`,
`unavailable` or `cap_reached`, with the reservation released. After dispatch the
observed usage is charged. A refusal at commit stores no answer and no proposal,
and records no event.

A run reads, as its agent, only project-audience objects of the requested place:

- the latest 40 messages of the conversation;
- up to 20 open work items of the project;
- the target thought, only on a project sketch of that project.

It never reads DMs, drafts, private sketches or other projects. The fit drops the
oldest messages until the conservative Flux estimate (raised, never lowered, by a
provider count where the wire format has one) fits 16 000 tokens (32 000 for a run
with tools), or ends the run as `input_too_large`.

At commit, citations `[S<n>]` count only for supplied sources. A `max_tokens` answer is committed as
`truncated`. The commit tells the owner alone (`assistant_run.changed.v1`); nothing is recorded for the project's audience.
A `<proposal>` block in a model's text is plain text: nothing asks for it or reads it any more (#1054).

## Tests

`app/tests/app/personal-runs.test.ts` covers #68 AC-1 to AC-6 with two or more
people, plus owner-only progress events (audience rows and live streams of the owner,
a project member and the workspace owner) and a failed preflight count. It sends HTTP
requests to the API container's production composition and drives dispatch in-process
with the fakes. `app/tests/app/personal-runs-core.test.ts` checks the pure output and cost
rules. `app/tests/app/ai-brief.test.ts` pins the brief of every place and engine and checks the asker's name, time, zone, language
rule, message authors and times, the fences and the note about older messages; `app/tests/app/ai-brief-replay.test.ts` sends it through the
real adapters of both wire formats to the provider mock and checks what Flux makes of a scripted answer (marks, a made-up mark,
a secret, Show everyone). `app/tests/app/personal-runs-anthropic.test.ts` checks the adapter against a local mock
HTTP server (request shape, key, retries off, abort, timeout, counting, usage, error
mapping, limits, environment isolation) and the composition guards. Run them through
`./scripts/check_application.sh`.

`app/tests/ui/test_personal_assistant.py` (through `./scripts/check_ui.sh`, with the
test-only switch) covers the UI with three people: not set up, consent and caps,
the manager grant, the working line only for the owner, the attributed answer and its
citations for peers, Stop, a provider failure, paused, capped, and phone width. The production fail-closed states
(provider off, no key) are rendered there from a stubbed status response only.
The keyboard and modal-focus checks of AC-8 (08b to 08d, 10b) use Tab and Enter only: ask with `/ai`, reach Stop, Retry
and Dismiss, and open the Details sheet, whose focus
must stay inside until Esc returns it to the opener. They found, and the code now fixes, a Stop, Retry, Accept, Apply or Undo
that dropped focus to the page when its button went away, a `/a` left in the reply box by typing `/ai` key by key, and a
result opened from a thread button that did not take focus. `FLUX_UI_BROWSER=webkit` runs the same files in WebKit.

Screenshots of that run (light theme, 1440×900 and 390×844) are in
[`docs/design/personal-ai/app/`](../design/personal-ai/app/); they show appearance, not
behaviour or accessibility.

## Acceptance of #68 (closeout)

Each criterion of [#68](https://github.com/ColdPhase/flux/issues/68) against `main`. Two-user Docker tests; no stub is
counted as a provider pass (model billing, provider compatibility and real-device evidence are reported separately).

| AC | Evidence |
| --- | --- |
| 1 Two-user denial | `personal-runs.test.ts` "AC-1": every route (invoke, claimed `ownerId`/`agentId`/`connectionId`, read, stop, retry, continue, a mention or reply, WebSocket frames, an unknown queued job) is refused with 403/404; no model call and no run or quota row for the other person. |
| 2 No charge | "AC-2": denied, stopped-before-read, paused, capped and revoked runs record zero; a retry key never charges twice. |
| 3 Own connection only | "AC-3" and "PROV-1": a second person's runs use only their connection and cap. |
| 4 No fallback | "AC-4" (production composition fails closed, explicit state) and `test_personal_assistant.py` test_02, test_03, test_09 (provider off, no key, paused, capped; human work continues). |
| 5 Context boundary | "AC-5": seeded DM and private-capture tokens never reach the provider request or the output; every cited source opens for the audience. |
| 6 Revocation mid-run | Two "AC-6" tests: grant revoked or member removed between read and commit commits nothing and withholds the partial output. |
| 7 Proposal authority | Went with the assistant's proposals (#1054). Typed suggestions: `assistant-changes.test.ts` "A5 all typed kinds". |
| 8 Browser check | `test_personal_assistant.py` (ask by `/ai`, working line and Stop, attributed answer, citations, paused, capped; computer and phone), `test_assistant_undo.py` and `test_assistant_changes.py` (the run's message, Undo, waiting changes), and the keyboard and modal-focus tests 08b to 08d and 10b. Each runs in Chromium and WebKit (`FLUX_UI_BROWSER`). |

The workspace AI lock ([F-029](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/workspace-ai-lock.md)) and encrypted workspaces ([F-030](../product/encrypted-workspaces.md))
come first: `space-ai-runs.test.ts` (invoke, Retry and Continue refused while AI is off, a queued run ends `ai_off`),
and `encrypted-workspaces.test.ts` (a run in a sealed workspace is refused and leaves no row). The F-029 browser checks
went with its company-wide switch (F-037, #874); the per-space AI switch brings its own.

## Not yet done

- The rest of #406/#484: AST-3.2's handoff, catalog and owner-Apply parity, the
  persisted owner mark and the account row's note for a model without tool calling, a "Limit reached"
  status and copy, the Responses API for the OpenAI models that need it, and the Gemini
  thought-signature field name (unverified against Google's pages).
- A provider pass against the real API (a real key, by its owner), including billing on cancellation and
  lost responses. Not a gate for O-008 (founder direction 2026-10-16, no PROV-6 real-key gate); the operator
  who sets `FLUX_PERSONAL_RUNS=on` first does the price and model check of [Switching production on](#switching-production-on).
- Real-device (phone/tablet) and screen-reader checks of the UI; optional evidence (founder direction
  [#266](https://github.com/ColdPhase/flux/issues/266), 2026-10-05).

Dropped from the plan (founder direction 2026-10-16 on #68): the WebSocket commands, the map-thought *Ask*
entry, the header status button and `draftedBy` on the result object itself.
