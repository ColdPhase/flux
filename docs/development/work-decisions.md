# Work items, decisions and results (issue #101)

**Later required amendment, 2026-09-30:** [F-016](../product/mcp-cowork.md)
adds separate local-agent execution/review records and disclosed GitHub rules
for the same work item, with manual correction suspending automation. Existing
work statuses, parking and human-only domain decision acceptance remain.
[UI116-3](../design/studio-v11.6.md) changes new-task notice/first-contribution flow
without rewriting historical threads. Implementation is tracked in the new
contract's delivery table; this notice is not runtime evidence.

Foundation 8.5/8.6 and the #44 product contract: conversation, task, decision and result keep
their own meaning and stable ids and are connected by many-to-many links. Creating work from a
message keeps the message where it is. Everything described here is visible exactly to the
principals with current read access to the project; there is no second audience.

## Objects

| Object | Fields | Rules |
| --- | --- | --- |
| Work item | title, outcome (may be empty), owner (person or #29 agent, or nobody), status `open` · `in_progress` · `blocked` · `done` · `not_pursued`, optional blocker (only while blocked), `parked`, version | The owner must currently be able to read the project (`OWNER_WITHOUT_ACCESS`). Leaving `blocked` clears the blocker. Small tasks need only a title; no report is required. Explicitly saving a nonempty blocker also contributes it to the task conversation ([below](#contributions-to-the-task-conversation-154)). |
| Decision | title, rationale, status `proposed` · `accepted` · `superseded`, proposed by, decided by (a person), `supersedes` / `supersededBy`, version | People and agents with write access propose. Only a person with write access accepts (`DECISION_NEEDS_PERSON`); see [acceptance authority](#acceptance-authority-o-009-250). Only an accepted decision can be superseded (`SUPERSEDES_NOT_CURRENT`); accepting the replacement marks the earlier one `superseded` and keeps its title and rationale. |
| Result | title, finding `positive` · `negative`, evidence | Immutable once recorded, so later thinking never rewrites it. `finishes: { id, expectedVersion }` names one of its linked work items, which becomes `done`: a negative result can finish an experiment. A stale version is `409 VERSION_CONFLICT` with the current work; parked or `not_pursued` work is `409 WORK_NOT_FINISHABLE` (bring parked work back first). Nothing is stored when finishing is refused. A result linked to work (`work`) also contributes to each task's conversation ([below](#contributions-to-the-task-conversation-154)). |
| Link | role, from (work/decision/result, or a [doc](docs-wiki.md)), to (message, thought, material version, work, decision, result, doc, project sketch), titles of both ends | Roles: `source` (created from / based on), `affects`, `still_applies`, `about`, `related`, and `mentions` (the current text of a doc refers to it, #112). Every target must exist in the same project (`LINK_TARGET_NOT_FOUND`). Identical links are stored once. |

**Pivot.** Accepting a decision that supersedes an earlier rule is a pivot. The request may name
`stillApplies` (linked to the new decision as `still_applies`) and `park` work. Parked work keeps
its status and records the decision that parked it, so it is never called done (a database check forbids finished-and-parked; finishing parked work by PATCH takes it out of the parked list); `PATCH
{ parked: false }` brings it back. Finished work cannot be parked. Two people accepting competing
replacements of the same rule at once: one wins, the other gets `409 SUPERSEDED_DECISION_CHANGED`.

## Acceptance authority (O-009, #250)

[O-009](../product/decision-authority.md) (proposed) records the rule this code enforces:

- **Who accepts.** One signed-in person whose current project level is contributor or manager.
  That covers owners and admins unless they are denied, members with project write and a guest with a
  contributor grant. The proposer may accept their own proposal.
- **Who is refused.** A viewer gets `403`. A person without access, denied or gone gets `404`. An
  agent gets `403 DECISION_NEEDS_PERSON`, whoever owns it and whatever its grant.
- **Paths that never accept.** The assistant in Flux has no decision path: its proposals are results
  only. MCP has no accepting tool and no `decision.*` operation other than `decision.propose`, so a
  standing grant cannot name acceptance.
- **Superseding.** It happens only when an authorized person accepts the replacement.
- **No silent change.** A refusal changes nothing: same status and version, no
  `project.decision_accepted.v1` event. The `0008_work.sql` `CHECK` and the `auth_users` foreign key
  refuse an accepted row without a person.
- **Delegation.** There is no delegated acceptance in v0.1.

In Details, a person without write access sees **Who decides** in place of the Accept form.

## API

| Method and path | Notes |
| --- | --- |
| `GET/POST /api/v1/projects/:projectId/work` | List (page `limit`/`offset`) or create. |
| `GET/PATCH /api/v1/work/:workId` | `PATCH` needs `If-Match: "<version>"` (or `expectedVersion`): 428 without, 409 `VERSION_CONFLICT` with the current object when stale. Optional `clientCommandId` (UUID, #154): see below. |
| `GET/POST /api/v1/projects/:projectId/decisions`, `GET /api/v1/decisions/:id` | Propose with `sources`, `affects`, `supersedes`. |
| `POST /api/v1/decisions/:id/accept` | Needs `If-Match`; body `{ stillApplies?, park? }`. |
| `GET/POST /api/v1/projects/:projectId/results`, `GET /api/v1/results/:id` | `POST` takes an optional `clientCommandId` (UUID, #154): see below. |
| `POST /api/v1/projects/:projectId/links` | A `related` link between any two objects of the project. |
| `GET /api/v1/workspaces/:workspaceId/work/assigned` | The caller's unfinished, unparked work in every project the policy's `visibleFilter` lets them read. |

Every POST/PATCH accepts `Idempotency-Key` (the shared runner in `app/apps/server/src/http/commands.ts`,
also introduced by #100); a replay re-checks current project read access. Responses with a version
carry `ETag`. An object in a project the caller cannot see is `404 <TYPE>_NOT_FOUND`, the same as a
missing one.

## Contributions to the task conversation (#154)

Two commands also contribute to the task's canonical conversation, in the same transaction, through the
mandatory `WorkPorts.contributions` hook (there is no work adapter without it; see
[task discussions](task-discussions.md#explicit-native-effects-on-the-canonical-thread)):

- **Saving a blocker.** `PATCH` with a nonempty `blocker` (status `blocked`) is one authored contribution whose
  body is exactly the saved, trimmed text. Clearing the blocker (`null`, empty or whitespace) and changing only
  status, owner, title or outcome contribute nothing. Creation with a blocker keeps only its creation notice.
- **Publishing a result.** One canonical result is created; every task in `work` receives one contribution by
  the creating principal whose body is the result title and whose `contribution` is
  `{ "kind": "result", "resultId": "<that result>" }`. The finding, evidence and sources are read from the
  result through `GET /api/v1/results/:id`. A result with no linked task creates no task thread.

`clientCommandId` makes either command durably retryable. The receipt is scoped to the real actor, project,
operation and UUID. An exact retry rechecks current project write access, the produced state (a changed task is
`409 COMMAND_POSTSTATE_STALE`, never overwritten and never contributed twice) and the stored contributions, then
returns the original outcome; a changed intent is `409 IDEMPOTENCY_CONFLICT`. Without it nothing deduplicates a
repeated result, and the `If-Match` version fences a stale identical blocker save. Browsers always send one.
The receipt is separate from the 24-hour `Idempotency-Key` response cache and from the #152 connection-command ledger.

## Events

Each committed change records exactly one project event in its transaction (a contribution adds its own
`project.conversation_created.v1` or `project.message_sent.v1`, all in the one final batch):
`project.work_created.v1`, `project.work_updated.v1`, `project.decision_proposed.v1`,
`project.decision_accepted.v1`, `project.result_recorded.v1` or `project.link_created.v1`. The
`object_id` is the project, `data` carries only the object id, so the stream reaches current
project readers and the client refetches. Idempotent replays and failed changes record none.

## Structure

- `app/packages/contracts/src/work.ts`: wire types and paths.
- `app/packages/core/src/work/`: ports (`WorkAccess`, `WorkRepository`, `WorkEventLog`,
  `WorkUnitOfWork`), validation and use cases. No Drizzle or `@flux/db` import.
- `app/packages/db/src/repositories/work.ts` and migration `0008_work.sql`: rows only, no decisions.
- `app/apps/server/src/work/`: adapters (`evaluateProject`/`authorize`/`visibleFilter`, `recordEvent`)
  and routes. No architecture allowlist entries were added.
- `app/apps/web/src/work/`: loads every page of work, decisions and results (100 per request until `total`), so the state line, Tasks and inline objects are complete; the Tasks tab (`/projects/:id/tasks`), the state line, message actions
  (Task, Decision, Result, plus Details; #189), inline objects under their source message and
  the Details panel views and forms.

## Not yet

Sketch thoughts as link sources and sources of new work depend on #69/#100 merging; the link
table accepts a new target type through a small migration. Handoffs (a follow-up slice) and agent
execution (#52/#68) are out of scope. The return view (8.8) reads these events; see
[return-view.md](return-view.md). The UI refreshes by route
revalidation and polling and does not subscribe to the stream yet.

## Tests

`app/tests/app/work.test.ts` (API, two people, viewer, outsider and an agent principal through the
use cases), `app/tests/app/decision-authority.test.ts` (#250: the O-009 role matrix, the MCP agent path
and the database invariant), the "#250 AC-3" case in `app/tests/app/personal-runs.test.ts` (the assistant
path), `app/tests/ui/test_decision_authority.py` (#250: a viewer sees who decides, a contributor accepts)
and `app/tests/ui/test_work_decisions.py` (Playwright: create from a message, keyboard
propose/accept, negative result by the second person, pivot with parking, phone). Screenshots:
`docs/design/work-decisions/`.
