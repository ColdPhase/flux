# Work items, decisions and results (issue #101)

**Later required amendment, 2026-09-30:** [F-016](../product/mcp-cowork.md)
adds separate local-agent execution/review records and disclosed GitHub rules
for the same work item, with manual correction suspending automation. Existing
work statuses, parking and human-only domain decision acceptance remain.
UI116-3 ([final design](../design/final/README.md#5-behaviour) rule P5) changes new-task notice/first-contribution flow
without rewriting historical threads. Implementation is tracked in the new
contract's delivery table; this notice is not runtime evidence.

Foundation 8.5/8.6 and the #44 product contract: conversation, task, decision and result keep
their own meaning and stable ids and are connected by many-to-many links. Creating work from a
message keeps the message where it is. Everything described here is visible exactly to the
principals with current read access to the project; there is no second audience.

## Objects

| Object | Fields | Rules |
| --- | --- | --- |
| Work item | title, outcome (may be empty), owner (person or #29 agent, or nobody), status `open` · `in_progress` · `blocked` · `done` ([four states](#statuses-waiting-and-what-came-of-it-868)), optional blocker, one thing it waits for and `dropped` and `cameOfIt` (only while blocked or done), optional `dueOn` ([below](#due-date-and-activity-488)), version | The owner must currently be able to read the project (`OWNER_WITHOUT_ACCESS`). Leaving `blocked` clears the blocker. Small tasks need only a title; no report is required. Explicitly saving a nonempty blocker also contributes it to the task conversation ([below](#contributions-to-the-task-conversation-154)). |
| Decision | title, rationale, status `proposed` · `accepted` · `superseded`, proposed by, decided by (a person), `supersedes` / `supersededBy`, version | People and agents with write access propose. Only a person with write access accepts (`DECISION_NEEDS_PERSON`); see [acceptance authority](#acceptance-authority-o-009-250). Only an accepted decision can be superseded (`SUPERSEDES_NOT_CURRENT`); accepting the replacement marks the earlier one `superseded` and keeps its title and rationale. The screens call a superseded decision "replaced". |
| Result | title, finding `positive` · `negative`, evidence | Immutable once recorded, so later thinking never rewrites it. `finishes: { id, expectedVersion }` names one of its linked work items, which becomes `done`: a negative result can finish an experiment. A stale version is `409 VERSION_CONFLICT` with the current work; Nothing is stored when finishing is refused. A result linked to work (`work`) also contributes to each task's conversation ([below](#contributions-to-the-task-conversation-154)). |
| Link | role, from (work/decision/result, or a [doc](docs-wiki.md)), to (message, thought, material version, work, decision, result, doc, project sketch), titles of both ends | Roles: `source` (created from / based on), `affects`, `about`, `related`, and `mentions` (the current text of a doc refers to it, #112). Every target must exist in the same project (`LINK_TARGET_NOT_FOUND`). Identical links are stored once. |

**No pivot (founder direction, Hubert, 2026-11-03; #871).** Accepting a decision that replaces an earlier one
only marks the earlier one `superseded`. Flux does not move, park or re-link any task because a decision changed; people
decide about the tasks themselves. The accept request has no `stillApplies` and no `park`: a client that still sends them is
ignored by the schema and changes nothing. A task has no parked state at all (#1039, migration 0035 drops the columns, the
`still_applies` link role and everything that read them). Two people accepting
competing replacements of the same decision at once: one wins, the other gets `409 SUPERSEDED_DECISION_CHANGED`.

## Acceptance authority (O-009, #250)

[O-009](../product/decision-authority.md) (proposed) records the rule this code enforces:

- **Who accepts.** One signed-in person whose current project level is contributor or manager.
  That covers owners and admins, members of the space and a guest with a contributor grant. The proposer may accept their own proposal.
- **Who is refused.** A person without access, removed from the space or gone gets `404`. An
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
| `POST /api/v1/work/:workId/waiting-done` | The person a blocked task waits for says they are done ([below](#statuses-waiting-and-what-came-of-it-868)). Needs `If-Match`; reading the space is enough. |
| `GET /api/v1/work/:workId/activity` | The task's history of status, owner, due date and title changes, newest first: `?limit=` 1-50 (30 when omitted) and `?before=` (the `nextBefore` of the page before). Read by exactly those who can read the task ([below](#due-date-and-activity-488)). |
| `GET/POST /api/v1/projects/:projectId/decisions`, `GET /api/v1/decisions/:id` | Propose with `sources`, `affects`, `supersedes`. |
| `POST /api/v1/decisions/:id/accept` | Needs `If-Match`; no body (`{ expectedVersion? }` is the same as the header). |
| `GET/POST /api/v1/projects/:projectId/results`, `GET /api/v1/results/:id` | `POST` takes an optional `clientCommandId` (UUID, #154): see below. |
| `POST /api/v1/projects/:projectId/links` | A `related` link between any two objects of the project. |
| `GET /api/v1/workspaces/:workspaceId/work/assigned` | The caller's unfinished work in every project the policy's `visibleFilter` lets them read. |

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

## Statuses, waiting and what came of it (#868)

**Four states.** `open` (To do), `in_progress` (Doing), `blocked` and `done`. "Not pursued" is `done` with `dropped: true`; there is
no fifth state, and no existing data to convert (migration 0035, F-038). `dropped` and the one-line `cameOfIt` live only while the
task is done: a command that sets them on another state is `400`, and leaving Done clears both (what was written in the discussion
stays). `cameOfIt` is one line of at most 500 characters (line breaks become spaces); a nonempty line is also one authored
contribution to the task's discussion, `contribution.kind` `came_of_it`, written like a saved blocker (the same command identity,
never twice for a retry, and not at all for an Undo's `restore`). Five agent messages in a row (C-51) refuse a message, never the Done that carries the line: the line stays on the task and only the discussion message is not written. It is sealed in an encrypted space like the blocker.

**One thing to wait for.** A blocked task waits for one person (`waitingFor`, #550), one decision (`waitingOn: { kind: 'decision', id }`,
still proposed) or one other task of the space (`waitingOn: { kind: 'task', id }`, not done), never two (`400`); naming one clears the
other, and leaving Blocked clears all. Refused with `422`: `WAITING_ON_NOT_FOUND` (another space), `WAITING_ON_RESOLVED` (the decision is
decided or the task done), `WAITING_ON_ITSELF`, `WAITING_ON_CYCLE` (that task waits for this one, however far round). The reads show
`waitingOn: { kind, id, title, number? }`. The blocked line of the stream reads "waiting for #7" or "waiting for the decision …".
Prerequisites (#152) are a separate plan fact and stay as they were.

**Resuming by itself.** When what a blocked task waits for is resolved, the task goes to Doing in the same transaction (To do
when a prerequisite is still open, since Doing needs every one done):

| It waits for | Resolved when | The line says |
| --- | --- | --- |
| a decision | the decision is accepted (`POST /decisions/:id/accept`) | the decision was accepted |
| a task | that task becomes done, by `PATCH`, by a result that finishes it, or dropped | #7 is done / #7 was dropped |
| a person | they say they are done: `POST /work/:id/waiting-done` (the Inbox item's Done, or the panel's) | Jonas is done |

A task that is Blocked when its agent's run ends is left as it is (the report says "Blocked: #4 …" in the agent's chat), in both "Do it and tell me" and "Ask me first": the drain does not mark it Done or hand it back, so the tasks that wait for it do not resume on a false Done. A person's Resolve of such a task does not start the agent again; only a resolved wait does.

A dropped task is `done`, so it satisfies the prerequisites of the tasks that need it. A task that something waits for is in use: naming it marks it used, so its creation cannot be undone (`task_used`) and the Undo of the agent run that made it is refused; the Undo of a run that proposed a decision a task waits for is refused the same way ("Used since"). A task whose creation was undone is read-only history: it waits for nothing, so it never holds the decision or task it named, and it is not resumed. The cycle check follows the chain to its end.

Each resumed task keeps an activity entry marked `automation: 'wait_resolved'`, a `task.resumed` line in the stream ("#4 can
continue: the decision was accepted", `reason` is the phrase), and tells its owner once: a person gets a notification of that
sentence (`project.work_updated.v1` with `resumedFor`, `reason` and `taskId`), an agent that holds it picks it up again as when it was
given the task (an `assigned` row in `agent_task_events`, #856). The tasks are found under the project graph lock and locked with the
rest of the command's fence, then read again: one that moved on meanwhile is left alone. A task that a pull request's rule moves to
Done (#74) does not resume waiting tasks yet.

## Due date and activity (#488)

**Due date.** `dueOn` is a calendar day, `YYYY-MM-DD`, with no time zone and no time, so it is the same day for everyone.
It must be a real date from 1970 to 9999 (`2026-02-31` is `400 INVALID_INPUT`); `null` clears it. Create takes it and
`PATCH` changes it like any other field: a versioned change that honours `If-Match` (409 `VERSION_CONFLICT`) and
`clientCommandId`, needs access to the space and leaves the task's other fields alone. The list rows, the
work detail and the task carry it. MCP does not take or show it yet. It is stored in `project_work_items.due_on`
(migration 0112).

**Activity.** Every successful change of **status, owner, due date or title** keeps one row of
`project_task_activity` per field that really changed, made by the principal that acted (a person or an agent, whichever
path: the API, MCP, the assistant, a result that finishes a task, or a task rule of a linked pull request, which acts for
the rule's author and is marked `automation: 'github_rule'`), at the time of the change. The row is written by
`WorkRepository.updateWork`, the one function every change of a task ends in, in the transaction of the change, so a replay
of the same `clientCommandId` or `Idempotency-Key`, a refused change and a change that leaves the fields as they were
(its version still moves) keep nothing. Creation is not an entry (readers derive it from `createdBy`/`createdAt`), and
neither are an outcome, criteria, prerequisites, a blocker edit alone or parking; tasks from before 0112 have no entries.
`GET /api/v1/work/:workId/activity` returns `TaskActivityPage` (`{ workId, items, nextBefore }`), newest first with a
stable keyset on (time, id). `status` entries say the reason and the person waited for when the task became blocked (an
Undo that restores them is a status change too); `owner` entries name both owners, agents with the owner they show to
this project's readers, as the task detail names them. Names resolve as for the task detail; a person who left shows as a
former member. The rows go with their task and so with the project. They are separate from the project conversation's
blocked/unblocked lines (`project_task_updates`, #550), which are unchanged.

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

`app/tests/app/work.test.ts` (API, two people, outsider and an agent principal through the
use cases), `app/tests/app/decision-authority.test.ts` (#250: the O-009 role matrix, the MCP agent path
and the database invariant), the "#250 AC-3" case in `app/tests/app/personal-runs.test.ts` (the assistant
path), `app/tests/ui/test_decision_authority.py` (#250: a contributor accepts; the viewer's "Who decides" note went with the viewer role, #903)
and `app/tests/ui/test_work_decisions.py` (Playwright: create from a message, keyboard
propose/accept, negative result by the second person, a replacing decision, phone) and
`app/tests/ui/test_decision_surfaces.py` (#692, #693: the proposal form keeps the panel's rhythm of
28 px between sections and 8 px inside one; the proposal's title and Accept block paint no surface of
their own and start on one left edge, at 390 and 1440, light and dark). Screenshots:
`docs/design/work-decisions/` (the former viewer's **Who decides** note, removed with the viewer role in #903: `decision-desktop-1440-viewer.png`,
`decision-phone-390-viewer.png`).
