# Authorized co-work unit creation (#153)

Tested head: `301a2868` (tree `14fe750895436060a1769c896670b733ef393431`), branch
`claude-maurycy/153-unit-creation`. It is stacked on
`claude-maurycy/153-request-claims` (`ce68753e`), which is based on main
`6f742eba`. Owner: Zamojski5. Independent evaluation by PelikanFix16 is still
required. Original AC-1 to AC-5 stay open. No public MCP action, client
scheduling or UI is enabled. See the [plan](PLAN.md) and the
[contract section](../../../development/cowork-coordination.md#unit-creation-2026-10-05-peer-review-required).
Source hashes at the tested commit are in [source-sha256.json](source-sha256.json).

## Needs action before push

- **Migration `0050` reservation.** `0050` was free on main and on every
  local and remote branch on 2026-10-04. Main ships up to `0044`; `0045`–`0048`
  belong to #154 files, #228 and #238; `0049` is this stack's request
  claim/respond operations. The reservation still has to be posted on #153.
  `FLUX_SCHEMA_VERSION` is now 50, so any of `0045`–`0048` that lands later
  must keep 50. Any later migration that rewrites
  `agent_standing_grants_operation_check` must keep `cowork.unit.create`.
- **#152 registry acceptance.** PelikanFix16 owns the registry, so these
  additions need his acceptance:
  - the `cowork.unit.create` operation and its class semantics (the created
    unit's role);
  - the `cowork.unit_state` post-state;
  - the optional `coordinationUnitPostcondition` hook in
    `AgentExecutionDomainChecks`, which fails closed when absent;
  - `agentOperationTarget('cowork.unit.create') === 'work'`.
- **The reading of "owner/agent-authorized".** It is recorded in the
  [plan](PLAN.md#how-owneragent-authorized-is-read-here). The authority is the
  owner's standing grant, used through the agent's own #152 command. No owner
  HTTP endpoint was added.

## What changed

- `docs/development/cowork-coordination.md`: the "Unit creation" contract
  section. It was a separate commit before the code (`97b3730a`).
- `app/apps/server/src/co-work/units.ts` holds
  `coWorkUnitCreateInTransaction`. The steps are:
  1. #152 `prepare`, which validates the task target;
  2. `coworkUnitCreationRows.lock`, which takes the assignee connection row
     `FOR SHARE`, then the sorted creator/assignee slots, the #171 graph
     locks, the complete task set and the parent unit row;
  3. the pure rules;
  4. an insert, or the existing unit for the same intent;
  5. the `cowork.unit_state` hook;
  6. #152 `complete`.

  Replay is an observation, and the hook rejects a unit that has changed
  since.
- `app/packages/core/src/co-work/units.ts` holds the core rules:
  - the strict payload;
  - `coWorkRootRunId`, a namespaced SHA-256 in RFC 9562 v8 layout;
  - the root rules: self-assignment only and the `TAKEN` guard;
  - the child rules: the parent's ownership, task and live claim;
  - the task version and closed-task checks;
  - the assignee check;
  - existing intents and conflicts;
  - the run cap;
  - author/reviewer separation.
- `app/packages/db/src/repositories/cowork-unit-creation.ts` takes the locks,
  reads the facts after the last wait (with fresh `clock_timestamp()`),
  inserts with `ON CONFLICT DO NOTHING` on (task, run, `unitKey`) and does
  the canonical read.
- Registry changes:
  - `contracts/agent-execution.ts`: the operation, its classes and the
    `cowork.unit_state` kind;
  - core `POSTCONDITIONS` and `validateAgentPostconditions`;
  - server `execution.ts`: post-state binding (`taskId` = target,
    `role` = class) and the hook;
  - `agentOperationTarget`;
  - `co-work/grants.ts`: an exact grant target must be a task of the grant's
    project;
  - db `nativePostcondition`, which fails closed for the new kind;
  - migration `0050_cowork_unit_creation.sql`, which widens only the
    operation CHECK;
  - `FLUX_SCHEMA_VERSION` = 50;
  - the Agents view label "set up work on a task".
- Tests:
  - `tests/app/cowork-unit-creation.test.ts` is new: 7 tests over real
    PostgreSQL, #152 runtimes, grants and the ledger. No unit is inserted
    directly.
  - `tests/app/agent-unit-creation-migration.test.ts` is new: the in-place
    `0050` upgrade. It asserts that the live operation list equals
    `AGENT_OPERATIONS` exactly, that it is the 0049 list plus the new
    operation, that historic rows are byte-identical, that unknown or
    near-miss operations stay refused, and that a re-run is idempotent.
  - `agent-request-response-migration.test.ts` now compares 0049 against a
    frozen 0049 list, as earlier tests do for 0043. The exact head-list
    equality moved to the 0050 test; it was not dropped.
  - `agent-execution-core.test.ts` gains the exhaustive sample entry and a
    registry test for the new operation and post-state.

## Executed checks (Docker, isolated Compose projects, ports 19102–19109)

All checks ran at `301a2868`, from a detached snapshot worktree.

- **Image build, typecheck and lint** pass, both in a separate
  `docker build --target build` and inside every run below. The only lint
  finding is the pre-existing `react-hooks/exhaustive-deps` warning in
  `ProjectTasks.tsx`.
- **New and changed files**: `cowork-unit-creation`,
  `agent-unit-creation-migration`, `agent-request-response-migration` and
  `agent-execution-core`. Result: **18/18** on the first run.
- **Affected set**, 22 files: **135/135**, with 0 skipped, cancelled or todo.
  The files are:
  - `agent-doc-authors-migration`, `agent-execution-core`,
    `agent-execution`, `agent-request-operation-migration`,
    `agent-request-response-migration`, `agent-unit-creation-migration`;
  - `architecture`;
  - `cowork-admission`, `cowork-claims-core`, `cowork-execution`,
    `cowork-migration-arrival`, `cowork-recovery`,
    `cowork-request-responses`, `cowork-requests-storage`, `cowork-storage`,
    `cowork-unit-creation`;
  - `mcp-work-actions`, `migration-ledger`, `oauth-mcp`, `task-graph-core`,
    `ai-connections-migration` and `project-agents`.
- **Full `./scripts/check_application.sh`**
  (`FLUX_TEST_PORT=19102 FLUX_TEST_MAILPIT_PORT=19103`): **EXIT 0**.
  - API: **747/747**, 0 skipped. That is the base branch's 738, plus the 7
    unit-creation tests, the 0050 migration test and the core registry test.
  - Every later browser/service phase passed: 3+1+1+1+1+6+1+1+1+1 = 17 tests.
- **Foundation:** `check_agent_setup.py` passed, the host Python suite ran
  67 tests, all OK, and `git diff --check` is clean.
- Raw logs stay local and are not published: `w153e-build1`, `w153e-t1`,
  `w153e-t2`, `w153e-full` and `w153e-mut-*`.

## Negative controls

Each refusal snapshots the following, before the attempt starts, and asserts
afterwards that nothing changed:

- every unit row in the workspace: identity, lineage, run, key, role,
  assignment, state, version and generation;
- the request lineage count;
- the connection slot rows;
- the involved connections' total grant uses and receipts;
- every task row: version, status, human/agent owner and `updated_at`.

Covered refusals:

- **Root:**
  - another assignee → `COWORK_ASSIGNMENT_REFUSED`;
  - a stale task version → `COWORK_VERSION_CONFLICT`;
  - a `done` or `not_pursued` task → `COWORK_TASK_CLOSED`;
  - extra or missing fields, a bad key, a non-object parent, a `runId` field
    or version 0 → `INVALID_INPUT`;
  - a `cowork.claim` grant, or an exact grant for another task →
    `AGENT_EXECUTION_UNAVAILABLE`;
  - another project's task → `OBJECT_NOT_FOUND`. Grant creation also refuses
    it, and refuses a unit ID as a target, with 404;
  - an open unit of the role on the task → `COWORK_UNIT_TAKEN`. This covers
    another connection, the same connection under another key, a paused
    unit, and the sole plan writer;
  - the same key for another role → `COWORK_UNIT_CONFLICT`.

  After the earlier unit is stopped by revoking its connection, another
  connection opens a new run.
- **Child:**
  - an unknown parent, another connection's unit, or the creator's own unit
    on another task → `COWORK_UNIT_NOT_FOUND`;
  - a wrong lease or generation, another runtime session, an expired lease,
    or an unclaimed own unit → `COWORK_CLAIM_LOST`;
  - an unknown, revoked, other-workspace, project-not-selected or read-only
    assignee → `COWORK_ASSIGNEE_UNAVAILABLE`;
  - a review unit for the author, or an execute unit for a reviewer, in the
    run → `COWORK_REVIEW_SEPARATION`. The same applies to another connection
    of the author's owner under `distinct_owner`, which `distinct_connection`
    allows;
  - the same key for another assignee → `COWORK_UNIT_CONFLICT`;
  - the run cap → `COWORK_BUDGET_EXHAUSTED`. A re-issued existing intent is
    still returned at the cap.
- **Replay:**
  - an exact replay observes, with no second debit or receipt;
  - a changed payload under the same ID → `IDEMPOTENCY_CONFLICT`;
  - after the unit is claimed → `COMMAND_POSTSTATE_STALE`;
  - after the grant is revoked → `AGENT_EXECUTION_UNAVAILABLE`.
- **Authority stays separate:**
  - the author cannot get an exact claim grant on the reviewer's unit (404);
  - a project-wide review claim grant does not let the author claim it
    (`COWORK_UNIT_NOT_FOUND`);
  - the reviewer claims it only with its own owner's grant.

The end-to-end positive path runs only through production compositions:
root creation, claim, a child review unit for a peer, the peer's claim,
review request admission, and the peer's request claim.

## Races (real PostgreSQL)

- **Two connections open a root on one task.** The later one waits on the
  project task-graph advisory lock, before any task or unit row. It then gets
  `COWORK_UNIT_TAKEN`, with no debit and no receipt; exactly one unit exists.
- **The same intent issued twice at once.** One `created` and one `existing`
  outcome for the same unit. Two grant uses and two receipts, one row.
- **Assignee revocation commits first.** The creation waits on the assignee
  connection row (`transactionid`), then gets
  `COWORK_ASSIGNEE_UNAVAILABLE`, and nothing persists.
- **Creation commits first.** The revocation waits for it, then its trigger
  stops the new unit (`stopped`, generation 1, version 2).

## Mutation proof

Each group ran on a detached copy of the tested sources with its guards
removed, using only `cowork-unit-creation.test.ts` (`w153e-mutate.py`,
`w153e-mutrun.sh`; not published). The removals keep lint clean, so every
mutant built, typechecked and linted. Within a group, each mutation affects a
different test. Groups A–E ran at `301a2868`; F ran at `ed97f009`.

| Group | Guard removed | Result | Failing test and reason |
| --- | --- | --- | --- |
| A | M1: a root only for its own assignee | 4 pass, 3 fail | Root negative controls: `Missing expected rejection: COWORK_ASSIGNMENT_REFUSED`. |
| A | M3: the parent's live claim fence | (same run) | Child negative controls: `Missing expected rejection: COWORK_CLAIM_LOST`. |
| A | M10: the post-state hook's version comparison | (same run) | **Survived.** Every stale case also changed the unit state. The test was strengthened (`ed97f009`); see F. |
| A | M11: the assignee row `FOR SHARE` lock | (same run) | Revocation race: `No session became blocked`. The creation no longer waited on the revoking transaction. |
| B | M2: one open unit per role on a task (`TAKEN`) | 2 pass, 5 fail | Root negative controls and the two-root race: `Missing expected rejection: COWORK_UNIT_TAKEN`. |
| B | M4: the parent is on the same task | (same run) | Child negative controls: the creator's own unclaimed unit on task B reached the fence (`COWORK_CLAIM_LOST`) instead of `COWORK_UNIT_NOT_FOUND`. |
| B | M12: existing-intent recognition | (same run) | Root replay test and same-intent race: `COWORK_UNIT_CONFLICT` instead of `existing`. |
| C | M8: the exact task version | 5 pass, 2 fail | Root negative controls: `Missing expected rejection: COWORK_VERSION_CONFLICT`. |
| C | M5: the assignee's project selection | (same run) | Child negative controls: `Missing expected rejection: COWORK_ASSIGNEE_UNAVAILABLE`. Only the not-selected assignee changed. |
| D | M9: closed tasks | 5 pass, 2 fail | Root negative controls: `Missing expected rejection: COWORK_TASK_CLOSED`. |
| D | M6: author/reviewer separation | (same run) | Child negative controls: `Missing expected rejection: COWORK_REVIEW_SEPARATION`. |
| E | M7: the run cap | 6 pass, 1 fail | Child negative controls: `Missing expected rejection: COWORK_BUDGET_EXHAUSTED`. |
| F | M10 again, at `ed97f009` | @F@ |

The first attempt of group A failed before any test ran, for an
infrastructure reason. Its API container became unhealthy because a startup
database query hit a read timeout while the Docker VM was loaded. The group
was re-run unchanged, with the results above.

## Remaining for #153

- decomposing a plan into new native tasks (the rest of AC-1), and child
  units on other tasks;
- reassignment and transfer, unit completion, scheduling and the checkpoint
  producer;
- reviewer and checkpoint claim eligibility, the #238 fence and the #74
  GitHub recipient adapter;
- the production response publisher and its grant (an open question from
  the request-claims slice);
- MCP exposure and #160 Start/Resume; real two-owner/three-connection clients;
- the Agents UI (#136), device evidence and release evidence.
