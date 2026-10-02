# Native task criteria, dependencies and plan intent — #152 proposed interface

This makes the already accepted native-task direction concrete for peer review
before its schema/command writes. It does not add a board status or certify client
activation. Task rows remain `project_work_items`; discussions consume #154.

## Public and persisted fields

Add `criteria: string[]` (at most 20 distinct trimmed statements, each 1–1,000
characters), `dependencyIds: string[]` (at most 50 distinct same-project UUIDs),
and immutable `planIntent: { materialId: string; version: number; intentKey: string }
| null` to native task creation and presentation. `intentKey` is a trimmed,
nonempty, at most 120-character key within that exact source revision, not an
instruction or authority. Task update can replace criteria/dependencies under its
existing `If-Match`/expected version. It cannot change an existing intent. An
ordinary material or wiki source never becomes approved policy through this field.

Persist criteria as a bounded JSON array and dependencies as project-scoped
relational edges with composite task/project foreign keys, no self edge and a
unique `(project, task, prerequisite)` key. A separate immutable intent record
binds `(project, material, source version, intent key)` to the canonical created
task ID, normalized creation fingerprint and original produced task version.
The referenced immutable material revision has a composite project foreign key.
Existing task content, status, authors and times remain unchanged; empty criteria,
no dependency edges and null plan intent describe absence, never guessed history.

## One canonical command and conflict rule

Browser/API/MCP use the same native work command and validation. Authorize first;
read/lock the current exact plan source revision before the task graph; then acquire
one project task-graph advisory lock before the complete sorted task row set.
All dependency/intent writers use this lock. Reject missing/foreign prerequisites,
self-dependencies and cycles. Cycle traversal stops as soon as the proposed task
is reached and has an explicit bounded safety limit; hitting it is a visible
`TASK_GRAPH_LIMIT`, never a silently accepted graph. Use the graph lock before
inserting an intent or dependency set, so two planners cannot both create it.

With an intent, require the material's current version to equal the requested
revision. An existing intent with the same canonical creation fingerprint and
unchanged produced task version returns that same task ID/actor/times and emits
no second task notice/event. A different fingerprint conflicts with
`TASK_INTENT_CONFLICT`; a subsequently edited/deleted produced task conflicts with
`TASK_INTENT_STALE`. A changed plan revision conflicts visibly before returning
an old outcome. This prevents another decomposition from overwriting an existing
task or turning a retry into another task. Existing #152 connection-command
receipts remain the single agent execution ledger; this intent key is native
plan correlation shared with human creation, not a competing runtime receipt.

The native command does not infer that listed criteria have been satisfied.
Execution claim/start eligibility requires every prerequisite to be `done` and
unparked. A `not_pursued`, blocked, parked or open prerequisite remains unmet until
the plan explicitly changes its dependency. Replacing dependencies on an active
task must retain eligibility; native transitions to `in_progress` or `done` cannot
bypass unmet prerequisites. The browser shows criteria and linked prerequisite
states on the same task, without adding a parallel agent board.

## Coordination and event boundary

#153 must stabilize dependency discovery with the same project graph lock between
its connection-slot lock and complete sorted task locks, then verify current
prerequisite states before an execution claim. Its review/plan roles retain their
own explicit eligibility rules. #152 authority/grant/command locks precede these
locks. Document/material version locks precede the graph lock. This prevents a
claim from observing a partial or superseded dependency set and avoids opposite
task row lock orders. No graph or task lock acquisition follows stream inserts.

Use the verified shared native event collector: criteria, dependency edges,
intent correlation, canonical work/notice, grant debit, receipt and outgoing
intents finish before the single final frozen event batch. A matching native
intent replay adds no new creation intent. Actual code must keep all these rows
inside the same caller-owned transaction and roll back as one unit.

## Task-graph lock and reader (interface pin)

