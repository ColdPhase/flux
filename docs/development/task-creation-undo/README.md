# Undo an unused AI-created task (#238)

Issue [#238](https://github.com/ColdPhase/flux/issues/238), child of #154 AC-3 and F-017 UI116-3. The accepted
contract (AC-U1–AC-U5) and its independent review are kept verbatim beside this page:
[accepted contract](accepted-contract.md), [contract review](contract-review.md). This page records how the
implementation meets it on `main`. The first implementation (draft #244) composed the live map and wiki editing
work of #239; this one stands on `main` alone. What that means for #239 is in
[Live editing (#239)](#live-editing-239).

## What a person sees

A task created by an agent through its own MCP tools, or by a person who used an AI comparison proposal, shows
**Undo task creation** in Details while it is unchanged and unused. Undo keeps the task with its ID, creator,
sources, creation notice and receipts. It adds a read-only `task.creation_reverted` notice with the real actor and
time, marks the task "Creation undone · read-only history" and drops it from the board, counts, map task counts,
assigned lists, choosers and new targets. Direct links, existing references, the inbox and the export still find
it and name it as undone history. Nothing it produced is deleted, and nothing brings it back: a retry of the
original creation (HTTP cache, native receipt, MCP) gets a typed `TASK_CREATION_REVERTED` conflict.

## Who may undo (AC-U1)

`creationUndoEligibility` in `app/packages/core/src/work/creation-undo.ts` decides it, for reads and, again, inside
the command under the task fence:

- **Origin.** Only the server records it, in the creation transaction: `native_agent` when an agent creates the task
  through the native MCP path, `ai_proposal` when the proactive comparison route commits a proposal's use (the
  person who used it is the creator), `human` for everything else. A client flag, label or text never sets it.
  Tasks created before migration 0048 have no origin: `eligibility_unknown`, never guessed.
- **Actor.** Current project write, and then: the agent that created the task (with the exact
  `work.creation.revert` standing grant, execute or plan; a `work.update` grant does not count), or a person who is
  its human creator, its current human owner, or the current owner of its creator agent. The agent that produced a
  proposal gains nothing from it.
- **Reasons** returned with a task: `eligible`, `not_ai_origin`, `eligibility_unknown`, `task_used`,
  `creation_changed`, `not_authorized`, `already_reverted`. No owner, grant or helper detail is exposed.

The command is `POST /api/v1/work/:workId/creation-undo` with `{ clientCommandId, expectedVersion }`, and the MCP
tool `flux_undo_task_creation`. The same command identity returns the same notice and receipt after a lost
response or restart, under the current authority; another payload under that identity is a conflict.

## Never used (AC-U2): the shared task-use fence

`taskUseRows(tx)` and `prepareReferencedTaskUse(tx, projectId, refs)` in `app/packages/db/src/repositories/`
(`task-use.ts`, `task-targets.ts`) are the one interface every writer of a task-targeted effect joins, inside its
own transaction:

1. current authority, command, material and connection locks;
2. the sorted project graph locks (`taskGraphRows.lockTaskGraphs`, the same 64-bit key as native task planning);
3. ONE sorted `FOR UPDATE` pass over the complete task set, which refuses a missing task
   (`TASK_TARGET_NOT_FOUND`) or a reverted one (`TASK_CREATION_REVERTED`);
4. the effect, then `fence.mark()`, which sets the monotonic `first_persisted_use_at` latch.

Undo takes the same graph and task locks and does not mark, so Undo and a first use serialize: exactly one wins and
the other has no partial effect. A rollback removes the latch with everything else. Reads, receipt replays,
acknowledgements, drafts and typing never mark. The latch survives the later removal of whatever used the task. A
reference that starts to resolve to a task while a writer waits for a graph refuses with
`TASK_TARGET_SET_CHANGED` instead of escaping the fence; the caller retries from the top. Storage throws a
DB-owned `TaskUseRefusal`; `taskUseDomainError` maps it to `ConflictError`/`RuleViolationError` at the HTTP root
mapper, the MCP tool result and each unit of work, without parsing messages.

| Writer | Task set | Marks use on |
| --- | --- | --- |
| Task create | existing sources, related tasks, prerequisites | the saved task and its links (its own baseline is provenance) |
| Task update, dependencies | the task, old and new prerequisites | the change |
| Result | linked tasks, finishing prerequisites, background-comparison sources | the result |
| Discussion reply / contribution | the bound task | the appended message |
| Link (related) | both endpoints | a new link only; an existing exact link is an observation |
| Decision propose / accept | affected, still-applies, parked tasks | the decision |
| Doc create / update / add section | previous and new mentions, the section source | the saved version or new source link |
| Personal assistant run, proactive comparison | the referenced conversation / sources | the run, the reservation |
| GitHub PR link | the task | the new link (a PR rule needs a link, so it cannot reach an unused task) |
| Live session, admission, presentation | the anchor and the presented object | the session, the grant, the presentation |
| Co-work unit creation | the task and lineage task | the new unit |
| Co-work claim, renew, release, checkpoint | the unit's tasks and prerequisites | the saved unit or checkpoint |
| Co-work request | both units' tasks, and every task the request names | the request |
| Co-work request claim / response | the unit's tasks | the claim or response |
| Co-work unit complete / transfer | the unit's tasks, and a task named as the outcome | the transition |

The eligibility reads also require the exact produced version, a creation baseline equal to the current own fields
(`creation_baseline`, recorded in the creation transaction) and no current prerequisite.

## History, retries and consumers (AC-U3, AC-U4)

Undo commits one row change (lifecycle marker and version), one `task.creation_reverted` notice, one immutable
receipt and one `project.work_updated.v1` event (identifiers only) together. Every consumer that lists active work
filters `creation_reverted_at IS NULL`: the bounded native reads (work view, summary, choosers, map thought tasks),
assigned work, agent orientation, personal runs, proactive sources and search. Detail and reference rows carry a
`lifecycle` field, and work chips read "Work · creation undone". An assignment notification is rechecked at the
provider hand-off: a queued push or email for a task undone meanwhile is not sent, one already handed off stays
history, and the inbox labels it "Task creation undone".

## Migrations and reversal (AC-U5)

- **0048** (reserved for #238 since 2026-10-04) adds the origin, baseline, first-use and reversion columns with
  scoped checks and foreign keys, the `task.creation_reverted` notice kind, the receipt table and two guards: a
  receipt is immutable, and a reverted task is read only for every column 0048 knows (a later migration can still
  backfill its own new column, for example a task number). No history is inferred or backfilled.
- **0057** adds `work.creation.revert` to the closed standing-grant operation list. It cannot live in 0048:
  0049, 0050 and 0054 each rewrite the whole list after 0048 on a fresh database. A later rewrite must keep it.
- On an existing database (ledger at 0054) the migrator applies the lower missing 0048 and then 0057;
  `FLUX_SCHEMA_VERSION` is 57.

<a id="reversal"></a>**Reversal.** `reverse/0057_…down.sql` and `reverse/0048_…down.sql` are guarded: they refuse
and change nothing once any feature fact exists (a baseline, which every task created after the upgrade has, a use
latch, a reversion notice or receipt, or a `work.creation.revert` grant). After that, recover from the paired
pre-upgrade database and files backup with the matching image. Before that, with the API and worker stopped:

```
FLUX_REVERSE_0048_QUIESCED=true node tooling/dist/reverse-task-creation-undo.js --execute
```

It holds the migrator's advisory lock, takes the affected tables `ACCESS EXCLUSIVE NOWAIT` (an active holder is
refused), requires the exact ledger of this image, runs both downs and removes exactly the 57 and 48 ledger rows in
one transaction. An uncertain COMMIT is reported as unknown and the client is destroyed. Without `--execute` it
prints the plan. Start only the matching prior image afterwards.

## Live editing (#239)

The live map and wiki editing of #239 is out of v0.1 (founder decision, 2026-10-06) and not on `main`, so none of
its writers exist here. When #239 lands, each of its task-targeting writers (shared wiki text saves, native map
writes that place a task) must join `taskUseRows`/`prepareReferencedTaskUse` before its effect, exactly as the
native doc writer does in `app/packages/core/src/docs/service.ts`. Its memory accounting is its own. Until then the
interface has no live caller and nothing is gated on it.
