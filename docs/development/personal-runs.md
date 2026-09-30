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
fakes in `tests/app/support/personal-runs.ts` (API suite) and, in the browser
suite, with the real adapter against a mock provider server (see
[Test-only switch](#test-only-switch)). No test is a provider, billing or
compatibility pass.

## Layout

| Path | Role |
| --- | --- |
| `packages/contracts/src/personal-runs.ts` | Paths, wire types, the consent version `o-008-2026-09-28` and the O-008 limits (`PERSONAL_RUN_LIMITS`). |
| `packages/core/src/personal-runs/` | Ports, input and output rules, use cases (`service.ts`), the worker processor (`processor.ts`) and assistant proposals (`proposals.ts`). |
| `packages/core/src/access/personal-run-access.ts` | The access policy as the `PersonalRunAccess` port. |
| `packages/core/src/access/policy.ts` | New agent action `agent.invoke`: only the person who owns the unrevoked agent. A workspace role never grants it. |
| `packages/db/migrations/0024_personal_runs.sql`, `packages/db/src/repositories/personal-runs.ts` | Tables and rows. |
| `apps/server/src/personal-runs/` | Routes and the per-transaction composition. The server only queues runs. |
| `apps/worker/src/personal-runs/` | The `personal-run.dispatch.v1` handler and its composition (`composition.ts`). The queue never retries a job (`PERSONAL_RUN_QUEUE`). |
| `packages/core/src/personal-runs/progress.ts` | Owner-only progress events (`assistant_run.changed.v1`). |
| `packages/core/src/access/policy.ts` (`evaluateAssistantRun`) | The `assistant_run` object: its only reader is the run's owner. |
| `packages/agent-runtime/src/anthropic.ts` | The Anthropic adapter behind `PersonalCompute` (`@anthropic-ai/sdk` 0.129.0, pinned). |
| `apps/web/src/assistant/` | The UI (AC-8): ask mode, working line, answers, proposals, settings. |
| `packages/core/src/personal-runs/test-fixture.ts`, `tests/ui/anthropic_mock.py` | TEST ONLY: fixture key connections and the mock provider of the browser suite. |

## Ports

- `PersonalConnectionLookup.resolve(ownerUserId)` returns the owner's own
  connection: its id, status, payer and an opaque `keyRef`. There is no lookup by
  connection id, and core never sees key material. Production composes
  `noPersonalConnections` until #124 lands.
- `PersonalCompute` has `enabled` (the instance operator's switch, O-008 §6),
  `countInputTokens` (preflight) and `dispatch(request, signal)`. A dispatch is one
  bounded Messages request with the pinned model, `max_tokens` 1500, low effort
  and no tools. The result is either `completed` with text, `stopReason` and
  usage, or `failed` with `billed: 'none' | 'unknown'`. Production composes
  `unavailablePersonalCompute`; the Anthropic adapter is described below.
- `PersonalRunUnitOfWork` bundles, in one transaction, the access port, the rows,
  the queue (the job is sent in the same transaction) and the event log.
  `ProposalUnitOfWork` adds the #101 work use case that records an accepted result.

**Price and model recheck (O-008).** Rechecked on 2026-09-30 against the Anthropic
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing): Claude Sonnet 5
is listed, not retired, at $2/M input and $10/M output, which the page now calls the
standard price (the scheduled rise to $3/$15 on 2026-09-01 "will not occur").
`PERSONAL_RUN_LIMITS.price.checkedOn` is `2026-09-30`. Check again when production
dispatch is switched on.

## Anthropic adapter

`anthropicPersonalCompute({ enabled, resolveKey, baseURL?, timeoutMs? })` in
`@flux/agent-runtime` implements `PersonalCompute` with the official SDK:

- one client per request, with the owner's key from `resolveKey(keyRef)`, an explicit
  `baseURL` (so `ANTHROPIC_BASE_URL` in the environment never redirects a key) and
  `maxRetries: 0`;
- `messages.create({ model, max_tokens, system, messages: [user input], output_config: { effort: 'low' } })`
  with no tools, and the `AbortSignal` of the owner's Stop;
- `messages.countTokens` with the same model, system and input for the preflight;
- a request outside the O-008 limits (another model, `max_tokens` above 1500, another
  effort) is refused before a key is resolved;
- usage: `input_tokens` plus cache tokens counted conservatively (reads as full input,
  5-minute writes ×1.25), and `output_tokens`. Core charges them at `PERSONAL_RUN_LIMITS.price`.
- failures: only a request that was never sent (no usable key; the O-008 limits refuse before a
  key is resolved) is `billed: 'none'`. Every failure after the request reached the provider —
  429 `rate_limited`, 529 `overloaded`, other 4xx and 5xx `provider_error`, timeouts, lost
  connections and aborts — is `billed: 'unknown'` and keeps the reservation counted: the
  provider's error and pricing references (checked 2026-09-30) define these errors but promise
  no billing outcome. Token counting is free per the provider's documentation. Retry is a new
  capped run. A failed preflight count ends the run as `provider_failed` at
  zero cost (nothing was dispatched).

## Switching production on

Production stays off until all of these exist, each reviewed on its own:

1. #124's owner key custody, and a `PersonalConnectionLookup` over it that returns only
   the caller's current active connection, plus the foreign key from `connection_id`;
2. a worker `PersonalKeyResolver` that decrypts only that connection's key for one dispatch;
3. an operator switch (for example `FLUX_PERSONAL_RUNS_PROVIDER=anthropic`) that composes
   `providerEnabled: true` in the API and `anthropicPersonalCompute({ enabled: true, resolveKey })`
   in the worker, next to the real lookup, in `personalRunServerComposition` and
   `personalRunWorkerComposition`;
4. a fresh price and model check, and an independently verified provider pass.

## Test-only switch

`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`, accepted by the API and the worker only together
with `FLUX_TEST_FAILURE_INJECTION=true` (any other value refuses to start), composes
`testFixturePersonalConnections` (every person has one stable fixture connection) and turns
the switch on. The worker then uses the **real** adapter with `baseURL` =
`FLUX_TEST_ANTHROPIC_URL` (a plain `http://host:port` origin) and a fixed non-secret fixture
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
rows and its stream delivery are the owner's alone. Nobody else learns that a run exists
until `project.assistant_answer_committed.v1` reaches the conversation's audience. The event
carries identifiers and the status only; the owner's client refetches `GET /api/v1/assistant-runs/:id`.

## WebSocket commands

Not implemented. `GET /api/v1/stream` is server-to-client only: the connection ignores every
client frame, and the API test pins that an `assistant.run` or `assistant.stop` frame does
nothing. The UI therefore invokes and stops through the HTTP API, which resolves the owner
from the session. A command channel on the stream (session revalidation per command,
replies, rate limits) is its own change.

## UI (AC-8)

`apps/web/src/assistant/`, on the existing conversation, Details and settings patterns and
tokens:

- **Ask mode.** A ✦ *Ask my assistant* button in the composer, or `/ai <prompt>` at the start
  of the box, shows "Your assistant ×" and one line: who sees the answer and "paid by you, up
  to $0.06" — or, calmly, why not (not set up → *Connect your AI*; paused → *Resume*; capped →
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
  `connection_id` is a nullable uuid **without a foreign key**. It will reference
  #124's connection table when that table lands. Until then, every step compares
  it with the connection the lookup returns. A replaced key shows as
  `connection_changed` and needs a new consent.
- `personal_run_agents` maps each workspace to the owner's assistant agent in it.
  The agent's project grants, capped by the owner's own access, bound what a run
  may read.
- `personal_runs` stores the request, place, agent and connection snapshot,
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

Amounts are integer micro-dollars. The ceiling (`per_run_cents × 10 000`) is
reserved when the run is created, in the same transaction as the run row and the
job, under the owner's enablement row lock. Today's use is the charge of
`observed` runs plus the reservations of in-flight and `unknown` runs since the
owner's local midnight. `released` runs cost nothing. Usage is charged at the
O-008 rate. The nominal maximum is 16 000 × 2 + 1 500 × 10 = 47 000 micros
($0.047), below the default $0.06 reservation.

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
| `GET /api/v1/conversations/:id/assistant-answers` | project readers | Committed answers with label, request, body, provenance (provider and model) and cited sources. No cost, cap, connection or hidden source. |
| `GET /api/v1/projects/:id/assistant-proposals`, `GET /api/v1/assistant-proposals/:id` | project readers | Proposals with "drafted by" and the decision. |
| `POST /api/v1/assistant-proposals/:id/accept`, `…/dismiss` | a person with authority | `If-Match` or `expectedVersion`. The caller needs project write access. For a result that finishes an owned work item, they must be its owner or a project manager. |

The invoke checks run in this order. A body that names another `ownerId`,
`agentId` or `connectionId` gets `403 PERSONAL_RUN_NOT_OWNER`. A conversation the
caller cannot read gets 404. Because the answer is posted into the conversation,
the caller needs project write access there, as for a message (403 otherwise). Then come the idempotent replay, the caller's own
continued run (404 otherwise) and the target thought. After that the caller's own
enablement is checked: `409 PERSONAL_RUN_NOT_ENABLED` or `409 PERSONAL_RUN_PAUSED`.
Then the provider and connection (`503 PERSONAL_RUN_UNAVAILABLE` with `reason`),
the workspace agent (`409 PERSONAL_RUN_NO_AGENT`), the agent's project access
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

It never reads DMs, drafts, private sketches or other projects. Preflight counting
drops the oldest messages until the input fits 16 000 tokens, or ends the run as
`input_too_large`.

At commit, citations `[S<n>]` count only for supplied sources. A
`<proposal>{…}</proposal>` block becomes a proposal only when it is well formed.
It may finish only a supplied open work item. A `max_tokens` answer is committed as
`truncated` and never proposes. The commit records
`project.assistant_answer_committed.v1` (and `project.assistant_proposal_created.v1`)
for the project's audience.

## Tests

`tests/app/personal-runs.test.ts` covers #68 AC-1 to AC-7 with two or more
people, plus owner-only progress events (audience rows and live streams of the owner,
a project member and the workspace owner) and a failed preflight count. It sends HTTP
requests to the API container's production composition and drives dispatch in-process
with the fakes. `tests/app/personal-runs-core.test.ts` checks the pure output and cost
rules. `tests/app/personal-runs-anthropic.test.ts` checks the adapter against a local mock
HTTP server (request shape, key, retries off, abort, timeout, counting, usage, error
mapping, limits, environment isolation) and the composition guards. Run them through
`./scripts/check_application.sh`.

`tests/ui/test_personal_assistant.py` (through `./scripts/check_ui.sh`, with the
test-only switch) covers the UI with three people: not set up, consent and caps,
the manager grant, the working line only for the owner, the attributed answer and its
citations for peers and a viewer, Stop, a provider failure, a proposal accepted only by
the work's owner, paused, capped, and phone width. The production fail-closed states
(provider off, no key) are rendered there from a stubbed status response only.
Screenshots of that run (light theme, 1440×900 and 390×844) are in
[`docs/design/personal-ai/app/`](../design/personal-ai/app/); they show appearance, not
behaviour or accessibility.

## Not yet done

- #124's key custody, the real connection lookup and key resolver, the foreign key
  from `connection_id`, and the operator switch (see [Switching production on](#switching-production-on)).
- A provider pass against the real API (with a real key, by its owner), including billing on
  cancellation and lost responses.
- The WebSocket commands `assistant.run` and `assistant.stop` (the stream has no client
  command channel).
- Done actions with undo, such as adding a map thought, and *Ask my assistant* on a map
  thought (`map_thought` runs exist in the API; no UI entry yet).
- The header ✦ status button and the "someone else's assistant" panel of the design.
- Real-device (phone/tablet) and screen-reader checks of the UI.
- A sweep of runs a crashed worker left behind. Today the owner's next invoke
  ends their own in-flight runs untouched for 15 minutes: a queued or reading run
  at zero cost, a dispatching one as `provider_failed` with its reservation kept
  as `unknown`. The job itself expires after 5 minutes.
- `draftedBy` on the result object itself. Today the accepted proposal holds
  `resultId` and the "drafted by" attribution.
