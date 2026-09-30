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

## Required verification

Exercise browser/API persistence and MCP against actual canonical rows. Cover
two concurrent planners sharing one source/intent, changed payload/revision,
later task edits, criteria bounds, foreign guessed dependencies, cycles including
concurrent reciprocal changes, stale native versions, graph/claim lock waits,
unmet prerequisite eligibility, current grant loss and rollback of task/intent/
edges/notice/debit/receipt/events. Preserve prior-schema tasks exactly, and obtain
fresh independent functional and rendered task-detail evaluation. Real pinned
Codex/Claude model-driven decomposition remains required separately.
