# Personal assistant runs (#68)

This is the implementation contract of #68 (slices 1 and 2), under the accepted
decision [O-008](../product/personal-runs-compute.md) and the
[interaction design](../design/personal-ai/README.md). A person enables their own
assistant, invokes it in a project conversation, and gets an answer that the
conversation's audience reads as "Jo's assistant · asked by Jo". A consequential
change becomes an assistant proposal. Only a person with authority over its target
can accept it.

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
| `app/packages/core/src/personal-runs/` | Ports, input and output rules, use cases (`service.ts`), the worker processor (`processor.ts`) and assistant proposals (`proposals.ts`). |
| `app/packages/core/src/access/personal-run-access.ts` | The access policy as the `PersonalRunAccess` port. |
| `app/packages/core/src/access/policy.ts` | New agent action `agent.invoke`: only the person who owns the unrevoked agent. A workspace role never grants it. |
| `app/packages/db/migrations/0024_personal_runs.sql`, `app/packages/db/src/repositories/personal-runs.ts` | Tables and rows. |
| `app/apps/server/src/personal-runs/` | Routes and the per-transaction composition. The server only queues runs. |
| `app/apps/worker/src/personal-runs/` | The `personal-run.dispatch.v1` handler and its composition (`composition.ts`). The queue never retries a job (`PERSONAL_RUN_QUEUE`). |
| `app/packages/core/src/personal-runs/progress.ts` | Owner-only progress events (`assistant_run.changed.v1`). |
| `app/packages/core/src/access/policy.ts` (`evaluateAssistantRun`) | The `assistant_run` object: its only reader is the run's owner. |
| `app/packages/agent-runtime/src/anthropic.ts`, `openai-compatible.ts`, `registry.ts` | The adapters behind `PersonalCompute`, one per wire format (`@anthropic-ai/sdk` 0.129.0, pinned; a fetch client for Chat Completions), and `providerPersonalCompute`, which picks one by the connection's provider. |
| `app/apps/web/src/assistant/` | The UI (AC-8): ask mode, working line, answers, proposals, settings. |
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
  `ProposalUnitOfWork` adds the #101 work use case that records an accepted result.

