feat(cowork): authorized unit creation through #152 grants and receipts (#153)

Refs #153. This is one partial slice. Original AC-1 to AC-5 stay open.
Stacked on `claude-maurycy/153-request-claims`; review that PR first, or read
this diff against its head `ce68753e`.

Until now no production code created co-work units, so only test fixtures
could use claims, request admission and request claim/respond. This slice
adds the authorized command that creates units. With it, the flow runs
end to end through production compositions:

1. an agent takes a task;
2. it claims the task's unit;
3. it opens a review unit for a peer;
4. it sends that peer a review request;
5. the peer claims the unit and the request, each under its own owner's grant.

Everything runs inside the caller's transaction through #152's
`prepare`/`complete`. It is internal composition only. No MCP tool, client
scheduling or UI is enabled.

## Contract

`docs/development/cowork-coordination.md` → "Unit creation (2026-10-05, peer
review required)", committed separately before the code (`97b3730a`).

The authority is the owner's standing grant to the agent connection, used by
the agent's own command. No owner HTTP endpoint is added; the reading is
recorded in the plan so it can be disputed in one place.

## Implementation

- **New #152 operation `cowork.unit.create`.**
  - `objectId` is the native task; `prepare` validates it as for
    `work.update`, and an exact grant target must be a task of the grant's
    project.
  - The class is the role of the unit being created. It gives the creator no
    claim and the assignee no authority: the assignee still needs its own
    `cowork.claim` grant.
  - Migration `0050_cowork_unit_creation.sql` widens only the grant
    operation CHECK; `FLUX_SCHEMA_VERSION` is 50.
- **Payload** `{ unitKey, expectedTaskVersion, assignmentConnectionId, parent }`,
  exact keys.
- **Root** (`parent: null`): opens a server-derived run (creator, task, key)
  for its own assignee only.
  - It is refused with `COWORK_UNIT_TAKEN` while any open (pending, claimed
    or paused) unit of that role exists on the task.
  - That is the atomic guard against two connections taking one task, and
    for `plan` units it is the sole plan-writer guard.
- **Child** (`parent: { unitId, generation, leaseId }`): the creator's
  live-claimed unit on the same task. The new unit inherits its lineage and
  run and may be assigned to another live connection that has the project
  selected and the execute scope.
- **Rules:**
  - the exact task version, and the task is not closed;
  - author/reviewer separation within a run, with owners also compared
    under `distinct_owner`;
  - a server-owned run cap;
  - a re-issued intent returns `existing`, and the same key for anything else
    is `COWORK_UNIT_CONFLICT`.

  Creation never changes the task row, opens a request lineage or creates a
  claim.
- **Lock order:**
  1. `prepare`;
  2. the assignee connection row, `FOR SHARE`;
  3. the sorted creator/assignee slots;
  4. the #171 graph locks;
  5. the complete task set;
  6. the parent unit row;
  7. fresh `clock_timestamp()`;
  8. insert or the existing unit;
  9. the new `cowork.unit_state` post-state hook;
  10. `complete`.

## Negative controls, races and mutation proof (real PostgreSQL)

@SUMMARY@

## Checks at `301a2868` (Docker, isolated Compose projects)

@CHECKS@

Evidence: `docs/agents/evidence/153-unit-creation/` ([README](README.md),
[plan](PLAN.md), [source hashes](source-sha256.json)).

## Open peer questions (PelikanFix16)

1. **#152 registry acceptance.** Do you accept the following?
   - `cowork.unit.create`;
   - its class as the *created* unit's role (an author holds a
     `review`-class creation grant to open its reviewer's unit; the grant
     authorizes no claim for either party);
   - the task as its target;
   - the `cowork.unit_state` post-state;
   - the third optional post-state hook.
2. **Is the reading of "owner/agent-authorized" right?** It is the owner's
   standing grant used by the agent, not a separate owner endpoint.
3. **Root exclusivity.** The proposal allows one open unit per (task, role)
   across runs, and a paused unit also blocks. Should a transfer or stop
   command come before roots on a paused task can be reopened?
4. **Inherited open question from the request-claims PR.** Which grant
   authorizes response publication?

## Needs action before push

- Post the `0050` reservation on #153, after the `0049` reservation of the
  request-claims PR. Later migrations that rewrite
  `agent_standing_grants_operation_check` must keep `cowork.unit.create`.

## Not in this PR

- decomposing a plan into new native tasks, and child units on other tasks;
- reassignment and transfer, unit completion, scheduling and the checkpoint
  producer;
- reviewer and checkpoint claim eligibility, the #238 fence and the #74
  adapter;
- the production response publisher;
- MCP exposure and #160 Start/Resume;
- real clients, UI, device and release evidence.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
