# Durable local-agent coordination (#153)

> **What remains (#973, v0.2).** The units of work stay: `flux_create_unit`, `flux_claim_unit`, `flux_renew_unit`,
> `flux_release_unit`, `flux_complete_unit`, `flux_transfer_unit`, `flux_decline_unit`, with their claims, checkpoints, leases and
> the fixed rule that a run is not reviewed by its own author's connection (`COWORK_REVIEW_SEPARATION`, C-9). **Gone:** addressed
> requests between clients (`flux_send_request`, `flux_claim_request`, `flux_defer_request`, `flux_decline_request`,
> `flux_resolve_request`), the inbox (`flux_coordination_inbox`), `COWORK_REQUEST_POLICY` and its limits (32 requests, depth 4,
> 4 review rounds), the formal review verdict record, the request cards, handoff packet and cancel in a task's Details
> (`GET/POST /api/v1/work/:id/coordination…`), and the tables `cowork_requests`, `cowork_request_lineages`,
> `cowork_delivery_intents` and `cowork_review_verdicts` (migration 0027). The MCP tool contract changed in place (nothing is kept compatible
> before the first public release, see [extension contracts](../product/extension-contracts.md#no-compatibility-before-the-first-public-release)). The
> pull-request bridge (#479) still records the events of a linked pull request for the task's holder; their only reader was the
> inbox, so they have no reader until a follow-up removes the bridge or gives it one. **Sections below that describe requests,
> the inbox, verdicts or cards are the design history of what was removed**; where one sits inside a section that remains, treat it
> as removed.

## Start/Resume recovery amendment (#152/#160, 2026-10-18)

### Supplied external host action

`./flux cowork start|resume --client codex --origin URL --connection UUID --project UUID`
is the supplied host invocation. It operates the person's installed official
Codex, distinct from the embedded runtime. The existing Docker application image
renders entry guidance and processes private native JSON events; no host
Node/dependencies, instruction files, copied workflow prompts or daemon are
required. The browser shows the bound host action and explains that it cannot
launch a closed native client. This adapter targets the pinned Codex
ChatGPT account path; it refuses other clients/account modes truthfully. Claude
activation remains pending after the recorded unavailable-account observation.

The adapter keeps only origin, connection, project, client, working directory
and its own exact native thread ID in a private local metadata directory
(0700; metadata0600). Start never replaces an existing native thread; Resume
uses that explicit ID, never global `--last`. Native credentials and native
history remain under the person's official client. No global configuration or
instruction file is rewritten. Raw native JSON is temporary, private and
deleted after extracting the binding/outcome; hidden reasoning/transcripts are
not stored by Flux. One local lock prevents concurrent launches of the binding.

Inline native MCP settings target the existing `/mcp` endpoint with optional
`flux_connection` and `flux_project` UUID query parameters. They must appear
once each together: a verified bearer for another connection is refused before
discovery, and every selection/read/effect is additionally restricted to that
project. These parameters narrow existing authority; they issue no credential,
grant or permission and do not create another MCP registry or audience. Ordinary
`/mcp` remains unchanged. Required server playbook loading and the current
bootstrap still precede effects. The image is never authoritative for the current
playbook: the native client discovers and reads the current server resource in full. The supplied adapter appends product instructions
per invocation and retains native repository/global instruction files.

Start/Resume are finite model turns. The existing checkpoint and addressed inbox
are the durable work record. With no ready work the turn ends; this adapter does
not poll a model, advertise automatic idle wake or kill an unrelated native
program. Pause/Stop and quiet active-client wake remain subject to the unchanged
whole-issue acceptance criteria; adding this activation path does not accept them.

### Host action verification status and watchdog (#635/#636, 2026-10-23)

- **Resume is unverified.** No account-backed Codex Start followed by an exact-thread
  `codex exec resume <SESSION_ID>` has been recorded with the real binary. The declared
  exact-thread Resume leg of the supplied action is therefore unverified; it is not a
  supported, accepted or recorded behaviour. The Start leg is also pending native
  verification in the UI (Connect and the project Agents view), and Claude's supplied
  action stays pending. The evidence is in
  [`evidence/160-workflow/README.md`](evidence/160-workflow/README.md). Tests of the
  launcher use stub `codex` and `docker` commands only and are not real-model evidence.
- **Watchdog.** `./flux cowork start|resume` stops a native run that is still going after
  `FLUX_COWORK_WATCHDOG_SECONDS` seconds (default `300`, a positive whole number without a
  leading zero; any other value is refused before the native CLI starts). The launcher then
  records the run as its outcome and removes its temporary native output. Set a longer value
  only for a deliberately long native run.

Bootstrap may request `includeWorkRecovery: true`, with `workLimit` (1–50,
default 20) and `workOffset` (0–10000). This is an additive MCP contract-1
extension: omitted recovery keeps the existing envelope. Recovery additionally
requires the current `project.work.read` capability and returns a bounded page
in `trusted.coordination.work`: the calling connection's pending, paused or
claimed native units in this project, their task, role, current version,
checkpoint ID and live-lease status. Live claims precede paused work, then pending
work. It returns no claim secret, checkpoint text or other connection's work.
The existing claim operation remains the only way to obtain the checkpoint and
a new lease. A live lease belonging to another client session is visible as
such; Resume must wait for its expiry or an explicit release, never impersonate
that runtime. Stopped/completed units are not candidates for Resume. The two
existing nullable coordination references retain their meaning; their values
now point at the current live unit and the first recoverable checkpoint when
requested.

This composes existing records and authority; it introduces no second task
store, automatic client launch, model wake or claim. Recovery and playbook ACK
remain observations, never evidence of model obedience. Complete #152/#160
acceptance still requires the integrated native-client flows and current gates.

Release checkpoints may additionally carry `orientation: { known, gaps }`:
up to 50 distinct canonical source checkpoints and up to 10 bounded plain-text
context gaps. This is client-reported coverage of what it read, not a claim that
the server observed reading, and never an authority or a command source. The
existing material `sources` remain the server-validated dependencies of release.
Orientation is stored in the same durable checkpoint, and is returned only
after all of its source kinds pass the current MCP read-capability boundary.
An older version, deleted source or newly missing permission must not be
presented as current knowledge: compare `known` with `flux_changes_since` before
acting, treat unavailable critical sources as blockers, and record the new
coverage after reanalysis. Existing checkpoint drafts and stored schema-1 rows
remain valid without this optional field; no storage migration is necessary.

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
  - Their owners may be the same: there is no owner rule (#959, C-9).
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

### Owner-assistant handoff creation — F-027 amendment (2026-10-10)

**Contract correction for #401 C4 independently accepted as documentation at
`299369288a751ca61c3d7cf25ce52b38ae8f1361`, 2026-10-10; see
[the review/identity/remaining-gates record](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/assistant.md#contract-text-acceptance-2026-10-10).** This bounded server-owned adapter
delivers [F-027 AST-3/Journey 5](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/assistant.md#ast-3--one-assistant-one-permission-surface)
without giving the assistant a parent claim. The ordinary external
`coWorkUnitCreationInTransaction` contract above, including root assignee=caller
and child live-parent generation/lease/runtime fences, remains unchanged.

`ownerAssistantUnitCreationInTransaction` is an internal composition reached either
through the verified run-private `flux_create_unit` projection below or through
AST-5's authenticated owner Apply on its saved immutable intent. **R1/R2 clarification,
2026-10-10, [contract-text acceptance recorded](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/assistant.md#contract-text-acceptance-2026-10-10):** these have distinct server-verified authority
purposes; the ordinary external public tool/schema remains unchanged. There is no
new public actor/authority parameter or endpoint.

- **Direct-run caller authority.** The API resolves the actual live connection, its durable
  owner-assistant identity binding (`personal_run_agents`/A1), current owner,
  signed run token and matching current run record. The token must be intended
  for this MCP resource/run/place; the run must still be running for that exact
  owner and binding. `compute_source = 'owner_assistant'` alone, a connection
  label, a normal OAuth/local/native bearer, or client-supplied run/actor fields
  never selects or authorizes this adapter. No external caller can downgrade
  into it or bypass its own root/child rules. Both engines use this same check.
  This purpose authorizes only calls while that run is live. A completed run/token
  is provenance for a saved waiting intent, never continuing model authority;
  later Apply requires the separate owner-approval transition below.
- **Current limits.** Hold/recheck owner rights,
  original consent envelope, S6 Tasks read/operation and selected project, exact
  run place, "What it may do", run limits and Stop/revocation at execution and
  receipt replay. An expired run token cannot create/replay under direct-run
  authority; stopped/cancelled source runs and Off/narrowed/revoked authority cannot
  authorize pending execution under either purpose. Background runs additionally require their still
  valid owner schedule/reaction authorization and its existing bounds. This is
  run authority, not a fabricated assistant standing grant or bootstrap.
- **Input and attribution.** Reuse the existing bounded unit-create intent:
  task/object, exact expected task version, role (`execute`, `review`, `plan`),
  intent key and recipient connection target. For this adapter `parent` is null;
  a supplied claimed parent is refused, never ignored or fabricated. The server
  derives creator, owner, run/lineage identities and receipt attribution from the
  verified records; it never impersonates the human or recipient as creator.
  The assistant is the author, acting for the recorded owner/run/payer.
  The ordinary public schema is unchanged; the run-private input projection below
  removes its unavailable bootstrap authority fields explicitly. No caller-supplied
  budget, authority, owner or actor exists.
- **Recipient.** Resolve a different, external MCP connection of the **same
  current human owner**, in this workspace and project, live/unrevoked, with the
  existing selected-project/execute-scope/project-access prerequisites. Neither
  another assistant nor a foreign owner's agent is eligible. An owner approval
  cannot authorize a foreign-agent handoff: a request to that person follows the
  existing person-consent flow; their own ordinary handoff remains separate.
  Creation grants no authority, runtime, capacity or claim. The recipient still
  needs its own current `cowork.claim` role grant and independently calls claim
  with its own binding/session/fence. Missing claim eligibility is shown truthfully
  and its Allow action opens the existing owner grant flow; the assistant cannot
  issue that grant, claim, invoke or bootstrap the external client.
- **Root and budgets.** Only this verified owner-run composition may create a
  pending root assigned to that eligible recipient without a creator parent.
  The server derives its task/lineage/run identity in a distinct assistant-handoff
  namespace from the verified assistant connection/original preparation run, task and immutable intent
  key. It cannot borrow a client-named or unrelated lineage. Preserve the closed-
  task and exact-version fences, task-wide open-role/plan-writer exclusion and
  native maximum-run-units bound. Charge creation/re-issued intent to the current
  assistant operation/change limit for direct execution or the bounded owner-approval
  allowance below; receipt replay adds no second charge. Native
  counts are never refunded by Undo. Repeated separate roots cannot escape the
  assistant run limit or task exclusion. External creators still use/debit their
  own standing grants under the unchanged ordinary composition.
- **Review separation.** Keep the fixed rule (no project setting since #959, C-9) and
  current native reviewer eligibility against the task's canonical
  author/unit/source evidence. A fresh root cannot erase known authorship or
  let its recipient review its own execution. No author, recipient or model
  selects a weaker separation. Missing/stale
  provenance fails closed; creation is no review acceptance or publication.
- **Atomic composition.** Acquire verified run/authority locks before the
  complete sorted connection/binding slot set, project graph/native task set and
  unit rows, preserving the existing global ordering and fresh database-time
  rechecks. Recipient revoke, run Stop and S6 edits serialize with insertion and
  replay. A committed creation has the canonical unit, attributed receipt,
  assistant change row and its effect-accounting result in one transaction;
  event intents flush once after commit. A refusal leaves none of these or any
  grant/claim/capacity change. Integration must prove the actual lock order rather
  than assume these words establish it.
- **Duplicates and Undo.** Preserve exact task/version/role/recipient/intent
  fingerprint and canonical post-state checks. Same-command receipt replay is
  an observation only under current authority; changed post-state is stale.
  Re-issued same intent returns the existing unit, never a second root; changed
  role/recipient/lineage is a conflict. The owner's ordinary version-checked Undo
  can cancel only the untouched, never-claimed pending unit, retaining its audit
  and budget history; concurrent claim and Undo serialize on the unit. Once the
  recipient has started or the unit otherwise changed, Undo does nothing and says
  "Your Codex already started. Open the task" (or the ordinary changed-since row).
  It never releases/transfers/resets the recipient's claim, stops their CLI,
  changes their grants or silently reopens work. Stop of the assistant similarly
  prevents its next handoff, without stopping already independent recipient work.

#### Run-private catalog and input mapping (R2)

The name remains `flux_create_unit`, registered against the existing
`cowork.unit.create` entry/classes and S6 checks. Its **server-selected private
catalog view `assistant-unit-create/v1`** differs from the ordinary external view;
this is an explicit bounded input/description amendment, not an assertion that
the two wire schemas are identical.

- Before advertising or validating tool input, the MCP composition verifies the
  signed run purpose, current run, durable assistant/owner binding and exact place
  above. Only that trusted context selects the private view. Ordinary OAuth/native/
  local callers receive the unchanged public schema and its truthful standing-grant
  and bootstrap descriptions, including required `runtimeSessionId` and `grantId`.
  `compute_source`, tool arguments, client metadata and opaque caller IDs cannot
  request a private view. Invalid/expired run authority is refused, never downgraded
  to an ordinary caller or tried against a second schema.
- The private input is strict and consists exactly of the existing intent fields
  `projectId`, `clientCommandId`, `peerRequestClass` (`execute|review|plan`), `taskId`,
  `unitKey`, `expectedTaskVersion`, `assignmentConnectionId` and literal `parent: null`.
  Keep the ordinary UUID/version/key bounds. `projectId` must equal the verified
  run place; class is the requested unit role, and assignment is a recipient target,
  never actor authority. Omit `runtimeSessionId` and `grantId` entirely: supplying
  them, a non-null parent or any purpose/run/owner/actor/budget field is an error.
  Version/view selection is server metadata, not an extra tool-input switch.
- The private title/description states: create pending handoff intent for your
  owner's eligible external agent at this task version; authority comes from this
  verified assistant run, no bootstrap or standing grant; the recipient still
  requires its own grant/claim. Never advertise the public "take your own root"
  or "use the runtime/grant from bootstrap" instructions to the assistant.
  In Ask me first it returns a waiting-change reference, not a created native unit
  or claim; only successful execution returns the canonical created/existing unit.
  Tool results and UI distinguish proposed, approved and actually applied state.
- Map the validated semantic fields to the immutable intent/command fingerprint
  and role/target, and the trusted run context to creator/owner/purpose. Do not
  fabricate, reuse or store an external runtime/grant ID to satisfy a public
  execution command. The adapter consumes the typed run authority directly;
  ordinary external `prepare`/`complete` and input validation stay unchanged.
  Both engines receive this same effective catalog/schema, including descriptions.
  Persist the server-selected view version with the canonical prepared intent.
  Owner Apply decodes that exact supported version; upgrades cannot reinterpret
  it using a new schema. Unknown/unsupported stored versions require Ask again,
  never reconstruction of fake bootstrap fields or guessed actor authority.
- Bind any descriptor/session cache to the authenticated authority purpose,
  connection/owner/binding, run and policy version; recheck live authority on calls.
  No cross-purpose cache or public/private fallback is allowed. Retain the existing
  manifest/name/operation/class assertions and one registration per name; the
  private projection must not weaken registration or dispatch guards. A future
  implementation must prove the authenticated pre-schema selection and actual
  schema-to-adapter path, not just call the internal adapter in a unit test.
  Catalog publication and the strict decoder must choose the same verified purpose
  view for server/runtime calls and ordinary native/local clients. A stale/mixed
  public-private schema or session descriptor fails closed, never guesses by args.

#### Authenticated owner Apply after preparation (R1)

A waiting handoff is in its owner's Inbox at once and never expires (F-036 AG-7).
The owner may Apply while the source run is still live or after
it **normally completed** and its run token expired. Finishing normally with
waiting items is not Stop/cancel;
the durable completion/preparation outcome must distinguish those cases. A failed,
interrupted or unconfirmed preparation supplies no new approval authority.

- The specified owner-only Apply route authenticates the **current** owner session
  and standing (no new recent-auth challenge), reads the pending change under its
  expected version/CAS, and loads its original assistant binding, run provenance,
  exact operation/class/project/task/version/recipient/key and immutable fingerprint.
  The browser supplies only the existing change selector/version, never replacement
  intent or a purpose/grant/session/actor assertion. Only a valid, unexpired,
  uninvalidated waiting item can transition; another owner/admin/agent is refused.
- Within that transaction the server constructs a one-use, transaction-local
  authority context with purpose `owner_approval`, bound to this owner, exact change
  version/fingerprint and approval attempt. It enters the same native adapter/
  executor directly. It is no bearer token, MCP tool, bootstrap runtime, standing
  grant or new model run; do not revive the old run, refresh its token or invoke/
  charge a provider. A later owner session may explicitly Apply after authenticating
  as the same current owner; it does not acquire the original run's autonomous power.
- Recheck current durable assistant binding/enabled source authorization, original consent ceiling,
  S6 Tasks read/operation and selected place, owner standing/rights, recipient ownership/access/role/grant eligibility, expected task/source
  versions, separation, task exclusion and native budgets. A changed mode never
  auto-applies an existing waiting item; an explicit Apply still needs these gates.
  The source run must be live without Stop requested or normally completed, not
  stopped/cancelled/revoked. Off, Only read, binding revocation, Stop/cancel and
  Skip invalidate affected unexecuted intent; enabling/On/new grants cannot revive
  that old authority. Pause blocks pending Apply while paused, with no autonomous
  resume; after an explicit resume, an unchanged non-revoked item still requires
  a fresh owner Apply and all checks. Stale targets say Ask again, never rebase the
  prepared payload silently.
- Count each actual effect once in approval/native accounting and
  the original change history; no model request/day/money charge, native count refund
  or new unlimited lane. A new approval allowance requires that new explicit owner
  Apply; the model, a queue worker or a retry cannot split a batch into fresh
  allowances automatically. The owner's existing serial execution lane orders
  approval against other changes; approval accounting and the saved intent state
  commit with the native effect/receipt. Receipt replay adds no new unit, debit or allowance.
- The assistant remains the recorded preparer/unit creator. The **actual approving
  actor is the current owner**, with `owner_approval`, approval time/attempt, original
  source run/engine/payer provenance and immutable change reference in the receipt/
  change log. UI says "Ada's assistant · approved by Ada"; provenance does not claim
  a model/provider ran or was charged at Apply. Do not impersonate the recipient.
- Apply/CAS, Stop/Skip, binding/S6/grant/recipient revoke and native claim/
  Undo serialize with the shared authority, intent and native-unit/task lock order.
  A winner commits either one authorized unit/receipt/accounting transition or the
  invalidation/refusal; none survives a refused transaction. Same approval/intent
  retries inspect the current canonical post-state under current authority and do
  not execute again; changed post-state/recipient/role/payload is stale/conflicting.
  Owner Apply never enters the public bootstrap schema or widens its root/child rule.

**Implemented (A3/A4, #403/#404, 2026-10-17).** `ownerAssistantUnitCreationInTransaction` and the Undo cancellation are in
`apps/server/src/co-work/assistant-units.ts`; the pure rules are `requireOwnerAssistantHandoff` and `assistantHandoffRunId`
in `packages/core/src/co-work/units.ts`, the storage is `coworkUnitCreationRows` (`lock` now also reads every unit of the task
for review separation; `lockUnit` and `cancelPending` serve Undo in the claim's lock order). The change is recorded as an
`assistant_changes` row with `object_type = 'work'`, operation `cowork.unit.create` and the unit in its receipt and Undo plan, so
no schema change was needed. Tests: `app/tests/app/assistant-handoff.test.ts`, `agent-runtime-runs.test.ts`.

**Delivery gates, A3/A4 (not runtime evidence).** Both fake engines must create an
own eligible agent's pending handoff with no assistant claim/bootstrap, then prove
the recipient cannot start without its own grant/claim. Preserve positive ordinary
external self-root and live-child controls and negative external foreign-root,
missing/stale parent, wrong generation/lease/runtime and unclaimed-child controls.
Add normal-local/native bearer, forged run/actor, compute-source-only, foreign-owner,
same-assistant recipient, consent/permission narrowing, stale task, stopped/expired
run, recipient revoke and held insertion/replay revocation races. Verify strict
review separation, immutable-intent conflicts, exact duplicate/replay debit/counts,
run/native budgets, task/plan exclusions, attributable atomic rollback and persisted
receipts. Undo before start, after start and a held claim-vs-Undo race must preserve
the recipient's authority/fence and produce truthful UI. These are requirements of
AST-3.2, AST-5.2/5.3, AST-6 and Journey 5; all existing gates remain.
Add catalog/schema fixtures for both authority purposes, positive private-input
validation through the real MCP route and unchanged public schema/description
compatibility. Forced private inputs from ordinary OAuth/native/local callers,
forged view/purpose/actor fields, missing public runtime/grant IDs and cross-purpose
catalog caches must fail before adapter execution. Clock-controlled Apply succeeds
after normal completion and token expiry, with zero CLI/provider calls. Test exact-version duplicate/CAS, cap-overflow approval,
foreign owner/admin/agent, failed/stopped/cancelled source, Off/Only read, pause,
revoked/downgraded binding/recipient, stale target and Skip.
Hold approval versus each revoke/Stop/Skip and claim/Undo boundary; assert
persisted unit, receipt/actual actor/provenance and exactly-once accounting. Re-enable
or a new token/grant cannot resurrect invalidated intent. Both engines prepare the
same private intent; owner Apply runs the same checks without either engine.
Unknown/unsupported stored private-view versions fail truthfully with no write;
supported exact-version restoration preserves payload, actor and command identity.

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
    `outcome` is one exact native reference: `{ type: 'message', id }`
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
    (`COWORK_REVIEW_SEPARATION`). Their owners may be the same (#959, C-9).
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
- **#238 seam.** Completion and transfer are persisted unit uses. #238 joins
  them to its task-use fence at the conditional update, inside the same
  transaction; see [Task-use fence (#238)](#task-use-fence-238).

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
  (`maximumRunUnits` 16) from `apps/server/src/co-work/policy.ts`. Tool input,
  client metadata and project content never set it. The project-level choice of
  `distinct_owner` was removed in #959 (C-9).
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
  playbook 1.3.0 says which parts exist.

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
  transfer", with no policy parameter since #959. The complete
  tool's `outcome` admits only the native reference types.
- **Still not exposed (until 2026-10-17, see the next section):** request
  admission, recovery and the inbox, and resolution with a response.
  - `flux_bootstrap` therefore still reports `coordination_unavailable`.
    Playbook 1.3.0 says that this gap covers only those parts.
  - A connection learns the ID of a unit that another connection created for it
    (a child unit) only through the inbox or recovery tools, which do not exist
    yet.
- **Open questions (peer review).**
  - Should a parked task refuse new claims?
  - Should the claim policy's capacity of 1 become a grant-backed capacity
    before #160's clients hold an execute unit and a review unit at once?

### Declining a transfer, honest status (2026-10-17, #153 AC-1/AC-3)

Agent decision under the delegated authority.

- **`flux_decline_unit`** (operation `cowork.unit.decline`, classes execute/review/plan, migration 0107; PR #586 holds
  0106). A transfer remembers the handing-over connection in `cowork_units.transferred_from_connection_id`. The receiving
  assignee, while the unit is still `pending` (never claimed, so before any artifact of its own), declines with only the
  unit version: the unit returns `paused` to the prior assignee, generation and version advance, the checkpoint and task
  are untouched, and the prior assignee claims it again with its own grant. A claim clears the marker, so nothing after
  the first claim can be declined; a completed unit is final and authorship never changes. Open requests addressed to the
  unit refuse it (`COWORK_UNIT_REQUESTS_OPEN`), a claimed or never-transferred unit is `COWORK_DECLINE_REFUSED`, a prior
  assignee that was revoked is `COWORK_ASSIGNEE_UNAVAILABLE`. A return that would leave the prior assignee
  holding both an execute and a review unit of the run is `COWORK_REVIEW_SEPARATION`, as a transfer would be. A retried command replays; the receipt goes stale when the
  unit changes again.
- **`flux_defer_request`** (operation `cowork.request.respond`, so no new grant). A small separate tool rather than a
  mode of `flux_resolve_request`, because deferral needs no unit claim (a busy connection defers without taking the
  request) and carries no evidence. It takes a bounded reason (busy, dependency, offline, capability, policy) and safe
  boundary (after_step, after_tests, after_release, on_dependency, on_resume, on_capability); a dependency names an exact
  current record. Only queued or deferred requests can be deferred; the recipient's unit must be open. The request stays
  in the inbox and can be claimed later.
- **Status.** `status` is derived from stored facts, never a heartbeat: `working` (claimed under a live lease of the
  recipient's unit), `offline` (a pending request whose recipient connection is revoked or has no live runtime session),
  `deferred` (with `reason` and `nextBoundary`), `queued`, `cancelled`, and the closing outcomes. It is returned by the
  inbox (`flux_coordination_inbox`, `status` next to `effectiveState`) and by `GET /api/v1/work/:workId/coordination`
  (`status`, `nextBoundary`). Cancellation requested versus acknowledged waits for a cancel operation; today only the stored
  `cancelled` state exists.

## Ownership and first integrated flow

Zamojski5 owns #153 and its `claude-maurycy/153-cowork` branch. PelikanFix16
independently evaluates it and owns connection/grant/bootstrap #152, built-in
client workflow #160, task contributions #154 and GitHub binding #74. The final
design's Agents view (#347) integrates the Agents presentation. Do not write those owners' active branches.

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
Documented exception (2026-10-17, #153 migration 0107): 0060 and its reversal were edited in place to extend the live
grant-operation CHECK instead of rewriting a fixed list, because the #238 tests apply 0060 after later files and a fixed list
would drop `cowork.unit.decline`; the ledger keeps versions only (no checksums), so databases that applied the old 0060 are unchanged.

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

### Task-use fence (#238)

Every co-work writer that takes the native task set now takes it as the shared
[task-use fence](task-creation-undo/README.md#never-used-ac-u2-the-shared-task-use-fence):
the single sorted task pass of unit creation, claims, request admission, request
claims and responses, and unit completion and transfer is `taskUseRows(tx).lockPrepared`,
which refuses a task whose creation was undone (`TASK_CREATION_REVERTED`). The tasks a
request names (target, sources, criteria) and a task named as a completion outcome join
that same pass after the project graph locks. A saved unit, claim, checkpoint, request,
response or transition then marks first use of its tasks, so a task taken by co-work can
no longer be undone. Replays and acknowledgements mark nothing.
