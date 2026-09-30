# Personal assistant runs (#68)

This is the implementation contract of the first #68 slice, under the accepted
decision [O-008](../product/personal-runs-compute.md) and the
[interaction design](../design/personal-ai/README.md). A person enables their own
assistant, invokes it in a project conversation, and gets an answer that the
conversation's audience reads as "Jo's assistant · asked by Jo". A consequential
change becomes an assistant proposal. Only a person with authority over its target
can accept it.

**What this slice does not do yet.** It has no real provider adapter, no key
storage and no UI. The owner's key connection belongs to
[#124](https://github.com/ColdPhase/flux/pull/124). Until that and the Anthropic
adapter land, production has no usable connection and the provider is switched
off. So enabling fails with `PERSONAL_RUN_CONNECTION_REQUIRED`, every invocation
fails with `503 PERSONAL_RUN_UNAVAILABLE`, and the worker ends any queued run as
`unavailable` at zero cost. Everything that runs past dispatch is tested with the
test-only fakes in `tests/app/support/personal-runs.ts`. No test is a provider,
billing or compatibility pass.

## Layout

| Path | Role |
| --- | --- |
| `packages/contracts/src/personal-runs.ts` | Paths, wire types, the consent version `o-008-2026-09-28` and the O-008 limits (`PERSONAL_RUN_LIMITS`). |
| `packages/core/src/personal-runs/` | Ports, input and output rules, use cases (`service.ts`), the worker processor (`processor.ts`) and assistant proposals (`proposals.ts`). |
| `packages/core/src/access/personal-run-access.ts` | The access policy as the `PersonalRunAccess` port. |
| `packages/core/src/access/policy.ts` | New agent action `agent.invoke`: only the person who owns the unrevoked agent. A workspace role never grants it. |
| `packages/db/migrations/0021_personal_runs.sql`, `packages/db/src/repositories/personal-runs.ts` | Tables and rows. |
| `apps/server/src/personal-runs/` | Routes and the per-transaction composition. The server only queues runs. |
| `apps/worker/src/personal-runs/` | The `personal-run.dispatch.v1` handler. The queue never retries a job (`PERSONAL_RUN_QUEUE`). |

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
  `unavailablePersonalCompute`.
- `PersonalRunUnitOfWork` bundles, in one transaction, the access port, the rows,
  the queue (the job is sent in the same transaction) and the event log.
  `ProposalUnitOfWork` adds the #101 work use case that records an accepted result.

**TODO for the next slice (O-008 "recheck price/model before dispatch").** Before
the real adapter sets `enabled`, check the `claude-sonnet-5` model pin and the
$2/M input and $10/M output prices again. Update `PERSONAL_RUN_LIMITS.price` and
its `checkedOn` date, and record the evidence in the decision.

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
before dispatch and inside the commit transaction:

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
people. It sends HTTP requests to the API container's production composition and
drives dispatch in-process with the fakes. `tests/app/personal-runs-core.test.ts`
checks the pure output and cost rules. Run both through
`./scripts/check_application.sh`.

## Not yet done

- The real Anthropic adapter, behind the `agent-runtime` port. It needs SDK retries
  off, AbortSignal cancellation, token counting and the price/model recheck.
- #124's key custody and the foreign key from `connection_id`.
- The WebSocket commands `assistant.run` and `assistant.stop`. The stream still
  ignores client messages, and a test pins that.
- Owner-only progress events.
- Done actions with undo, such as adding a map thought.
- UI (AC-8).
- A sweep of runs a crashed worker left behind. Today the owner's next invoke
  ends their own in-flight runs untouched for 15 minutes: a queued or reading run
  at zero cost, a dispatching one as `provider_failed` with its reservation kept
  as `unknown`. The job itself expires after 5 minutes.
- `draftedBy` on the result object itself. Today the accepted proposal holds
  `resultId` and the "drafted by" attribution.
