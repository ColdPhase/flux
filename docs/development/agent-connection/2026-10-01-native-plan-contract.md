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

Pinned 2026-10-01 for #153, interface text only. **Nothing here is implemented:** no
lock key, reader, graph table or caller exists at this head. The native-plan
implementation slice of #152 (not PR #167's current head) will export these from one
core/database-owned module, and #153 consumes them instead of creating a second lock
namespace. This subsection post-dates the
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

The migration number for the criteria, dependency and intent tables is to be chosen
in the native-plan slice from the numbers free at that time. It is not reserved
here (0038 is already used by the separate `cowork.request` operation list; see the
[execution boundary](2026-09-30/execution-boundary.md#reserved-sender-operation-coworkrequest)).

## Required verification

Exercise browser/API persistence and MCP against actual canonical rows. Cover
two concurrent planners sharing one source/intent, changed payload/revision,
later task edits, criteria bounds, foreign guessed dependencies, cycles including
concurrent reciprocal changes, stale native versions, graph/claim lock waits,
unmet prerequisite eligibility, current grant loss and rollback of task/intent/
edges/notice/debit/receipt/events. Preserve prior-schema tasks exactly, and obtain
fresh independent functional and rendered task-detail evaluation. Real pinned
Codex/Claude model-driven decomposition remains required separately.
