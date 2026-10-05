# Durable local-agent coordination (#153)

## Current authorized recovery composition (2026-10-01)

`coWorkRecovery(db, serverSecret)` is the internal current-bearer composition
for #152/#160; it is not a separate public tool registry or an execution grant.
Every call holds the actual connection/binding and central selected-project
policy before decoding a continuation or reading pending records. It creates
no runtime, claim, debit, receipt, ACK, ordinary message, notification or model
call. Cold reconnect uses the existing connection/binding rather than a client
assertion of ownership or authority.

Packets contain canonical request/task/unit/sender references, exact original
target/source/criteria pointers and recovery state; no content, owner/payer
roster, fingerprint, grant or raw cursor position is projected. All native
target/source/criteria/dependency/response references must remain in the exact
workspace/project and, for mutable objects, at their recorded current version.
Thoughts additionally belong to a current project map. Filtering precedes SQL
pagination, so an arbitrarily large inaccessible prefix cannot suppress ready
authorized packets or affect visible page counts/continuations. No total or
scanned count is returned. GitHub references remain excluded until the receiving
owner's own verified repository/provenance adapter is supplied; no binding-author
credential substitutes for it. This is explicitly native-reference coverage.

AES-GCM continuations use a separate server-secret key namespace and bind the
workspace/project/connection/owner/client/OAuth binding. They preserve the exact
PostgreSQL microsecond keyset, are valid for15 minutes from the first page and
cannot extend their original deadline. Every continuation rechecks current
policy and references. Tampering, expiry, a foreign binding or a missing retained
position returns a content-free `resync_required`; the client must request a
fresh bounded snapshot rather than interpreting it as completion. A fresh
snapshot is also needed to discover older requests whose source access/version
becomes valid after an earlier scan. Unavailable or changed references stay
durably unresolved; exclusion does not resolve, supersede or delete them.

An exhausted continuation is not proof that all pending work was seen. Request
timestamps are assigned at insertion, not commit; a writer that commits late
can become visible behind a scan's retained position. Before #160 consumes this
recovery path, the admission composition must hold the recipient's connection
slot from timestamp assignment through commit, as part of its complete sorted
sender/recipient slot pass, and exercise that ordering with concurrent distinct
lineages. The storage adapter does not acquire those upstream locks itself.
Until that composition is verified, late-commit recovery remains an open
integration requirement; a fresh bounded snapshot is needed at a safe resume
boundary, and an empty page must never imply successful completion.

This does not prove checkpoint creation, native graph/reviewer eligibility,
authorized request resolution, execution/publication fences, public MCP/client
wiring or model-driven Start/Resume. Those are unchanged requirements. Request
admission is specified in the next section.

### Live request admission (2026-10-04, peer review required)

`coWorkRequestInTransaction(tx, claims, command, policy)` is the internal
caller-owned composition of #152's reserved `cowork.request` operation. It is
not a public tool; MCP exposure stays disabled until #152/#160 wire it.

- **Identity.** `objectId` is the *sender's* unit and is mandatory; the request
  class is that unit's actual role. The payload is exactly
  `{ generation, leaseId, request }`, where `generation`/`leaseId` are the
  sender's live claim fence and `request` is the bounded enqueue input without
  `commandId` (the durable client command ID is used). `request.unitId` names
  the *recipient's* unit. A payload naming its own unit as recipient, extra
  fields, copied prompts or authority fields are refused before any write.