**Price and model (F-020).** The model and its price belong to the owner's connection
(see [AI providers](ai-providers.md#prices-reservations-and-the-input-bound)); there is no
pinned model. Claude Sonnet 5 is in Flux's price table at $2/M input and $10/M output, read
from the Anthropic [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
on 2026-10-02 (2026-09-30: the page called it the standard price, and the scheduled rise to
$3/$15 "will not occur"). Check again when production dispatch is switched on.

## Provider adapters

`providerPersonalCompute({ enabled, resolveKey, policy, ... })` in `@flux/agent-runtime` picks
the adapter of the connection's wire format: `anthropicPersonalCompute` for Anthropic Messages,
`openAiCompatiblePersonalCompute` for OpenAI, OpenRouter, Gemini's compatible endpoint and
OpenAI-compatible servers. Both use the guarded transport, refuse a request outside the O-008
limits before a key is resolved, send no tools unless the run offers its Flux tools (see
[Tool loop](#tool-loop-f-027-ast-8-406-first-part)) and never retry; the Chat Completions details are
in [AI providers](ai-providers.md#provider-kinds-and-wire-formats).

`anthropicPersonalCompute({ enabled, resolveKey, baseURL?, timeoutMs?, policy? })` implements
`PersonalCompute` with the official SDK:

- one client per request, with the owner's key from `resolveKey(keyRef)`, an explicit
  `baseURL` (so `ANTHROPIC_BASE_URL` in the environment never redirects a key) and
  `maxRetries: 0`;
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

Contract: [F-027 AST-8](../product/assistant.md#ast-8--engines-the-server-tool-loop-and-the-runtime).
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
  lists it. OpenAI's function-calling guide (read 2026-10-11) says GPT-6 Astra and GPT-6.1 Sol need
  the Responses API for tool calling, which Flux does not speak yet, so they answer in one request.
  Persisting the owner's mark and the account row's "This model can answer but can't make changes"
  are not part of this change.
- **Reservation.** `toolRunReservationMicros`: turns × the largest request of a tool run (32,000 ×
  input price + 1,500 × output price; `PERSONAL_RUN_LIMITS.maxToolInputTokens`, #484), never above the owner's per-run ceiling and never below one request.
  `createPersonalRunUseCases({ toolTurns })` applies it to a connection that can call tools; the
  default is 1 (today's single request) and no composition sets more yet. `PERSONAL_RUN_LIMITS.maxTurns`
  is 10 (AST-6).
- **The loop** (`core/personal-runs/tool-loop.ts`, driven by the processor when its `tools` host
  returns a session with tools). It sends the first request, and while the model asks for tools
  checks, before running anything it asked for, the turn cap, the money reservation (the largest
  possible next request must still fit what the reservation has left) and the clock (5 minutes);
  runs each call once through the session (a call the provider could not state as JSON, or outside the
  offered tools, is answered with an error and never sent); rechecks the run's standing (stop,
  enablement, connection, access, daily cap; the same recheck as before a dispatch) before the calls
  and before the next request; and bounds the next request's input like the first. A run that
  reaches a limit ends **`cap_reached`** with `stopped_at_stage = before_dispatch`, cost `observed`
  and nothing posted; the calls already made stay made. The plain words "Limit reached" and the list of
  changes are the run's message (A4); the web copy of `cap_reached` still says "today's cap", which
  no run can reach until a worker composes tools. A separate status needs a migration and is left to
  A4.
- **Per-request reconciliation** (PROV-3). Each response is charged at the connection price or as the
  provider reported it, within what is left of the reservation. A request outside its token limits,
  or one that would take the run above its reservation, is a lost response: cost `unknown`, charge 0,
  the whole reservation counted, nothing posted (`provider_failed`), the earlier calls kept. A
  request that failed after it may have been billed does the same; one that was never sent
  (`billed: none`) keeps the earlier requests' charge. A run's input and output tokens are the sums
  over its requests.
- **Tests.** `provider-tool-calling.test.ts` (AST-8.1: every wire format against documented-shape
  fixtures in `support/provider-tool-fixtures.ts`, a local mock server), `personal-runs-tool-loop-core.test.ts`
  (reservation, reconciliation and the loop with fakes) and `personal-runs-tools.test.ts` (AST-8.2 and AST-8.3
  through the real worker and database, with a fake provider and a fake tool session).

## Run token and the worker's MCP client (F-027 A2 and A6, #280, #484)

- **Minting** (`apps/server/src/personal-runs/run-tokens.ts`, INTERNAL `POST /api/internal/v1/personal-runs/:id/run-token`).
  The API is the authorization server: it signs the token with the same JWKS as every MCP access token
  (`auth.api.signJWT`). The worker stores the SHA-256 of a one-time nonce on the in-flight run
  (`personalRunTokenRows.arm`, `reading` or `dispatching` only) and sends the nonce once. The API mints one
  token per run for the owner's `owner_assistant` connection in the run's workspace: `sub` and
  `flux_owner_user_id` the owner, `flux_connection_id`, `scope` `flux.context.read`, `flux_run_id`,
  `flux_place` (project and conversation), `jti`, audience `/mcp`, lifetime `RUN_TOKEN_LIMITS.lifetimeSeconds`
  (300). It records the `jti`, the expiry and the exact tools (`assistantRunTools`: the read tools the
  owner's switches enable, sorted; the co-work bootstrap and playbook never). Every refusal is the same 404.
  Migration 0100 adds the columns; the token itself is never stored.
- **At `/mcp`** (`agent-connection/run-token.ts`). A bearer with run claims also needs: the run in flight
  for its owner, the minted `jti`, not closed, not expired, not stopped, its place, and the owner's
  assistant connection. Each request lists exactly the run's tools that the live switches still allow
  (`restrictTo`); any other tool call gets the S6 refusal (`MCP_ENTRY_UNAVAILABLE`) before anything runs;
  resources and prompts are not offered. Every tool reaches only the run's project. Results are bounded
  (`boundRunResult`): over 16 KiB per result or 64 KiB per run, the result is replaced by an error and the
  run records `mcp_limit`; the processor ends it `cap_reached` with `end_reason = mcp_results_too_large`.
  The delivery fence rechecks the run, so nothing reaches a token after its run ended.
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
  per-request input bound of a run with tools is `PERSONAL_RUN_LIMITS.maxToolInputTokens`, 32,000
  (`personalRunMaxInputTokens`); a request without tools keeps 16,000. A tool run's largest request is
  priced at 32,000 (Sonnet 5: $0.079), so the owner's per-request limit must cover it and its default is
  $0.08 (`PERSONAL_RUN_LIMITS.perRunCents`; a run on a connection with a lower limit is `unavailable` /
  `run_cost_over_limit`, and the owner raises it). The daily cap is unchanged.

## Runs on the owner's own Claude Code (F-022 T5, #280)

`createRuntimeRunProcessor` (`core/personal-runs/runtime-run.ts`) handles a run whose `engine` is
`runtime`: the same standing checks before the CLI starts, while it runs (stop, a result bound, a
revocation, about once a second) and inside the commit; no source reading (the CLI reads through the run
token); `RUNTIME_RUN_LIMITS` (20 a day, 10 turns, 300 s wall clock, 60 s without an event, 16 KiB answer).
The worker's `managerPersonalRuntime` resolves the owner's own slot and binding from the database and
streams the run through `runtime-manager` (`streamManagerRun`); the slot's `run.ts` runs the fixed
template, checks `system/init`, reduces the JSONL to closed frames and ends each run in its own outcome.
Each end has its own `end_reason` (0100); a dispatched runtime run costs nothing in Flux and its usage is
`unknown` (not visible to Flux). The committed answer has token-shaped strings and the run token replaced
by "[removed: looked like a secret]" (`answer_redacted`). A `server` run on an API key is redacted the same
way before its answer or proposal is committed (token patterns only: its context holds no run token;
2026-10-16, #484). An enablement names its engine; a runtime
enablement has no key connection and its own consent. Operator view: [agent runtime](../operations/agent-runtime.md#runs-f-022-t5-280).

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

Still required before an instance should switch it on:

4. a fresh price and model check, and an independently verified real-key provider pass
   (PROV-6).

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

F-027 AST-6 ("Visible to everyone, controlled by the owner", 2026-10-17, #404) adds one thing for the
others: `project.assistant_working.v1` (project audience, `{ conversationId }` and nothing else) when a
run starts working (`reading`) and when it stops (any end). Readers of the conversation refetch
`GET /api/v1/conversations/:id/assistant-activity`, which answers the names of the people whose
assistant is working there, and show "Ada's assistant is working…" with no detail and no Stop. Someone
who cannot read the project gets the same 404 as for a conversation that does not exist.

## Changes, Undo and the owner's lane (F-027 A3 and A4, #403, #404)

The run's change tools go through `assistantChangeExecutor`
(`apps/server/src/agent-connection/assistant-changes.ts`): each call is applied, waiting, a suggestion or
refused, and recorded in `assistant_changes` in the same transaction (migration 0104).

- **Who decides.** A waiting change is the owner's alone: Apply, Apply all, Not now, Send and the move to Inbox
  answer everyone else with the same 404 as for a change that does not exist (another member, a workspace admin,
  a viewer, a guest, a stranger, an agent's bearer or a run token). Apply re-executes the saved call with every
  check under the server-owned `owner_approval` purpose: the source run must be live or normally completed (a
  stopped, failed or cancelled one supplies nothing); Pause blocks it and a resume does not apply anything by
  itself; Off, narrowing, a revoked grant or binding, Not now and expiry close the saved change for good. The seven
  days are never extended. **Apply all is one write-only allowance**: at most the owner's current per-request limit,
  never above the run's original one (20; 10 for a background run); the surplus stays waiting for the next Apply.
  The continuation purpose `owner_deferred_change` belongs to one exact edit, a Wiki page someone else was typing in;
  the executor refuses any other waiting change that tries to select it.
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
  viewer gets 403, a stranger 404). What was done is the run's message for everyone who can read the conversation
  (`GET /api/v1/conversations/:id/assistant-changes`: the owner sees all of their own rows, others only what was
  done); a waiting change, a suggestion or a refused Apply never leaves its owner. The restore is recorded as "Jonas
  undid Ada's assistant's change". Task fields come back where untouched since: title, outcome, status (with the
  blocker and who it waited for, when leaving Blocked), done-when, prerequisites and who a task waits for; a map's
  name; a page's text; a thought's text and position; created thoughts, links and tasks are removed, a created page
  moves to drafts. **Not undoable, because no domain can remove them today**: a created map, a recorded result, a
  proposed decision and a posted message. Their rows say what happened and offer no Undo.
- **The lane.** One working run and one waiting request per owner. `personal_runs.authority`
  (`owner_request|owner_schedule|owner_reaction`, migration 0108) and `background_label` ("Morning summary") say what
  started a run; A8 and A9 set the last two. The owner's own requests start before queued background runs, and a
  queued request carries `behind` (the working run's authority and label) so its line reads "Next: '…'" or
  "Finishing your Morning summary first. Yours starts next. · Stop the summary".

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
  project* (a viewer grant).
- **Working line.** Owner only, where the answer will appear: "Your assistant is reading this
  conversation…" with **Stop**; afterwards "Stopped. Nothing was posted." or the failure, with
  Retry where it makes sense. It follows the owner's progress events, and polls while the
  stream reconnects.
- **Answer.** An ordinary message from "<Owner>'s assistant" with a ✦ avatar and an
  *Assistant* tag, "asked by …", the request, the body and `[n]` citations that open exactly
  their source (a message in the conversation, a work item in Details, a map thought).
  Committed answers renumber the model's `[S<n>]` labels to `[1]…` in the order of `sources`.
  Provenance names the provider and model; no cost. The owner gets Retry (and Continue when
  truncated); others with write access get *Ask my assistant about this*.
- **Proposal.** "Proposal · not saved yet", fact, interpretation and the effect. Accept and
  Dismiss only for people with authority (write access; the work owner or a manager when it
  finishes owned work); others read "… drafted this. It waits for someone who can decide it."
  After a decision: "Recorded by … · drafted by …'s assistant" with *Open result*.
- **Settings** at `/settings/assistant` (account menu → *Your assistant*, and Details →
  *Connect your AI*): the disclosure (provider, model, payer, what leaves Flux, who sees
  answers, caps and the invoice caveat), per-run and daily caps, the assistant per workspace
  (create one there), the consent checkbox, then state, Pause/Resume, today's meter, cap edits
  (`expectedVersion`) and *Turn off and remove consent*. With the provider off or no key
  connection it says so and Turn on stays disabled.
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
  The agent's project grants, capped by the owner's own access, bound what a run
  may read.
- `personal_runs` stores the request, place, agent and connection snapshot
  (with the connection's `provider` and `model`, shown as the answer's provenance),
  status, reservation (`reserved_micros`), `cost_state`, observed usage and
  charge. It stores the committed answer only after the final recheck. A partial
  unique index enforces one run in flight per owner.
- `assistant_proposals` stores a drafted result (fact, interpretation, title,
  finding, evidence, optional work item it finishes), the decision and the
  recorded `result_id`.

The #52 `agent_proposals` table is not reused. It is fixed to the
user-operated Claude Code source, requires a pinned material version as its only
source, and has no accept. The assistant proposal keeps the same fact,
interpretation and proposal shape, and adds the accept path AC-7 needs.

## Money

Amounts are integer micro-dollars. A run reserves its largest possible cost at the
connection's price (F-020 PROV-3): 16 000 × the input price + 1 500 × the output
price per token, rounded up (32 000 × the input price for a model that can call
tools, #484). It is reserved when the run is created, in the same
transaction as the run row and the job, under the owner's enablement row lock.
The owner's per-run setting (`per_run_cents × 10 000`) is the ceiling that
reservation must fit: a connection whose largest request exceeds it cannot be
enabled (`PERSONAL_RUN_COST_OVER_LIMIT`) and is `unavailable` /
`run_cost_over_limit` afterwards; one without a price is `PERSONAL_RUN_PRICE_UNKNOWN`
/ `price_unknown`. Today's use is the charge of `observed` runs plus the
reservations of in-flight and `unknown` runs since the owner's local midnight.
`released` runs cost nothing. Usage is charged at the connection's price, or at the
provider-reported cost when the response carries one (OpenRouter). For Claude
Sonnet 5 at $2/M and $10/M the request without tools is 16 000 × 2 + 1 500 × 10 =
47 000 micros ($0.047) and the request with tools 32 000 × 2 + 1 500 × 10 = 79 000
micros ($0.079); the default ceiling is $0.08 (`PERSONAL_RUN_LIMITS.perRunCents`).

## HTTP API

Every route needs a session. None of them reads an owner, agent or connection
from the request.

| Route | Who | Result |
| --- | --- | --- |
| `GET /api/v1/personal-assistant` | the caller | Own state `not_enabled`, `ready`, `paused`, `capped` or `unavailable` (with `unavailableReason`), the enablement, today's use and the disclosure. |
| `POST /api/v1/personal-assistant` | the caller | Enable with `{ consentVersion, agentId, perRunCents?, dailyCapCents?, timeZone? }`: 201. It needs the caller's own agent (`agent.invoke`) and usable connection. |
| `PATCH /api/v1/personal-assistant` | the caller | Caps and time zone, with `If-Match` or `expectedVersion`. |
| `PUT /api/v1/personal-assistant/agents` | the caller | `{ agentId }`: the caller's assistant for that agent's workspace. |
| `POST …/pause`, `POST …/resume`, `DELETE /api/v1/personal-assistant` | the caller | Pause ends queued work at zero cost. Delete also removes the consent. |
| `POST /api/v1/conversations/:id/assistant-runs` | the caller | Invoke `{ clientRunId, kind, prompt, target?, continuesRunId? }`: 202 with the run; the same `clientRunId` returns it again (200) and never charges twice. |
| `GET /api/v1/assistant-runs`, `GET /api/v1/assistant-runs/:id` | the run's owner | Own runs with status and cost. Anyone else gets 404. |
| `POST /api/v1/assistant-runs/:id/stop` | the run's owner | Before dispatch: `stopped` and free. During dispatch: best-effort abort, the charge is kept and nothing is committed. |
| `POST /api/v1/assistant-runs/:id/retry` | the run's owner | `{ clientRunId }`: a new, separately capped run with the same request (202). |
| `GET /api/v1/conversations/:id/assistant-changes` | project readers | The run messages of the conversation: the owner's own rows in every state, everyone else's what was done (applied, approved, undone, skipped) with `undoable` true only for someone who may edit (F-027 A4). Non-readers get 404. |
| `GET /api/v1/conversations/:id/assistant-activity` | project readers | `{ working: [{ ownerId, ownerName }] }`: whose assistant is working there now, nothing more (F-027 AST-6). |
| `POST /api/v1/assistant-changes/:id/apply`, `…/not-now`, `…/send`; `POST /api/v1/assistant-runs/:id/changes/apply`, `…/not-now`, `…/inbox` | the owner only | Decide waiting changes (F-027 A3). Everyone else gets 404. Apply all is one allowance of at most the owner's limit (surplus stays waiting). |
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
| `GET /api/v1/conversations/:id/assistant-answers` | project readers | Committed answers with label, request, body, provenance (provider and model) and cited sources. No cost, cap, connection or hidden source. |
| `GET /api/v1/projects/:id/assistant-proposals`, `GET /api/v1/assistant-proposals/:id` | project readers | Proposals with "drafted by" and the decision. |
| `POST /api/v1/assistant-proposals/:id/accept`, `…/dismiss` | a person with authority | `If-Match` or `expectedVersion`. The caller needs project write access. For a result that finishes an owned work item, they must be its owner or a project manager. Accepting a result linked to a work item also contributes it to that task's conversation, authored by the accepting person with the exact result id (#154); the assistant and its owner never author it, and a rolled-back acceptance leaves no contribution. |

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

At commit, citations `[S<n>]` count only for supplied sources. A
`<proposal>{…}</proposal>` block becomes a proposal only when it is well formed.
It may finish only a supplied open work item. A `max_tokens` answer is committed as
`truncated` and never proposes. The commit records
`project.assistant_answer_committed.v1` (and `project.assistant_proposal_created.v1`)
for the project's audience.

## Tests

`app/tests/app/personal-runs.test.ts` covers #68 AC-1 to AC-7 with two or more
people, plus owner-only progress events (audience rows and live streams of the owner,
a project member and the workspace owner) and a failed preflight count. It sends HTTP
requests to the API container's production composition and drives dispatch in-process
with the fakes. `app/tests/app/personal-runs-core.test.ts` checks the pure output and cost
rules. `app/tests/app/personal-runs-anthropic.test.ts` checks the adapter against a local mock
HTTP server (request shape, key, retries off, abort, timeout, counting, usage, error
mapping, limits, environment isolation) and the composition guards. Run them through
`./scripts/check_application.sh`.

`app/tests/ui/test_personal_assistant.py` (through `./scripts/check_ui.sh`, with the
test-only switch) covers the UI with three people: not set up, consent and caps,
the manager grant, the working line only for the owner, the attributed answer and its
citations for peers and a viewer, Stop, a provider failure, a proposal accepted only by
the work's owner, paused, capped, and phone width. The production fail-closed states
(provider off, no key) are rendered there from a stubbed status response only.
Screenshots of that run (light theme, 1440×900 and 390×844) are in
[`docs/design/personal-ai/app/`](../design/personal-ai/app/); they show appearance, not
behaviour or accessibility.

## Not yet done

- The rest of #406/#484: AST-3.2's handoff, catalog and owner-Apply parity (they need A3/A4), the
  persisted owner mark and the account row's note for a model without tool calling, a "Limit reached"
  status and copy, the Responses API for the OpenAI models that need it, and the Gemini
  thought-signature field name (unverified against Google's pages).
- A8 and A9 start background runs; the lane, its ordering and its lines are in place and tested with seeded rows.
- #124's key custody, the real connection lookup and key resolver, the foreign key
  from `connection_id`, and the operator switch (see [Switching production on](#switching-production-on)).
- A provider pass against the real API (with a real key, by its owner), including billing on
  cancellation and lost responses.
- The "someone else's assistant" panel of the design. (Dropped from the plan, founder direction
  2026-10-16 on #68: the WebSocket commands, the map-thought *Ask* entry and the header status
  button.)
- Real-device (phone/tablet) and screen-reader checks of the UI.
- A sweep of runs a crashed worker left behind. Today the owner's next invoke
  ends their own in-flight runs untouched for 15 minutes: a queued or reading run
  at zero cost, a dispatching one as `provider_failed` with its reservation kept
  as `unknown`. The job itself expires after 5 minutes.
