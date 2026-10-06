# #153 slice plan: authorized co-work unit creation

Owner: Zamojski5. Independent evaluator: PelikanFix16. The branch is
`claude-maurycy/153-unit-creation`. It is stacked on
`claude-maurycy/153-request-claims` (`ce68753e`, not yet a PR), which is based
on main `6f742eba`. This is one partial slice; original AC-1 to AC-5 stay open.

## Why this slice

No production code inserts into `cowork_units`. Claims (`cowork.claim`),
request admission (`cowork.request`) and request claim/respond each need a
unit. So far only test fixtures created units, so none of these can be used
outside tests. Every one of them needs a unit that some authorized command
created. The contract already says: "Every unit has its canonical original
native-task/run binding at authorized creation. A child unit may explicitly
inherit that binding; an enqueue cannot select some unrelated parent to
borrow its budget."

## How "owner/agent-authorized" is read here

The authority is the **owner's standing grant to the agent connection**. The
agent uses it in its own command, through #152's `prepare`/`complete`, the
one command ledger and the grant debit. No owner HTTP endpoint is added. The
evaluator can disagree with this reading here, in one place. The other
reading is a human owner command that creates units for the owner's own
connections. It would need its own idempotency store and would not use the
#152 receipt machinery the task names.

## Contract change (separate commit, flagged for peer review)

`docs/development/cowork-coordination.md` → "Unit creation (2026-10-05, peer
review required)". It records the following:

- the operation, its class (the created unit's role) and its target (the
  task);
- the payload;
- root and child creation;
- the assignee, separation, task-fence and bound rules;
- the lock order and the `cowork.unit_state` post-state;
- replay and re-issue.

The product contracts CO-1–CO-5 and CW-1–CW-5 are unchanged.

**Needs PelikanFix16 acceptance:**

- the operation name `cowork.unit.create`;
- the class semantics: the created unit's role, not the creator's. For
  example, an author holds a `review`-class creation grant to open its
  reviewer's unit. That grant authorizes neither the creator's review claim
  nor the assignee's claim;
- the new post-state kind `cowork.unit_state`;
- the third optional hook in `AgentExecutionDomainChecks`;
- `agentOperationTarget('cowork.unit.create') === 'work'`.

**Migration number:** `0050`. It was free on main and on every local and
remote branch on 2026-10-04: main ships up to `0044`; `0045`–`0048` are taken
by #154 files, #228 and #238; this stack's own `0049` is the request
claim/respond operations. The reservation must be posted on #153 before this
branch is pushed. This worker does not comment on GitHub.

## Acceptance criteria

- **U1 (AC-1):** a root `cowork.unit.create` command does the following, in
  one transaction:
  - It takes a current grant of the role's class, an exact task target or no
    target, and an exact `expectedTaskVersion`.
  - It creates one `pending` unit for the creator itself, with
    `work_id = lineage_work_id = task` and a server-derived run.
  - #152 debits one use and writes one receipt, whose `cowork.unit_state` is
    checked by the hook.
  - The task row is unchanged.
- **U2 (AC-1/2):** a child command does the following:
  - The creator holds a live claim on a unit of that lineage on the same
    task.
  - The command creates one unit that inherits the lineage and run and may be
    assigned to another live connection.
  - The assignee can claim it with its own `cowork.claim` grant. The author
    can then admit a review request to it, and the assignee can claim that
    request. Every step runs through the production compositions.
- **U3 (AC-1):** each of the following refusals leaves no unit, slot row,
  request lineage, grant use or receipt, and no task change:
  - **Root:** non-self assignment → `COWORK_ASSIGNMENT_REFUSED`; another
    open unit of that role on the task, including a paused one →
    `COWORK_UNIT_TAKEN`.
  - **Child:**
    - the parent is unknown, another connection's, in another project or
      on another task → `COWORK_UNIT_NOT_FOUND`;
    - the parent's claim is not live (wrong lease, generation or session,
      expired or unclaimed) → `COWORK_CLAIM_LOST`.
  - **Assignee:** revoked, in another workspace, without this project
    selected or without the execute scope → `COWORK_ASSIGNEE_UNAVAILABLE`.
  - **Separation:**
    - a review unit for an execute assignee of the run;
    - an execute unit for a review assignee;
    - the same owner under `distinct_owner`.

    Each → `COWORK_REVIEW_SEPARATION`.
  - **Task:** stale version → `COWORK_VERSION_CONFLICT`; `done` or
    `not_pursued` → `COWORK_TASK_CLOSED`.
  - **Bounds:** run cap reached → `COWORK_BUDGET_EXHAUSTED`.
  - **Payload:** extra or missing fields, a bad `unitKey`, a parent that is
    not an object → `INVALID_INPUT`.
  - **Grant:** a wrong operation's grant, an exact grant for another task, a
    task of another project → `AGENT_EXECUTION_UNAVAILABLE` or
    `OBJECT_NOT_FOUND`; an exact grant for a task of another project is
    refused at grant creation.
- **U4 (AC-1/2):** idempotency.
  - An exact replay is an observation: no new unit, debit or receipt.
  - After the unit is claimed, the old receipt is `COMMAND_POSTSTATE_STALE`.
  - A changed payload under the same command ID → `IDEMPOTENCY_CONFLICT`.
  - Re-issuing the same intent under a new command ID → `existing`, the same
    unit and one more debit.
  - The same intent key with another role or assignment →
    `COWORK_UNIT_CONFLICT`.
- **U5 (races, real PostgreSQL):**
  - Two connections create a root on the same task at the same time. The
    later one waits on the task row, then gets `COWORK_UNIT_TAKEN` and
    persists nothing.
  - Two concurrent re-issues of the same intent produce one unit: one
    `created` and one `existing`.
  - Creation races assignee revocation in both orders. If revocation commits
    first, the creation is refused. If creation commits first, revocation
    stops the new unit.
- **U6:** an in-place `0050` upgrade test asserts the following:
  - the live grant operation list equals the contract list exactly;
  - the 0049 list is frozen in the 0049 test;
  - historic rows survive;
  - a re-run is idempotent.
- **U7:** a mutation proof. Removing each named guard in a scratch copy makes
  the intended test fail.
- Docker image build, typecheck and lint pass. The affected co-work, agent
  execution, grant and migration tests pass, and the full
  `./scripts/check_application.sh` passes on ports 19102/19103.

## Stays out

- decomposing a plan into new native tasks (the rest of AC-1), and unit
  creation on a task other than the parent's;
- reassignment and transfer, unit completion and scheduling;
- reviewer and checkpoint claim eligibility;
- the #238 fence;
- MCP tool exposure and #160 Start/Resume;
- the Agents UI (#136);
- real two-owner/three-connection clients, device and release evidence.
