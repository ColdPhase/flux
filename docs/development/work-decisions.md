# Work items, decisions and results (issue #101)

Foundation 8.5/8.6 and the #44 product contract: conversation, task, decision and result keep
their own meaning and stable ids and are connected by many-to-many links. Creating work from a
message keeps the message where it is. Everything described here is visible exactly to the
principals with current read access to the project; there is no second audience.

## Objects

| Object | Fields | Rules |
| --- | --- | --- |
| Work item | title, outcome (may be empty), owner (person or #29 agent, or nobody), status `open` · `in_progress` · `blocked` · `done` · `not_pursued`, optional blocker (only while blocked), `parked`, version | The owner must currently be able to read the project (`OWNER_WITHOUT_ACCESS`). Leaving `blocked` clears the blocker. Small tasks need only a title; no report is required. |
| Decision | title, rationale, status `proposed` · `accepted` · `superseded`, proposed by, decided by (a person), `supersedes` / `supersededBy`, version | People and agents with write access propose. Only a person with write access accepts (`DECISION_NEEDS_PERSON`). Only an accepted decision can be superseded (`SUPERSEDES_NOT_CURRENT`); accepting the replacement marks the earlier one `superseded` and keeps its title and rationale. |
| Result | title, finding `positive` · `negative`, evidence | Immutable once recorded, so later thinking never rewrites it. `finishes: { id, expectedVersion }` names one of its linked work items, which becomes `done`: a negative result can finish an experiment. A stale version is `409 VERSION_CONFLICT` with the current work; parked or `not_pursued` work is `409 WORK_NOT_FINISHABLE` (bring parked work back first). Nothing is stored when finishing is refused. |
| Link | role, from (work/decision/result), to (message, material version, work, decision, result), titles of both ends | Roles: `source` (created from / based on), `affects`, `still_applies`, `about`, `related`. Every target must exist in the same project (`LINK_TARGET_NOT_FOUND`). Identical links are stored once. |

**Pivot.** Accepting a decision that supersedes an earlier rule is a pivot. The request may name
`stillApplies` (linked to the new decision as `still_applies`) and `park` work. Parked work keeps
its status and records the decision that parked it, so it is never called done (a database check forbids finished-and-parked; finishing parked work by PATCH takes it out of the parked list); `PATCH
{ parked: false }` brings it back. Finished work cannot be parked. Two people accepting competing
replacements of the same rule at once: one wins, the other gets `409 SUPERSEDED_DECISION_CHANGED`.

## API

| Method and path | Notes |
| --- | --- |
| `GET/POST /api/v1/projects/:projectId/work` | List (page `limit`/`offset`) or create. |
| `GET/PATCH /api/v1/work/:workId` | `PATCH` needs `If-Match: "<version>"` (or `expectedVersion`): 428 without, 409 `VERSION_CONFLICT` with the current object when stale. |
| `GET/POST /api/v1/projects/:projectId/decisions`, `GET /api/v1/decisions/:id` | Propose with `sources`, `affects`, `supersedes`. |
| `POST /api/v1/decisions/:id/accept` | Needs `If-Match`; body `{ stillApplies?, park? }`. |
| `GET/POST /api/v1/projects/:projectId/results`, `GET /api/v1/results/:id` | |
| `POST /api/v1/projects/:projectId/links` | A `related` link between any two objects of the project. |
| `GET /api/v1/workspaces/:workspaceId/work/assigned` | The caller's unfinished, unparked work in every project the policy's `visibleFilter` lets them read. |

Every POST/PATCH accepts `Idempotency-Key` (the shared runner in `apps/server/src/http/commands.ts`,
also introduced by #100); a replay re-checks current project read access. Responses with a version
carry `ETag`. An object in a project the caller cannot see is `404 <TYPE>_NOT_FOUND`, the same as a
missing one.

## Events

Each committed change records exactly one project event in its transaction:
`project.work_created.v1`, `project.work_updated.v1`, `project.decision_proposed.v1`,
`project.decision_accepted.v1`, `project.result_recorded.v1` or `project.link_created.v1`. The
`object_id` is the project, `data` carries only the object id, so the stream reaches current
project readers and the client refetches. Idempotent replays and failed changes record none.

## Structure

- `packages/contracts/src/work.ts`: wire types and paths.
- `packages/core/src/work/`: ports (`WorkAccess`, `WorkRepository`, `WorkEventLog`,
  `WorkUnitOfWork`), validation and use cases. No Drizzle or `@flux/db` import.
- `packages/db/src/repositories/work.ts` and migration `0008_work.sql`: rows only, no decisions.
- `apps/server/src/work/`: adapters (`evaluateProject`/`authorize`/`visibleFilter`, `recordEvent`)
  and routes. No architecture allowlist entries were added.
- `apps/web/src/work/`: loads every page of work, decisions and results (100 per request until `total`), so the state line, Tasks and inline objects are complete; the Tasks tab (`/projects/:id/tasks`), the state line, message actions
  (Create work, Propose decision, Attach result), inline objects under their source message and
  the Details panel views and forms.

## Not yet

Sketch thoughts as link sources and sources of new work depend on #69/#100 merging; the link
table accepts a new target type through a small migration. Handoffs (a follow-up slice), agent
execution (#52/#68) and the return view (8.8) are out of scope. The UI refreshes by route
revalidation and polling and does not subscribe to the stream yet.

## Tests

`tests/app/work.test.ts` (API, two people, viewer, outsider and an agent principal through the
use cases) and `tests/ui/test_work_decisions.py` (Playwright: create from a message, keyboard
propose/accept, negative result by the second person, pivot with parking, phone). Screenshots:
`docs/design/work-decisions/`.