- **Lock order.** #152 `prepare` (current bearer/runtime/grant/command ledger)
  → sorted, de-duplicated sender and recipient connection slots → sorted
  project graph locks (#171 `lockProjectTaskGraphs`) → the complete sorted
  native task set (both units' tasks and lineage roots, the parent request's
  task and lineage root, and their direct prerequisites) → sorted unit rows →
  lineage/request rows inside storage → `complete`. Fresh `clock_timestamp()`
  after these waits fences the sender's lease. Nothing locks a graph, task or
  material after a unit, request or stream row.
- **Admission rules.** The sender unit must be assigned to the authenticated
  connection in the command's project, hold a claim with exactly that
  generation, lease ID and runtime session, and be unexpired at fresh database
  time. The recipient unit must be in the same project and the same canonical
  lineage (`lineage_work_id`, `run_id`) as the sender unit, so a sender cannot
  open or borrow an unrelated lineage budget. A connection cannot address
  itself. Review requests also follow the server-owned separation policy:
  `distinct_connection` (default; explicit same-owner review) or
  `distinct_owner`. Target, source and criteria references must currently exist
  in this project at their exact recorded versions. GitHub references stay
  refused until #74 supplies the receiving owner's verified repository adapter.
  The recipient must be a live connection of this workspace; selecting it
  creates queued intent only and never recipient authority, claim or grant.
- **Refusals.** Every refusal throws a typed domain error inside the caller's
  transaction, so no request, delivery intent, lineage count, slot change,
  grant use or receipt survives. Unavailable recipients/units/parents/sources
  share content-free codes. Successful admission writes the request and one
  delivery intent, stages the `cowork.request_state` post-state from the saved
  row, then lets #152 debit one use and write the sole receipt.
- **Duplicates and replay.** The same command ID and fingerprint replays the
  original receipt as an observation: no sender fence, no new request or debit,
  but current authorization, current readability of the request's references
  and the unchanged canonical post-state (request version/state, sender unit
  role/assignment/lineage) are rechecked. After the recipient defers or claims
  the request, the old receipt is `COMMAND_POSTSTATE_STALE`, as for claims. The
  sender may then re-issue the same intent under a new command ID: storage
  returns the existing request and delivery intent, never a second delivery,
  and that new command spends one grant use.
- **Recovery ordering.** Request timestamps are assigned while the recipient's
  slot is held, and the slot is held through commit. Admissions to one
  recipient therefore become visible in timestamp order, so a recovery cursor
  cannot pass a row that commits later. Concurrent distinct lineages are tested.
  Request writers other than this composition must keep the same rule.

Out of scope here: request claim/resolution/supersession (specified in the
next section), checkpoint production, reviewer/checkpoint claim eligibility,
the #238 lifecycle/use fence, native publication and the final event flush.

### Request claim and resolution (2026-10-04, peer review required)

`coWorkRequestResponseInTransaction(tx, claims, command, policy)` is the
recipient's internal caller-owned composition. It is not a public tool, and MCP
exposure stays disabled until #152/#160 wire it.

- **Operations.** This adds two #152 registry operations, which need their
  owner's acceptance. Migration `0049` widens the closed grant operation list
  with exactly these two. Its number must be reserved on #153 before the branch
  is pushed.
  - `cowork.request.claim` takes a delivered request.
  - `cowork.request.respond` resolves or declines it.

  `objectId` is the *recipient's* own unit, and the class is that unit's actual
  role. A grant with an exact target must name a unit assigned to the grantee
  with that role, as for `cowork.claim`. The post-state is the existing
  `cowork.request_state`, where `connectionId` is the acting (recipient)
  connection, `unitId` its unit and `role` that unit's role. A request grant,
  delivery, ACK or deferral never stands in for these grants.
- **Payloads (exact keys).**
  - Claim is `{ generation, leaseId, requestId, expectedRequestVersion }`.
  - Resolve is
    `{ generation, leaseId, requestId, expectedRequestVersion, outcome: 'resolved', response }`.
    `response` is a bounded object handed to the publication step; it is never
    stored in the coordination row.
  - Decline is
    `{ generation, leaseId, requestId, expectedRequestVersion, outcome: 'declined', reason }`.
    `reason` is one of `capability`, `policy`, `scope` or `source_changed`.

  `generation` and `leaseId` are the recipient's live claim on its unit, made
  through `cowork.claim`. Extra fields, copied prompts and authority fields are
  refused before any write.
- **Lock order.** The order is:
  1. #152 `prepare`;
  2. the recipient's connection slot;
  3. the sorted project graph locks (#171) for this unit and every unit the
     connection currently claims;
  4. the complete sorted native task set (those units' tasks, lineage roots
     and direct prerequisites);
  5. sorted unit rows;
  6. the request row (`FOR UPDATE`);
  7. for a resolution, the publication step;
  8. the conditional request update;
  9. `complete`, then the caller's single final event flush.

  The request's task is the unit's task, so it is already in the set. The
  publication step may touch only that task and the conversation/stream
  sequence; it queues event intents and never flushes. Fresh
  `clock_timestamp()` after the lock waits fences the lease and the request
  expiry. The conditional SQL update repeats the unit fence (state, generation,
  lease, runtime session, unexpired lease) and the request's version and state
  in its `WHERE` clause.
- **Claim rules.**
  - The unit must be assigned to the authenticated connection in this project,
    and claimed live in this runtime session with exactly this generation and
    lease.
  - The request must be addressed to this connection *and* this unit, have
    this exact version and be unexpired.
  - Its target, source and criteria references must be readable at their
    exact versions now.
  - Accepted stored states are `queued`, `deferred`, and `claimed` with a
    `claimed_generation` that differs from the unit's live generation. The last
    case is a claim lost through expiry, release or reassignment: it is pending
    again and can be re-claimed under the new generation.

  The update sets `claimed_generation` to the live generation, increments the
  version and clears any deferral reason, boundary and dependency.

  The refusal codes are:
  - a request already claimed under the live generation:
    `COWORK_REQUEST_CLAIMED`;
  - a terminal request: `COWORK_REQUEST_CLOSED`;
  - an expired request: `COWORK_REQUEST_EXPIRED`;
  - an unknown or foreign request, or one addressed elsewhere:
    `COWORK_REQUEST_UNAVAILABLE`, content-free.
- **Respond rules.** The same unit fence and addressing apply. The request must
  be `claimed` with `claimed_generation` equal to the live generation, at the
  exact version and unexpired. A request that is only queued or deferred is
  refused with `COWORK_REQUEST_NOT_CLAIMED`. A lost request claim is refused
  with `COWORK_CLAIM_LOST`.
  - **Resolve.** The request's own references must still be readable at their
    exact versions; otherwise the recipient declines with `source_changed`.
    The injected `publishResponse` step then produces the native response in
    this same transaction and returns its exact reference. That reference must
    be a result/message ID or a versioned material/doc/work/thought, never
    GitHub, and readable now. Otherwise `COWORK_RESPONSE_UNAVAILABLE` rolls
    back the publication too. The request becomes `resolved` with that
    `response_ref`.
  - **Decline.** No publication happens and source readability is not
    required: a decline is content-free. The request becomes `declined` with
    its reason.

  The unit's own claim is unchanged; releasing or completing it is a separate
  command. Resolution does not mark the task done, approve a PR or satisfy a
  current-version gate.
- **Publication authority (open, peer review).** The production
  `publishResponse` provider is #154's actor-aware contribution primitive. It
  is not implemented here. Public composition stays disabled until that
  provider is wired and independently verified. Passing a fixture provider is
  not its implementation. "No separate transaction may publish a response and
  later try to mark it done" is kept: the response and the resolution commit
  together. Which grant authorizes the publication itself is still open: a
  second native operation scope in the same command, or a respond grant that
  covers publication. `cowork.request.respond` alone must not become a general
  publication right.
- **Supersession.** A `cowork.request` admission that *creates* a request
  supersedes, in the same transaction, every earlier request that matches all
  of the following:
  - the same lineage, the same sender connection, the same recipient unit and
    the same kind;
  - stored state `queued` or `deferred`.

  Each such request becomes `superseded` with reason `newer_request` and a
  version increment, and its IDs are returned in the admission outcome. The
  rules around it are:
  - A `claimed` request is never superseded: an in-flight review keeps its
    history, but cannot satisfy a current-version gate.
  - An `existing` (re-issued) intent supersedes nothing.
  - Supersession refunds no lineage budget.
  - It runs after the request insert, under the sender and recipient slots
    already held. A concurrent request claim (which also holds the recipient
    slot) therefore serializes with it: whichever commits first wins, and the
    other sees the committed state.
- **Refusals.** Every refusal throws a typed domain error inside the caller's
  transaction. The request row is unchanged, and no response, grant use or
  receipt survives.
- **Replay.** The same command ID and fingerprint replays the original receipt
  as an observation. There is no fence, request change, publication or debit.
  Current authorization is still rechecked, and so is the unchanged canonical
  post-state, which covers:
  - the request version and state, its recipient and unit;
  - the unit's assignment and role;
  - for a `claimed` post-state, `claimed_generation` equal to the unit's
    current generation.

  Readability is also rechecked: the request references for claim and resolve,
  and the response for resolve. A decline observation is content-free. Later
  outcomes behave as follows:
  - Historical lease expiry alone leaves the rows unchanged, so the claim
    receipt can still be observed.
  - A unit release or re-claim changes the generation, so the claim receipt
    becomes `COMMAND_POSTSTATE_STALE`.
  - A later resolution, decline or supersession also makes earlier receipts
    stale.
- **Recovery visibility.** The pending projection already treats a `claimed`
  request whose generation, lease, assignment or unit state no longer matches
  as `queued` with `claim_lost`. Re-claiming under the new generation shows it
  `claimed` again. Resolved, declined and superseded requests leave the
  pending recovery page and the ready candidates. A request past its expiry
  stays visible in recovery as `expired` (`request_expired`) and is not a
  ready candidate. The sender still sees the outcome through the request row;
  its admission receipt becomes stale once the state changes.

Out of scope here: the production publication provider and its grant,
scheduling, checkpoint production, reviewer eligibility, the #238 fence, the
#74 GitHub recipient adapter and MCP exposure. Unit creation is specified in
the next section.

### Unit creation (2026-10-05, peer review required)

`coWorkUnitCreateInTransaction(tx, claims, command, policy)` is the internal
caller-owned composition that creates work units. Until now only test fixtures
inserted units, so claims and requests could not be used. It is not a public
tool, and MCP exposure stays disabled until #152/#160 wire it.

Authority comes from the owner's standing grant to the agent connection, used
by the agent's own command through #152 `prepare`/`complete`. There is no new
owner HTTP endpoint; owners keep using the existing grant API.

- **Operation.** `cowork.unit.create` is a new #152 registry operation and
  needs its owner's acceptance. Migration `0050` widens the closed grant
  operation list with exactly this one operation.
  - `objectId` is the native task the unit is for. `prepare` checks that it
    is a task in this project, as for `work.update`.
  - A grant with an exact target names that task.
  - The class is the role of the unit being *created*. For example, the
    author of a task holds a `review`-class grant to open a reviewer's unit.

  The grant gives the creator no claim on the new unit. It gives the assignee
  no authority either: the new unit is queued intent, like a request's
  recipient. To claim it, the assignee still needs its own `cowork.claim`
  grant of that class from its own owner.
- **Payload (exact keys).**
  `{ unitKey, expectedTaskVersion, assignmentConnectionId, parent }`.
  - `unitKey` is the intent key, matching `^[a-zA-Z0-9_:.-]{1,200}$`.
  - `parent` is `null` for a root unit. For a child unit it is
    `{ unitId, generation, leaseId }`: the creator's live claim on a unit of
    the same lineage.

  Extra fields are refused before any write. So are lineage, run, state,
  budget or authority fields and copied prompts.
- **Root.** A root unit opens a new run on the task, with
  `work_id = lineage_work_id = objectId`.
  - The server derives the run ID from the creator connection, the task and
    `unitKey`. The same intent therefore always maps to the same run, and the
    existing unique key (task, run, `unitKey`) deduplicates it in the
    database.
  - The assignee must be the creator itself, because only a run's own
    assignee opens it. Otherwise the code is `COWORK_ASSIGNMENT_REFUSED`.
  - `COWORK_UNIT_TAKEN` refuses the root while any other open unit with
    this role exists on the task, in any run. Open means `pending`, `claimed`
    or `paused`, so a paused unit also blocks; moving it is a transfer, which
    is a separate command.
  - The rule is checked under the task row lock. It is the atomic guard
    against two connections taking the same task, and for `plan` units it is
    the sole plan-writer guard.
- **Child.** The parent unit must be assigned to the creator in this project
  and be on the same task (`objectId`). Otherwise the code is
  `COWORK_UNIT_NOT_FOUND`. The creator must hold the parent's claim live in
  this runtime session, with exactly this generation and lease, at fresh
  database time; otherwise the code is `COWORK_CLAIM_LOST`.
  - The new unit inherits the parent's `lineage_work_id` and `run_id`. It
    cannot open or borrow another lineage.
  - It may be assigned to another connection.
- **Assignee.** The assignee must be a live, unrevoked connection of this
  workspace that has this project selected and holds the
  `flux.action.execute` scope. Otherwise the code is
  `COWORK_ASSIGNEE_UNAVAILABLE`, which is content-free.
  - Its connection row is locked `FOR SHARE` before any slot. A concurrent
    revocation therefore either commits first, so creation is refused, or
    waits and then stops the new unit with its trigger.
- **Separation.** Within one run, the assignee of a review unit is never the
  assignee of an execute unit, and the reverse also holds
  (`COWORK_REVIEW_SEPARATION`).
  - Under the server-owned `distinct_owner` policy, their owners must differ
    as well.
  - A connection that has been deleted has an unknown owner, so the check
    fails closed.
  - Admission still applies its own review separation to each request.
- **Task fence.** The task must be at `expectedTaskVersion`, or the code is
  `COWORK_VERSION_CONFLICT`. It must not be `done` or `not_pursued`, or the
  code is `COWORK_TASK_CLOSED`. Creation never changes the task row, its
  status or its human assignee.
- **Bounds.** The server-owned `maximumRunUnits` (1–64) caps the units of one
  run. The count is taken under the lineage root task lock and is never
  refunded (`COWORK_BUDGET_EXHAUSTED`). Every created or re-issued unit spends
  one grant use. Creation never creates a request lineage, request, delivery
  intent, claim or capacity.
- **Lock order.** The order is:
  1. #152 `prepare`;
  2. the assignee's connection row, `FOR SHARE`;
  3. the sorted, de-duplicated creator and assignee connection slots;
  4. the sorted project graph locks (#171) and direct prerequisites;
  5. the complete sorted native task set: the task, the lineage root and
     those prerequisites;
  6. for a child, the parent unit row;
  7. fresh `clock_timestamp()`, which fences the parent's lease;
  8. the insert, or the read of the existing unit for the same intent;
  9. the post-state hook and `complete`, then the caller's single final
     event flush.

  Nothing locks a graph or task after a unit row.
- **Post-state.** A new kind, `cowork.unit_state`, has the fields
  `{ workspaceId, projectId, unitId, taskId, lineageTaskId, runId, role,
  assignmentConnectionId, version, state }`.
  - It is bound to the command: `taskId` is `objectId` and `role` is the
    class.
  - `assignmentConnectionId` may differ from the acting connection. The
    receipt itself records the creator.
  - The hook rereads the canonical unit under the retained locks. A missing
    hook fails closed.
- **Duplicates and replay.** The same command ID and fingerprint replays the
  original receipt as an observation. There is no fence, insert or debit.
  Current authorization and the unchanged canonical post-state are rechecked.
  Once the unit changes (claimed, renewed, released or stopped), the old
  receipt is `COMMAND_POSTSTATE_STALE`.

  A new command ID with the same intent returns the existing unit after the
  same fences, as `status: 'existing'`, and spends one grant use. The same
  intent means the same task, creator and `unitKey` for a root, and the same
  run and `unitKey` for a child. If the role, assignment or lineage differs,
  the code is `COWORK_UNIT_CONFLICT`. Nothing new is created, so the
  `TAKEN`, cap and separation rules apply only to a new unit.
- **Refusals.** Every refusal throws a typed domain error inside the caller's
  transaction. No unit, slot row, grant use or receipt survives it.

Out of scope here:

- decomposing a plan into new native tasks (the rest of AC-1);
- reassignment and transfer;
- unit completion;
- scheduling;
- the #238 fence;
- MCP exposure and #160 Start/Resume;
- the Agents UI.

Completion and transfer are specified in the next section, MCP exposure in the
one after it.

### Unit completion and transfer (2026-10-05, proposed amendment, peer review required)

`coWorkUnitTransitionInTransaction(tx, claims, command, policy)` is the internal
caller-owned composition with which the current holder of a unit finishes it or
hands it to another connection. It is not a public tool (see the next section
for why).

- **Operations.** This adds two #152 registry operations, which need their
  owner's acceptance. Migration `0054` widens the closed grant operation list
  with exactly these two, and adds the unit's outcome reference (below).
  - `cowork.unit.complete` finishes the holder's unit with an outcome.
  - `cowork.unit.transfer` reassigns it to another connection.

  `objectId` is the holder's own unit, and the class is that unit's actual
  role. A grant with an exact target must name a unit assigned to the grantee
  with that role, as for `cowork.claim`. The post-state is the existing
  `cowork.unit_state`. Its target check is now operation-aware: for
  `cowork.unit.create` the post-state's `taskId` is the command target; for
  these two operations its `unitId` is.
- **Payloads (exact keys).**
  - Complete is `{ expectedVersion, generation, leaseId, outcome }`.
    `outcome` is one exact native reference: `{ type: 'result' | 'message', id }`
    or `{ type: 'material' | 'doc' | 'work' | 'thought', id, version }`. A
    GitHub reference is refused until #74 supplies the verified recipient
    adapter.
  - Transfer is `{ expectedVersion, generation, leaseId, assignmentConnectionId }`.

  Extra fields are refused before any write. So are lineage, run, state,
  budget or authority fields and copied prompts.
- **Holder fence.** Both operations need the current holder:
  - The unit must be in this project and assigned to the authenticated
    connection. Otherwise the code is `COWORK_UNIT_NOT_FOUND`, which is
    content-free. A former holder after a transfer gets the same code.
  - The unit must be at `expectedVersion` (`COWORK_VERSION_CONFLICT`).
  - It must be claimed in this runtime session with exactly this generation
    and lease, unexpired at fresh database time. Otherwise the code is
    `COWORK_CLAIM_LOST`. A paused, pending, completed or stopped unit has no
    live claim, so its assignee must claim it again first.
- **Open requests.** While any request addressed to the unit is `queued`,
  `deferred` or `claimed` and unexpired, both operations are refused with
  `COWORK_UNIT_REQUESTS_OPEN`. The holder claims each one and resolves or
  declines it first, so no request is silently left behind. An expired request
  can no longer be claimed or answered and does not block. The check runs under
  the holder's connection slot, which every admission and request claim for
  this unit also holds through commit, and the conditional update repeats it.
- **Complete.** The outcome must be readable now in this project at its exact
  version, by the same rule as request references. Otherwise the code is
  `COWORK_OUTCOME_UNAVAILABLE`. The unit becomes `completed` with that
  `outcome_ref`; the lease is cleared, and the generation and version increase.
  The checkpoint reference is unchanged.
  - Completion is terminal. A completed unit cannot be claimed
    (`COWORK_UNIT_CLOSED`), transferred or completed again. Admission
    therefore refuses a request to a completed or stopped recipient unit with
    the content-free `COWORK_REQUEST_UNAVAILABLE`, since nobody could ever
    answer it. An admission waiting on the holder's slot sees the completion.
  - It does not change the task row, its status or its human assignee. It
    resolves no request, approves nothing and satisfies no current-version
    gate.
  - The outcome is a reference. It does not assert or rewrite authorship: the
    referenced native record keeps its own author.
- **Transfer.** This is direct reassignment by the authorized holder.
  - The assignee must be a live, unrevoked connection of this workspace that has
    this project selected and holds the `flux.action.execute` scope. Otherwise
    the code is `COWORK_ASSIGNEE_UNAVAILABLE`, which is content-free. Its
    connection row is locked `FOR SHARE` before any slot. A revocation that
    commits first therefore refuses the transfer, and one that waits stops the
    transferred unit with its trigger.
  - The assignee cannot be the holder itself (`COWORK_ASSIGNMENT_REFUSED`).
  - The creation separation applies within the run. A review unit never goes to
    the assignee of one of the run's execute units, and the reverse also holds
    (`COWORK_REVIEW_SEPARATION`). Under `distinct_owner` their owners must
    differ, and a deleted connection's unknown owner fails closed.
  - The unit keeps its task, lineage, run, key, role and checkpoint reference.
    Its assignment becomes the assignee and its state `pending`; the lease is
    cleared, and the generation and version increase, which fences the old
    claim.
  - The assignee gains no authority. To claim the unit it still needs its own
    `cowork.claim` grant of that class from its own owner. The former holder
    loses the unit: its later claim, request, response, completion or transfer
    on it is `COWORK_UNIT_NOT_FOUND`, and its earlier receipts on the unit go
    stale.
  - **Not modeled here.** The assignee cannot decline the transfer, so this
    slice does not cover AC-1's "preserves paused prior assignment on decline"
    or CO-2's declined replacement. A later amendment adds an offer/decline step
    that returns the unit, paused, to its prior assignee. Re-addressing open
    requests to the new assignee is not modeled either; they are refused
    instead, as above.
- **Lock order.** The order is:
  1. #152 `prepare`;
  2. for a transfer, the assignee's connection row, `FOR SHARE`;
  3. the sorted, de-duplicated holder and assignee connection slots;
  4. the sorted project graph locks (#171) and direct prerequisites;
  5. the complete sorted native task set: the unit's task, its lineage root and
     those prerequisites;
  6. the unit row, `FOR UPDATE`, located by its ID in this project whatever its
     assignment;
  7. fresh `clock_timestamp()`, which fences the lease;
  8. the conditional update, which repeats the holder fence, the version and
     the open-request rule in its `WHERE` clause;
  9. the post-state hook and `complete`, then the caller's single final event
     flush.

  Nothing locks a graph or task after the unit row.
- **Duplicates and replay.** The same command ID and fingerprint replays the
  original receipt as an observation. There is no fence, update or debit.
  Current authorization and the unchanged canonical post-state are rechecked.
  For a completion, the outcome's readability is rechecked too. Because the
  unit is located by ID, a former holder can still observe its transfer receipt
  until the unit changes again: once the assignee claims it, the receipt is
  `COMMAND_POSTSTATE_STALE`. A completed unit does not change again, so its
  receipt stays observable while its outcome is readable. A new command ID for
  a finished transition meets the changed unit and is refused by the fence.
- **Refusals.** Every refusal throws a typed domain error inside the caller's
  transaction. No unit change, slot row, grant use or receipt survives it.
- **#238 seam.** Completion and transfer are persisted unit uses. When #238's
  lifecycle/use fence lands, it joins at the conditional update, inside the
  same transaction. This slice does not implement that fence.

Out of scope here: the assignee's accept/decline, re-addressing open requests,
stop by the owner, completion or transfer of a unit without a live claim, plan
decomposition, scheduling, the checkpoint producer and the #238 fence.

### MCP exposure (2026-10-05, proposed amendment, peer review required)

Three existing compositions are now project MCP tools. They are registered like
the native action tools, through `tools.forScope('flux.action.execute',
{ operation, classes })`, so `flux_bootstrap` lists each one with its operation
and classes and the playbook names it.

| Tool | Operation | Classes | Composition |
| --- | --- | --- | --- |
| `flux_create_unit` | `cowork.unit.create` | execute, review, plan | `coWorkUnitCreateInTransaction` |
| `flux_claim_request` | `cowork.request.claim` | execute, review, plan | `coWorkRequestResponseInTransaction` |
| `flux_decline_request` | `cowork.request.respond` | execute, review, plan | `coWorkRequestResponseInTransaction`, `outcome: 'declined'` only |

- **One call, one transaction.** Each call is one `db.transaction` that runs
  the composition unchanged. The tool input maps one to one to the exact
  payload above, plus the runtime, grant, class and command ID. `sources` is
  always empty, and the input schema is strict. The tools write no stream
  event, so there is nothing to flush.
- **Server-owned policy.** The MCP path uses `COWORK_UNIT_POLICY`
  (`maximumRunUnits` 16, `reviewSeparation` `distinct_connection`, the
  contract default) from `apps/server/src/co-work/policy.ts`. Tool input,
  client metadata and project content never set it. A project-level choice of
  `distinct_owner` needs its own project-policy amendment.
- **Resolution stays unexposed.** There is no production `publishResponse`
  provider, and which grant authorizes the publication is still an open peer
  question (see "Request claim and resolution"). The decline tool's schema
  admits only `declined`, and its composition receives a provider that always
  refuses with `COWORK_RESPONSE_UNAVAILABLE`.
- **Not exposed yet:** unit claim, renewal and release (their role eligibility
  and checkpoint providers are not implemented), request admission, recovery
  and the inbox, completion and transfer. As a result, an MCP client cannot yet
  obtain a live unit claim on this server:
  - `flux_claim_request` and `flux_decline_request` refuse with
    `COWORK_CLAIM_LOST` until the unit claim tool exists;
  - `flux_create_unit` can open a root unit, and a child needs a live parent
    claim.

  `flux_bootstrap` therefore still reports `coordination_unavailable`, and
  playbook 1.2.0 says which parts exist.

  The next section closes this gap for unit claim, renewal, release,
  completion and transfer. Request admission, recovery and the inbox stay
  unexposed.

### Unit claims over MCP (2026-10-06, proposed amendment, peer review required)

An MCP client can now hold a live unit claim. Five more existing compositions
become project MCP tools, registered through the same
`tools.forScope('flux.action.execute', { operation, classes })` path as the
previous section's tools.

| Tool | Operation | Classes | Composition |
| --- | --- | --- | --- |
| `flux_claim_unit` | `cowork.claim` | execute, review, plan | `coWorkClaimInTransaction` |
| `flux_renew_unit` | `cowork.renew` | execute, review, plan | `coWorkClaimInTransaction` |
| `flux_release_unit` | `cowork.release` | execute, review, plan | `coWorkClaimInTransaction`, with a checkpoint draft |
| `flux_complete_unit` | `cowork.unit.complete` | execute, review, plan | `coWorkUnitTransitionInTransaction` |
| `flux_transfer_unit` | `cowork.unit.transfer` | execute, review, plan | `coWorkUnitTransitionInTransaction` |

- **Same rules as the previous section.** One call is one `db.transaction`
  that runs the composition unchanged. The input schema is strict, and the
  tools write no stream event. Each operation, its payload and its grant are
  the existing ones, so this adds no operation and no migration: `0056` is not
  used, and `FLUX_SCHEMA_VERSION` stays 54.
- **Server-owned claim policy.** `COWORK_CLAIM_POLICY` sits in
  `apps/server/src/co-work/policy.ts`. Tool input, client metadata and project
  content never set it.
  - `maximumConnectionUnits` is 1. CW-3 sets one active unit per connection by
    default. More capacity needs its own grant, which does not exist yet.
  - `leaseSeconds` is 300, the composition's upper bound. A client renews
    before the lease ends.
  - Its three providers, below, are the production implementations. Tests
    that pass fixture callbacks no longer stand in for them.
- **Graph locks (`prepareTaskLocks`).** This is the #171 provider that
  creation, admission and transitions already use (`coWorkTaskGraphLocks`).
- **Role eligibility (`requireEligible`).** It runs after the complete task
  and unit locks. It reads the locked task row and takes no lock.
  - **Claim and renew.** The unit's task must exist in this project and must
    not be `done` or `not_pursued` (`COWORK_TASK_CLOSED`, the creation rule).
    For an `execute` unit, every direct prerequisite must also be done and
    unparked now (`requireTaskPrerequisitesMet`, `TASK_PREREQUISITES_UNMET`).
  - Renewal repeats the check. If the task closes or a prerequisite reopens
    while a claim is held, the next renewal is refused. The holder can still
    release with a checkpoint, or complete, while its lease is live.
  - `review` and `plan` units have no prerequisite rule: reviewing or planning
    unfinished work is allowed. Reviewer/author separation is enforced when a
    unit is created or transferred, and is not repeated here.
  - **Release.** There is no eligibility check: a holder can always park its
    work under a live claim.
  - **Replay.** There is no eligibility check either. A replay is an
    observation: it creates nothing and resumes nothing. Current authorization
    and the unchanged post-state are still rechecked.
  - A parked task itself is not refused, as at creation (open question below).
- **Checkpoint producer.** `cowork.release` now has two exact payload forms:
  - the existing `{ expectedVersion, generation, leaseId, checkpointId }`,
    which names a checkpoint already persisted for this live claim;
  - the new `{ expectedVersion, generation, leaseId, checkpoint }`, where
    `checkpoint` is the draft `{ summary, nextAction, blocker }`.

  The draft holds observable facts only. `summary` (1–2000 characters) is the
  observed progress, the changed artifacts and the checks actually run.
  `nextAction` is 1–500 characters, and `blocker` is null or 1–500 characters.
  Its keys are exact, so a copied prompt, a transcript or an authority field is
  refused.
  - The core holder fence runs first (unit, version, live claim). Then the
    composition inserts the checkpoint under the same live fence, with
    `insertCheckpoint`'s conditional insert and a server-generated ID, and
    releases with it. A refused release rolls the checkpoint back with
    everything else.
  - The stored `progress` is typed: `{ schema: 'flux.cowork.checkpoint/1',
    summary, nextAction, blocker, sources }`. `sources` is exactly the
    command's prepared `sources` (material ID and version), which #152
    `prepare` locked `FOR SHARE` and found current. The client does not assert
    coverage separately.
  - The MCP release tool offers only the draft form.
  - Not modeled as typed fields: the deferral reason and boundary, artifact and
    check references, and a recovery cursor. The summary can name them. Typed
    fields can be added later.
- **Checkpoint sources (`requireCheckpointSources`).** The stored progress must
  be `flux.cowork.checkpoint/1`. Otherwise the checkpoint is reported as
  `COWORK_CHECKPOINT_NOT_FOUND`, so an untyped row is never shown.
  - **Release and its replay.** The checkpoint is the one being released.
    Every recorded source must be among the command's prepared sources at the
    same version (`COWORK_CHECKPOINT_SOURCES_REQUIRED`). #152 `prepare` and
    `complete` hold those rows and require them current, so no late lock is
    taken.
  - **Claim, renew and their replays.** The checkpoint is historical. Each
    recorded material must still exist in this project, although its version
    may have moved on. This is a plain read with no lock. Otherwise the code is
    `COWORK_CHECKPOINT_NOT_FOUND`, which is content-free. Project access itself
    is checked by #152 (`project.write`, under lock).
  - This replaces, for historical checkpoints only, the rule in "Caller-owned
    claim execution composition" that the claiming command must include the
    checkpoint's source coverage. A client cannot know a historical
    checkpoint's sources before it holds the claim. Requiring the recorded
    version would make a paused unit unclaimable after any edit to one of its
    sources, because only a release writes a checkpoint.
- **Claim output.** `flux_claim_unit` returns the claim outcome plus the
  unit's current checkpoint, or null. The checkpoint is read in the same
  transaction, after the checks above, as `{ id, summary, nextAction, blocker,
  sources, createdAt }`.
  - This is how a resumed holder, or a new holder after a transfer, reads where
    the work stopped. It can compare the recorded source versions with
    `flux_changes_since`.
  - The receipt stores only the claim outcome. A replay rereads the checkpoint
    under the same checks.
- **Completion and transfer** map one to one to "Unit completion and
  transfer", with `reviewSeparation` from `COWORK_UNIT_POLICY`. The complete
  tool's `outcome` admits only the native reference types.
- **Still not exposed:** request admission, recovery and the inbox, and
  resolution with a response.
  - `flux_bootstrap` therefore still reports `coordination_unavailable`.
    Playbook 1.2.0 now says that this gap covers only those parts.
  - A connection learns the ID of a unit that another connection created for it
    (a child unit) only through the inbox or recovery tools, which do not exist
    yet.
- **Open questions (peer review).**
  - Should a parked task refuse new claims?
  - Should the claim policy's capacity of 1 become a grant-backed capacity
    before #160's clients hold an execute unit and a review unit at once?

### Parent request participation

### Parent request participation

A child request can name a parent only when its exact sending connection is
the parent's recorded sender or addressed recipient. The original sender may
follow up and the recipient may respond. Sharing an owner, project, root task
or run does not make another connection a party. Refusal returns the same
content-free unavailable outcome as an absent parent, with no new request,
delivery intent or lineage budget debit. This storage guard supplements the
unchanged current-source authorization and live sender-claim requirements of
the admission composition; it does not grant either party new authority.

Status: implementation contract checkpoint, 2026-09-30. The shared boundaries
were accepted by the independent owner of #152/#154/#160 in
[issue #153](https://github.com/ColdPhase/flux/issues/153#issuecomment-5919388071).
This document does not implement or certify a client loop. All original #153
criteria and real-client acceptance remain required.

Product requirements are [F-016](../product/mcp-cowork.md) and
[CW-1–CW-5](../product/cowork-workflow.md). Flux stores shared tasks, content and
coordination; model/code execution remains in the connected owner's local client.
There is no server model polling, fallback payer or second conversation store.

## Ownership and first integrated flow

Zamojski5 owns #153 and its `claude-maurycy/153-cowork` branch. PelikanFix16
independently evaluates it and owns connection/grant/bootstrap #152, built-in
client workflow #160, task contributions #154 and GitHub binding #74. #136
integrates the Agents presentation. Do not write those owners' active branches.

The first complete flow is an existing native task, an immutable non-code
result, an addressed review, busy-peer deferral, a safe checkpoint and claim,
findings, a corrected result, a fresh review and a cold-context Resume. It must
use two owners and three named real supported client connections. A Docker
fixture can verify server invariants but cannot prove supported Codex/Claude
activation, instruction loading or zero idle model calls. Built-in Start/Resume
must supply the workflow: user README reading, prompt copying and manual skill
installation do not satisfy acceptance.

This flow does not replace code→PR→review→fix→current checks/eligible
approval→merge, concurrent plan decomposition, transfers or remaining #153
criteria. They remain subsequent parts of the same issue.

## Authenticated effect context

#152 constructs the context outside message content: owner, connection, agent,
client/runtime session, workspace/project, current grants and policy/playbook
compatibility. Browser session, MCP transport session and runtime work session
are distinct. A later browser project selection cannot retarget this context.

The core-owned authorization port revalidates the current connection, selected
project, operation/request class/audience, expiry/revocation and policy inside
the transaction that commits an effect. Execution and review grants are
distinct. A sender-selected recipient, incoming request, receipt or bundle ACK
never grants authority. #153 consumes this port rather than adding parallel
grant/bootstrap storage or trusting owner/grant fields supplied in tool input.

Read, replay, recovery, source packet download and mutation must all check
current access. Unavailable/private targets must not leak titles, snippets,
owner rosters or inaccessible-project counts. Security restrictions block
server effects immediately; they do not wait for a model checkpoint.

## Coordination records

These are control metadata and references to native domain content:

| Record | Required identity and invariants |
| --- | --- |
| Addressed request | Stable request/root/causal and client-command IDs; one server-resolved recipient connection; native task and original contribution references; exact target artifact; criteria; bounded lineage/retry/round budget; state/version and reason. |
| Work unit | Stable task/run/unit and assignment identity; execution/review/plan role; generation, runtime session and DB-clock lease; exact review target; checkpoint reference. Artifact authorship is immutable once published. |
| Checkpoint | Actual progress, authorized source/version coverage and gaps, artifact/check references, blocker or deferral reason, next action/boundary and recovery cursor. It contains no copied prompt, model reasoning transcript, wiki or conversation. |
| Durable command receipt | Connection/context-bound command identity and fingerprint; original outcome references. It survives the transport idempotency cache and cannot recreate an effect after cleanup. |
| Recovery cursor | Opaque connection/project-bound position plus server pending state; bounded authorized page/snapshot and an explicit gap/resync marker. It is not a raw global event sequence. |

Request state is independent of task status, delivery ACK, availability and
review verdict. `queued` and `deferred` remain pending. `claimed` requires an
eligible fenced lease. `resolved` requires committed domain response/evidence;
ACK is never completion. Decline, supersession, expiry and cancellation have
explicit reasons and do not turn an unfinished task into success. A lease loss
returns unresolved work to recoverable pending state with a new generation.

Same command ID and fingerprint returns the original effect; a changed payload
conflicts. Tombstones/correlations must prevent a late retry from recreating a
request after HTTP-cache or delivery-log retention. Pending work is not deleted
because it was delivered or its cursor compacted.

## Native contributions and transaction composition

#154 owns the canonical task contribution primitive and its transaction-bound
database adapter. Its current human-text incremental API is not an agent-author
API; #153 must wait for the pinned actor-aware handoff before consuming it for
agent results or findings. No code may publish an agent contribution as its
human owner to work around this dependency.

The primitive returns the actual task/conversation/root/message/result identity.
Current `WorkResult` records are immutable: pin their exact ID, not an invented
version. Versioned materials use their actual ID/version. A corrected immutable
result has a new identity, invalidating dependent request/verdict eligibility.
Past authorship and history stay intact. A review never substitutes for eligible
GitHub approval or accepts a decision reserved for humans.

The outer unit of work commits authorization, durable command identity, fenced
coordination transition, native contribution/result, resolution and addressed
outgoing intent together. A crash or failed check before commit leaves none of
those partial effects. A lost response after commit replays that same effect.
No separate transaction may publish a response and later try to mark it done.

Accepted lock order is current access/connection-grant rows, durable command
identity, sorted task IDs, then conversation sequence; domain changes precede
final stream writes. #153's unit/connection-slot fencing must compose with this
order. The current HTTP idempotency adapter locks its command key before domain
authorization and retains responses for only 24 hours; it is not the durable
coordination receipt or the outer transaction wrapper. Coordination adapters
must use the accepted order and reauthorize original outcomes on every replay.
The concrete shared [execution boundary](https://github.com/ColdPhase/flux/blob/47d0ea92a5888e786442f84b42287b4ce9336c7c/docs/development/agent-connection/2026-09-30/execution-boundary.md)
uses #152's transaction-bound `AgentExecutionPort.prepare/complete` and one
connection/command ledger. #153 supplies canonical claim postconditions; no
separate receipt transaction or grant-use store is introduced. Operations are
`cowork.claim`, `cowork.renew`, `cowork.release`, with the exact actual unit role
`execute`, `review` or `plan` as the request class.

Native contribution adapters currently write stream events immediately. The
stream sequence trigger retains its serialization lock until commit; a composed
co-work transaction must defer those event writes until its request, receipt,
claim and outgoing-intent rows are complete. #154/#153 must agree the concrete
transaction-bound event-intent boundary before the actor-aware consumer is wired. Revoke versus publish, renewal versus
expiry and reassignment versus late result need actual PostgreSQL race evidence
before acceptance.

## Core ports and consumers

The `core/co-work` module depends on contracts and core-owned ports. It imports
no SQL, Drizzle, pg-boss, HTTP or client SDK and adds no architecture exemptions.
Server/worker composition supplies transaction-bound adapters.

| Port responsibility | Required behavior |
| --- | --- |
| Current authorization/context | #152 supplies trusted context and transactional grant/access/compatibility checks. |
| Claims and slots | One active author per logical unit; generation/session/DB-time fencing before every domain effect; one active unit across roles/sessions by default; additional capacity requires an explicit current grant. Two sessions do not evade a connection slot. |
| Addressed requests and receipts | Atomic deduplication, versioned transitions, exact target supersession, durable pending state and one recipient. |
| Checkpoint/recovery | Bounded current-authorized pending replay and snapshots after context loss or cursor gaps; last checkpoint and active claim facts remain distinct. |
| Task contribution/artifact | #154 publishes truthful canonical actors/content inside the outer transaction; exact immutable or versioned target references. |
| Delivery intent | A durable outbox intent commits with its request. Delivery is at least once; a hint/ACK/renewal adds no ordinary unread chat event and invokes no model. |

For slot-changing commands, extend the agreed lock order with sorted connection
slots before sorted native tasks, then sorted request/unit rows. Inspect the
expired slot's task identity first and lock the complete task set; do not acquire
an additional task after contribution or stream publication. Transfer locks both
connections in the same order. Lease and grant expiry use fresh database wall
clock after waiting for locks (`clock_timestamp()`), never transaction-start
`now()` or a client timestamp. Renewal cannot resurrect expired authority.

A unit's versioned publication binding identifies the current exact artifact and
its actual publishing connection. Immutable result IDs themselves have no
version. Changing the binding atomically supersedes dependent requests; old
reviews remain history. Two connections sharing one agent ID do not become the
same author merely because the domain row has only agent provenance.

HTTP and supported MCP adapters call the same use cases. Their public names and
bootstrap surface are coordinated with #152/#160, not declared by a separate
#153 tool registry. The bounded surface covers recover/inbox, request creation
and deferral, claim/renew/checkpoint/release, response publication/resolution and
authorized transfer/stop. Claim and publish require current expected versions,
generation, runtime session and lease; a checkpoint is not permission to
publish after losing the claim.

Before-artifact transfer retains task/run, pauses the prior assignment and
fences it before a replacement can work. Decline does not resume that old
client. After publication, transfer cannot rewrite the artifact author. Stop
immediately forbids new effects; local cancellation requested and acknowledged
remain separate facts.

## Safe scheduling and recovery

An ordinary peer request must not interrupt current work. The non-LLM adapter
can receive or defer it with a reason; at a bounded safe boundary the client
checkpoints/releases incompatible work and handles eligible peer-unblocking
requests. Aging/fairness and bounded rounds prevent starvation and reciprocal
waiting while both connections hold incompatible slots. A request ID change
cannot reset a lineage budget.

No ready work means bounded non-model wait, or a truthful paused/offline state.
Notifications are hints to drain the durable queue. There is no periodic model
turn scanning all GitHub issues, PRs or comments. A closed/unsupported client
stays queued or blocked with a capability reason. Real adapter versions and
traces must prove checkpoint behavior, loaded Start/Resume instructions and
zero idle model calls; server mocks do not prove them.

## Migrations and verification

The accepted reservations are #58 `0026–0032`, #154 `0033`, #152 `0034`,
#153 `0035`, #74 `0036`, and #154's actor extension `0037`. #153 proposes
`0049` for the request claim/respond grant operations and `0050` for the unit
creation grant operation. Both must be reserved on #153 before their branches
are pushed. `0054` (proposed 2026-10-05; 0051 is on main for #257 and 0052–0053 are reserved elsewhere) adds
the unit completion/transfer grant operations and `cowork_units.outcome_ref`;
it too must be reserved on #153 before its PR is opened. Unit claims over MCP
(2026-10-06) need no migration; `0056` stays unused.
The human-only `0033` checkpoint is frozen; it does not supply agent authors.
Do not edit already merged migrations. #153 must
compose with #152's real identity/grant storage, #154's actual contribution
schema and both migration arrival orders; a guessed foreign table is not a
working dependency. Test exact image ledger, upgrade/backup/recovery and current
schema declarations with the accepted composed candidate.

Required focused checks include:

- PostgreSQL races between claims/sessions, expiry/renewal, reassignment/late
  publish and revocation/commit; exactly one winning effect and no partial root,
  message, outgoing request or resolution.
- Lost response/ACK, duplicate request and replay after transport-cache cleanup;
  stable effect identity and changed-payload conflict.
- Two owners, three connections and two projects; guessed IDs/cursors, same-agent
  connection isolation, revoked/expired authority, restricted sources and
  self-review denial. Explicit same-owner review policy still requires a
  distinct non-author connection and its review grant.
- Cold-context/process recovery, compacted cursor, retention, stale artifacts,
  policy changes, busy-peer deferral, fairness and lineage exhaustion without
  model wakeups or fabricated completion.
- Actual built-in supported Codex/Claude flow and truthful shared task/UI history;
  no-agent work and inert export/import history without credentials, active
  grants, leases or resumed execution.

Run application checks in isolated Docker projects with separate ports/volumes.
Record only executed checks at their tested head. Backend, real-client and UI
readiness remain separate until the complete integrated flow passes independent
review; neither this contract nor a green fixture closes #153.

## Current implementation increment

The core `co-work/claims` module implements claim, renewal and checkpoint-backed
release behind one transaction port. It normalizes durable command identities,
checks the requested unit/tenant/project/assigned connection, and fences session,
version, generation, lease and expiry. Release leaves work paused and unfinished;
retry returns the original effect without creating another lease. Replay
requires current unit version, generation, assignment, lease/session identity,
expiry value and checkpoint reference to match its original produced post-state;
checkpoint source access is rechecked. Historical lease expiry alone does not
prevent observing an otherwise unchanged effect. Intervening renewal, release,
reassignment or checkpoint change makes the receipt stale. Historical
receipt state is not current readiness: consumers must recover current claim
facts before further work, and every subsequent effect must pass its own fence.

The storage adapter below implements SQL slots/units/checkpoints, but this
increment has no integrated authorization/receipt unit of work, public MCP
endpoint, grant storage, response publication or supported-client scheduler.
The composition must provide the actual
current role/assignment/session authorization, durable fingerprints and receipts,
connection-wide capacity, fresh wall time, atomic checkpoint/request updates and
conditional SQL fencing described above. Those composition dependencies remain
implementation work; in-memory port tests do not prove database concurrency or
real clients.

## SQL storage increment boundary

Migration `0035` introduces connection slot mutexes, native-task-bound units
and canonical checkpoints. It references the existing stable connection/project/
work tables, not guessed #152 grant/runtime columns. The slot mutex is separate
from access/grant rows so taking it never upgrades a shared authorization lock.
After current authorization and command preparation, storage locks the connection
slot, the complete sorted native-task set for the requested unit and existing
claims, then sorted unit rows. Capacity covers all roles/sessions/projects for
that connection. Expired leases do not occupy capacity; their old generations
still cannot publish. Conditional writes use fresh DB wall time and return the
actual persisted deadline, which becomes the canonical receipt post-state.

Checkpoint identity retains its unit, generation, connection and runtime session.
A release references a currently readable persisted checkpoint, never a guessed
identifier. Historical checkpoint references survive later claims; they do not
make a past lease active. Database foreign keys enforce tenant/project/native
unit association. The composition root supplies current source access and grant
checks. SQL storage tests prove storage races and fences only; they do not replace
the pending real #152/#154/runtime/client integration.

Connection IDs on units and checkpoints are immutable historical provenance,
not credential foreign keys. Deleting a connection must neither erase that
history nor be blocked by it. Only the operational slot cascades with the live
connection. Revocation/deletion fences all unfinished units, clears their leases
and marks them stopped under connection → slot → sorted tasks → sorted units
locks. Completed/stopped history is unchanged; nothing is reassigned or resumed.
Current #152 authorization still precedes every new effect; an inert identifier
does not establish live authority. Bulk lifecycle transactions may be retried
after a database deadlock, but cannot commit a partial fence. This storage hook
does not emit chat/stream events or invoke a model.

Claim/renew retain the prior checkpoint reference. Release requires a non-null
checkpoint matching the original live unit, tenant, project, connection,
generation and runtime session in its conditional SQL write, in addition to
current source authorization supplied by the composition root.

## Addressed request storage increment

A lineage belongs to the original canonical native task/run. Its request/depth/
review-round ceilings are bounded policy values, separate from #152's grant-use
budget. A request-ID or intent-key change cannot create a fresh budget for the
same task/run. Child requests inherit their actual persisted parent's lineage;
deleting or acknowledging delivery never releases budget. The first lineage
ceilings cannot be raised by a later caller; lowered current policy also applies.
Every unit has its canonical original native-task/run binding at authorized
creation. A child unit may explicitly inherit that binding; an enqueue cannot
select some unrelated parent to borrow its budget. Current policy may later
expand again within the immutable initial ceilings; narrower policy is checked
at each command, not treated as a permanent historical revocation.

Each request records one connection recipient, its original native task/unit,
canonical source/target/criteria references, parent, depth, round, priority,
expiry and versioned state. Results/messages use their real immutable IDs;
materials/docs/work/thoughts pin actual versions; GitHub references carry verified
binding/link/head identity. No title, message body, prompt, credential, URL or
provider prose is copied into these control records. One lineage/intent key
retains its original normalized fingerprint forever; changed reuse conflicts.
The request and one outgoing delivery intent are inserted in the same transaction.

Storage is transaction-bound and invoked only after #152 current sender/recipient
scope, grant and source authorization, command preparation, sorted connection
slots, and the complete sorted native task set. Parent-root task identities must
be gathered before those locks. The request storage then locks its lineage and
request rows. It adds no grant/receipt ledger or model invocation. A pending
request does not claim/preempt its unit. Transport ACK marks only its delivery
intent and never changes request/task state or removes recovery work.

Recovery storage returns a bounded addressed snapshot; the composition root
reauthorizes all referenced sources for this exact recipient before presenting
any record and signs/validates a connection/project-bound opaque continuation.
The continuation must be encrypted or server-held; signing a readable encoding
of skipped private IDs or scheduling scores does not make it opaque.
Its internal chronological key preserves PostgreSQL microseconds as timestamp
text, rather than round-tripping through JavaScript Date milliseconds.
No global event sequence or inaccessible-project count is a public cursor.
Pending rows survive transport retention and ACK. Claim loss is presented as
pending recovery, not completion. Priority plus capped aging lets old ordinary
requests outrank newly arriving blockers. A deferred reason and concrete next
boundary remain durable. Request claim/resolution, source supersession,
cursor-gap resync and final authorization composition are subsequent parts of
the same unchanged contract, not certified by the initial enqueue/ACK snapshot.
Claim-ready candidate scans exclude every currently live claimed unit and have
bounded ranked pagination at one server-selected aging time. A caller can keep
scanning after inaccessible sources without repeatedly returning the same first
page. Security/expiry and claim fences still use fresh wall time on each page
and each effect; an old ranking snapshot never extends authority.
The internal ranked cursor binds its aging interval and exact workspace/project/
recipient as well as the ranking time and PostgreSQL timestamp tuple. Changing
those scan parameters rejects continuation rather than silently skipping work.
The public adapter must still supply an opaque, current-authorized continuation.

#74 currently exposes undelivered provider references only. Its recipient needs
its own verified repository access at delivery; stored native publications need
provenance-aware current-reader gates as well. This storage does not activate
that adapter or publish private GitHub facts into existing conversations/events.
No ordinary standing-rule click substitutes for those gates.

## Caller-owned claim execution composition

The server's internal `coWorkClaimInTransaction(tx, verifiedClaims, command,
policy)` binds the existing core claim/renew/release commands to #152's actual
`agentExecutionInTransaction` preparation/completion and sole command ledger.
It opens no new transaction, model call or final event flush. Only prepared
server runtime identity constructs the co-work context. Claim payload fields
are exact bounded version/fence/checkpoint inputs; copied prompts, policy or
capacity overrides are rejected. Actual unit role must match the grant class.
Owner grant creation composes a content-free canonical unit target reader: the
exact workspace/project/assigned connection and role must match before a grant
with `objectId` can be created. Missing or mismatched targets stay unavailable;
the owner API never substitutes a broader grant. This adds no claim or tool
activation and retains the existing central owner/project-management checks.

Its server-owned policy is mandatory: before the first native task lock it must
lock the complete sorted relevant project graphs and return every dependency
task; after the retained task/unit locks it checks role-specific current
eligibility. Replay is explicitly an observation, not permission to resume.
The complete task set includes every retained claim's task and canonical
lineage root, including other projects. Public composition remains disabled
until the actual shared graph/role/checkpoint providers are implemented and
independently verified; passing fixture callbacks is not their implementation.
The production providers and their MCP exposure are proposed in "Unit claims
over MCP" (2026-10-06), pending that independent verification.

Release requires the actual scoped checkpoint's current connection/generation/
original runtime fence. Historical checkpoints from earlier assignees remain
readable only under current same-unit/source authorization; historical
connection identity is not an authority requirement. Source coverage must be
included in the original prepared command, locked before graph/tasks and
rechecked without acquiring late upstream material/version locks. An incomplete
coverage or changed source fails closed. A typed checkpoint producer/schema
and complete current source adapters remain required unfinished work. The
2026-10-06 amendment adds the typed `flux.cowork.checkpoint/1` producer on
release and narrows the coverage rule to the released checkpoint; a historical
checkpoint needs current access to its sources, not the claiming command's
coverage.

The SQL save returns actual persisted expiry. Completion rereads every exact
canonical claim field under the retained unit lock and rechecks current
checkpoint sources. The core stages one outcome; #152 writes its sole debit
and durable receipt once. JSON replay hydrates Date values and uses stable
semantic comparison, including PostgreSQL jsonb key-order changes. An unchanged
expired historical lease can be observed without renewing it. New generation/
version/assignment/checkpoint state makes the old receipt stale; current
runtime/grant/source expiry or revocation still denies observation. Failure
must escape the caller's outer transaction. Actual domain publication needs its
appropriate operation/grant and live fence; it is not an arbitrary side effect
authorized by `cowork.claim`. All domain/receipt/outgoing work finishes before
the shared genuine native final event flush.
