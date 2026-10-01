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

This does not prove checkpoint creation, native graph/reviewer eligibility,
authorized request admission/resolution, execution/publication fences, public
MCP/client wiring or model-driven Start/Resume. Those are unchanged requirements.

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
#153 `0035`, #74 `0036`, and #154's actor extension `0037`.
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

Release requires the actual scoped checkpoint's current connection/generation/
original runtime fence. Historical checkpoints from earlier assignees remain
readable only under current same-unit/source authorization; historical
connection identity is not an authority requirement. Source coverage must be
included in the original prepared command, locked before graph/tasks and
rechecked without acquiring late upstream material/version locks. An incomplete
coverage or changed source fails closed. A typed checkpoint producer/schema
and complete current source adapters remain required unfinished work.

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