Pinned 2026-10-01 for #153. The text below is the pin as agreed; it was interface-only
at PR #167's head and is implemented by the native-plan slice of #152
(`codex-hubert/152-native-plan`, see [Implemented](#implemented-at-the-native-plan-slice)
for the final names, the file that exports the three primitives and the one placement
deviation). #153 consumes them instead of creating a second lock namespace. This
subsection post-dates the
[independent design review](2026-10-01-native-plan-independent-review.md), restates
the lock order #153 and #152 agreed on #153, and has not itself been reviewed apart
from that exchange.

```ts
lockProjectTaskGraphs(tx: Transaction, projectIds: readonly string[]): Promise<void>
taskPrerequisiteIds(tx: Transaction, workspaceId: string, taskIds: readonly string[]): Promise<string[]>
requireTaskPrerequisitesMet(tx: Transaction, workspaceId: string, taskId: string): Promise<void>
```

- `lockProjectTaskGraphs` lowercases and de-duplicates the project IDs, sorts them
  ascending, and takes one lock per project in that order:
  `pg_advisory_xact_lock(hashtextextended('flux.task-graph:' || projectId, 0))`. It
  locks no task, unit, stream or material row, so a caller can place it exactly where
  the order below says and it can never reverse that order. The namespace string is
  part of the contract: every dependency/intent writer and every #153 claim path uses
  this primitive.
- `taskPrerequisiteIds` is read-only. For the given tasks it returns the distinct,
  lowercase, ascending IDs of their **direct** same-project prerequisites (no
  transitive closure; the proposed composite foreign keys keep edges inside one
  project), bounded by
  `TASK_GRAPH_LIMIT`. Exceeding the bound raises the visible `TASK_GRAPH_LIMIT`
  error, never a truncated list. The caller adds these IDs to its single sorted task
  lock pass.
- `requireTaskPrerequisitesMet` runs only after the caller holds the complete sorted
  task locks, acquires no lock itself and reads the locked current rows. Each direct
  prerequisite must exist in that workspace and project and be `done` and unparked; a
  missing, foreign or tombstoned prerequisite, and one that is `not_pursued`,
  blocked, parked or open, is unmet and raises a visible domain conflict. Callers
  run it again before a resumed or publication effect.

Full lock order for every path that touches tasks, in this order and no other:

1. #152 authority locks first: connection, binding, runtime and current policy access
   rows, then the exact standing grant, then the connection command identity and any
   durable receipt. Document/material-version locks also precede the graph locks.
2. Sorted connection slots. While holding them, discover the connection's complete
   project and task sets.
3. Sorted project graph locks (`lockProjectTaskGraphs`), ascending project ID across
   every project the connection touches.
4. The complete sorted native task set: the units' tasks plus the IDs from
   `taskPrerequisiteIds`, in one ascending pass.
5. Coordination rows (units, requests, checkpoints).
6. Actor commands and conversations.
7. Final events: all domain, edge, intent, debit, receipt and outgoing writes and all
   audience reads precede one frozen event batch. Nothing, graph lock or otherwise,
   is acquired after the first stream insert.

Lifecycle stop/revoke, transfer and effect composition keep this order, and a graph
lock is never added after a task lock or a stream insert.

#153 would compose it through its injected
`CoWorkClaimPolicy.prepareTaskLocks(tx, context, units)`: lock the graphs for the
sorted unique `units[].projectId`, then return
`taskPrerequisiteIds(tx, context.workspaceId, <the units' native task IDs>)`, so its
complete sorted task pass covers the dependencies before the first task lock. An
execution claim then calls `requireTaskPrerequisitesMet` after its task/unit locks;
review and plan eligibility keep their own explicit rules. That adapter and its
checks are #153's to write and are likewise not implemented here.

The migration number for the criteria, dependency and intent tables was chosen in the
native-plan slice from the numbers free at that time (0038 is already used by the
separate `cowork.request` operation list; see the
[execution boundary](2026-09-30/execution-boundary.md#reserved-sender-operation-coworkrequest)):
it is **0039**, recorded below.

## Required verification

Exercise browser/API persistence and MCP against actual canonical rows. Cover
two concurrent planners sharing one source/intent, changed payload/revision,
later task edits, criteria bounds, foreign guessed dependencies, cycles including
concurrent reciprocal changes, stale native versions, graph/claim lock waits,
unmet prerequisite eligibility, current grant loss and rollback of task/intent/
edges/notice/debit/receipt/events. Preserve prior-schema tasks exactly, and obtain
fresh independent functional and rendered task-detail evaluation. Real pinned
Codex/Claude model-driven decomposition remains required separately.

## Implemented at the native-plan slice

Implemented 2026-10-01 on `codex-hubert/152-native-plan`, **stacked on PR #167's head
`7f9bc63285b1ff0a5a15f85c0bfccc56b2873b36`** (no PR yet: it is opened after #167
merges). Runtime source `7cb735fd21b96e5466f276d898d668a6ccb223a0` (tested head
`fad6afb059a4b1694bbbdf1dfd89124f54a64577`); later commits change only tests and
documentation. Executed checks and their limits are in the
[native-plan checkpoint](2026-10-01-native-plan-checkpoint.md). This is a partial #152
implementation (AC-2's native task slice), not whole-issue acceptance: the MCP action
tools stay disabled, #153's claim adapter and real Codex/Claude model-driven
decomposition remain required and separate.

### What exists

| Area | Final names |
| --- | --- |
| Contracts (`app/packages/contracts/src/work.ts`) | `WORK_LIMITS.criteria` 20, `.criterion` 1000, `.dependencies` 50, `.intentKey` 120; `TaskPlanIntent`, `TaskPrerequisite`; `WorkItem.criteria`, `.dependencyIds` (ascending), `.prerequisites` (id, title, status, parked, met) and `.planIntent` (null for every earlier task); `CreateWorkCommand.criteria/dependencyIds/planIntent`; `UpdateWorkCommand.criteria/dependencyIds` |
| Migration | **`0039_native_task_plan.sql`**, `FLUX_SCHEMA_VERSION` 39 (below) |
| Storage | `project_work_items.criteria` (jsonb, `DEFAULT '[]'`, `project_work_criteria_bounded`: array of at most 20 distinct trimmed 1-1000 character strings); `project_task_dependencies` (primary key `(project_id, task_id, prerequisite_id)`, composite `(workspace, project, task)` and `(workspace, project, prerequisite)` foreign keys, `task_id <> prerequisite_id`, at most 50 per task by trigger); `project_task_plan_intents` (primary key `(project_id, material_id, material_version, intent_key)`, `task_id` unique, composite foreign keys to the immutable material revision and to the task, normalized fingerprint, original task version, update-forbidding trigger) |
| Pinned primitives | `apps/server/src/work/task-graph.ts` exports exactly `lockProjectTaskGraphs(tx, projectIds)`, `taskPrerequisiteIds(tx, workspaceId, taskIds)` and `requireTaskPrerequisitesMet(tx, workspaceId, taskId)` with the pinned semantics and `pg_advisory_xact_lock(hashtextextended('flux.task-graph:' \|\| projectId, 0))` |
| Rules | `app/packages/core/src/work/task-graph.ts`: `TASK_GRAPH_LIMIT = 1000`, `lockProjectGraphs`, `directPrerequisiteIds`, `assertNoDependencyCycle`, `assertPrerequisitesMet`, `decidePlanIntent`, `creationFingerprint`; validation exports `taskCriteria`, `taskDependencyIds`, `taskPlanIntent` |
| SQL and locks | `app/packages/db/src/repositories/task-graph.ts` (`taskGraphRows`, `TASK_GRAPH_LOCK_NAMESPACE`), also spread into `workRows` so the `WorkRepository` port carries it |
| Command | the existing `createWork` / `updateWork` / `createResult` use cases are the one canonical command; the browser, the HTTP API and (later) MCP wrappers all call them. `POST /api/v1/projects/:id/work` and `PATCH /api/v1/work/:id` take the new fields |
| Browser | the existing task details show **Done when** (criteria, "Flux does not check them off"), **Waits for** (each prerequisite with its state in words, opening that task) and the plan revision link; the Tasks list says "waits for N tasks" |

Migration number: 0039 is the lowest number at or above 0039 present on neither
`origin/main` nor any pushed `origin/*` head on 2026-10-01 (highest present: 0038 on
`codex-hubert/152-multi-connections`; 0026-0032 are #58, 0033 and 0037 #154, 0034 #152,
0035 #153, 0036 #74, 0038 #152's `cowork.request` list). No issue, PR or document
reserves 0039; #154's proposals 0040/0041 stay unallocated. It is idempotent, preserves
every row, edits no frozen migration, and the same-volume upgrade from the previous
ledger is exercised (checkpoint).

### Behavior as built

- **Validation.** Criteria are trimmed statements of 1-1000 characters; exact duplicates
  collapse, order is kept, and a list of more than 20 entries is refused rather than
  cut (even if duplicates would shrink it). Dependency ids are at most 50 distinct
  lowercase UUIDs. `intentKey` is trimmed, 1-120 characters, with no other keys allowed
  in `planIntent`. Update replaces whole lists under the existing `If-Match`/expected
  version; `planIntent` in an update is `400 PLAN_INTENT_IMMUTABLE`.
- **Prerequisites.** Missing, guessed, foreign-project and foreign-workspace ids are the
  same `422 TASK_DEPENDENCY_NOT_FOUND`; a self edge is `422 TASK_SELF_DEPENDENCY`; a cycle
  is `409 TASK_DEPENDENCY_CYCLE`. The walk follows existing edges level by level from the
  proposed prerequisites, stops the moment the proposed task is reached and visits at
  most `TASK_GRAPH_LIMIT` tasks; beyond that is `409 TASK_GRAPH_LIMIT` and nothing is
  written. A new task cannot be anyone's prerequisite yet, so creation needs no walk.
- **Eligibility.** A task in `in_progress` or `done` has every direct prerequisite
  `done` and unparked at the moment it is written. A status change into either state,
  and a dependency replacement on a task in either state, runs the check after the
  edges are written and before the unit finishes; `409 TASK_PREREQUISITES_UNMET` rolls
  the whole unit back. This also covers creating a task already in those states and
  `createResult` with `finishes`. A `not_pursued`, blocked, parked or open prerequisite
  stays unmet until the plan changes the dependency. Later regressions of a prerequisite
  are not cascaded; the pinned reader is for the claim path to run again before a
  resumed or publication effect.
- **Plan intent.** Decision order: requested revision against the plan material's
  current version first (`409 SOURCE_VERSION_CONFLICT`, the code the execution port
  already uses, even for a replay), then an existing intent: a different canonical
  creation is `409 TASK_INTENT_CONFLICT`, a produced task whose version moved (or is
  gone) is `409 TASK_INTENT_STALE`, and the same creation of an unchanged task returns
  the original task with its actor, times and version and records no notice, edge,
  intent or event. The canonical creation fingerprint covers title, outcome, status,
  blocker, owner, sources and related (as sets), criteria (ordered) and prerequisites
  (as a set); the actor and the retry identity are not part of it, so another planner's
  identical decomposition reaches the same task. A material that is not in the project
  is `422 PLAN_SOURCE_NOT_FOUND`. A `clientCommandId` retry keeps its fingerprint shape
  for creations without plan fields, so older retries still match, and covers every plan
  field otherwise.
- **Lock order as built** for create/update/result (the pinned list above, restricted to
  what a native task command takes): project access rows, the plan material row
  (`FOR SHARE`), the command identity, the project graph lock, the complete task rows in
  ascending id (`ORDER BY id FOR UPDATE`, the task plus its current or new
  prerequisites), then everything else; all criteria, edge, intent, notice, debit,
  receipt and outgoing writes precede the single final event batch, and nothing is locked
  after the first stream insert. A plain edit that touches neither prerequisites nor a
  start/finish takes only its own task row.
- **Native composition.** `nativeWorkInTransaction(tx)` carries the new fields; with the
  #152 execution port a `work.create` execution writes the task, edges, intent, notice,
  debit and receipt before one final flush, and a failure before or after the flush
  rolls all of it back.

### Deviations and refinements

- **Where the three primitives live.** The pin says one core/database-owned module. Core
  must not import persistence and the database package cannot raise core's domain
  errors, so the SQL and lock namespace live in `@flux/db`, the rules and visible errors
  in `@flux/core`, and the exports #153 consumes in the server composition module
  `apps/server/src/work/task-graph.ts`, with the pinned names and signatures
  unchanged. #153's `prepareTaskLocks` imports `lockProjectTaskGraphs` and
  `taskPrerequisiteIds` from there. No architecture allowlist entry was added.
- **Tests do not prove the ascending SQL sort.** `ORDER BY id` is in the lock query, but
  the planner already returns primary-key order for these small sets, so a missing sort
  is not observable. The ascending order is a code guarantee, not a measured one.
- **No database cycle guard.** A trigger cannot see an uncommitted reciprocal edge, so
  cycles are rejected only by the command under the graph lock. Any other writer would
  have to take the same lock; none exists.
- **Not implemented here:** MCP action tools (disabled; the `work.create`/`work.update`
  wrappers followed on 2026-10-02, see
  [native task actions](../agent-connection.md#native-task-actions-152)), provider UI for agents, #153's
  claim adapter, authoring criteria or prerequisites in the browser (creation and
  editing are API-only; the browser displays them), project export of the new fields
  (the export bundle keeps its current shape and does not carry criteria, edges or
  intents), and search indexing of criteria.

### Verification already recorded

Pure rules, API/persistence, concurrency, rollback, constraint and migration tests, and
one browser journey, are listed with results in the
[checkpoint](2026-10-01-native-plan-checkpoint.md). The independent functional and
rendered task-detail evaluation named under "Required verification" is still to be
done by a different reviewer.
