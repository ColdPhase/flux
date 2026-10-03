# Shared execution boundary for #152 and #153

Recorded 2026-10-01. Concrete interface proposal for independent peer acceptance
before runtime writes; this document is not completion evidence.

## One caller-owned transaction

Core owns `AgentExecutionPort<Tx>`, with a generic transaction handle so core
imports no persistence library. The server constructs the port with the verified
bearer identity and an **already open** `Transaction`. The port never opens or
commits an independent transaction. #153's `CoWorkClaimUnitOfWork.run` owns the
outer transaction and calls this port before connection-slot/task/unit locks.
Native #152 commands open the same outer transaction themselves.

```ts
interface AgentExecutionCommand {
  runtimeSessionId: string;
  grantId: string;
  clientCommandId: string;
  projectId: string;
  operation: AgentOperation;
  peerRequestClass: AgentPeerRequestClass;
  audience: { kind: 'project'; projectId: string };
  objectId: string | null;
  sources: { materialId: string; version: number }[];
  payload: JsonValue;
}
interface AgentExecutionScope<Tx> {
  transaction: Tx;
  context: AuthenticatedAgentRuntime;
  now: Date;
  replay: AgentCommandReceipt | null;
}
interface AgentExecutionOutcome<T> {
  value: T;
  // The domain adapter supplies exact canonical produced post-state.
  postconditions: AgentPostcondition[];
}
interface AgentExecutionPort<Tx> {
  prepare(command: NormalizedAgentExecutionCommand):
    Promise<AgentExecutionScope<Tx>>;
  // Rechecks fresh wall time, live authority and source/post-state conditions;
  // for a new success, debits exactly once and stores the one durable receipt.
  // A replay requires the original stored result/postconditions; no second debit.
  complete(scope: AgentExecutionScope<Tx>, outcome: AgentExecutionOutcome<JsonValue>):
    Promise<void>;
}
```

The configured verified identity is immutable owner/connection/actual OAuth
client/durable binding reference; the runtime record adds agent/workspace,
server-issued session and binding generation. A caller-provided runtime ID has
no authority before exact matching. New runtime sessions require a durable
`flux-grant:` binding; legacy bearer reads/proposals remain compatible, and do not
silently gain standing execution grants.

Core normalizes the exact typed operation/class/audience/project/object/source
and JSON payload. Reject unknown keys/types, duplicate source IDs, non-finite
numbers and oversized payloads. Sort source references and recursively sort JSON
object keys. The fingerprint includes the **original authenticated runtime
session**, grant ID, operation, class, project, audience, object, exact sources
and payload. The canonical ledger key is `(connection_id, client_command_id)`.
Cross-operation/project/session/grant or changed-payload reuse conflicts; it never
creates a second independent receipt. #153 must map its `saveReceipt` to this
receipt completion, retaining original lease ID/session/generation/outcome.

## Lock and clock order

1. Lock live connection/binding/runtime and current policy access rows in stable
   order, then the exact standing grant. Reuse the existing core access policy;
   project contributor rights alone do not authorize standing execution.
2. Lock the canonical connection/command identity, locate any durable receipt,
   and check its complete normalized fingerprint and original runtime identity.
3. Only then lock connection slots, the project task-graph locks (pinned in
   the [native-plan contract](../2026-10-01-native-plan-contract.md#task-graph-lock-and-reader-interface-pin)
   and implemented by its [native-plan slice](../2026-10-01-native-plan-contract.md#implemented-at-the-native-plan-slice)),
   the complete sorted task set, coordination
   unit/request rows, actor commands, conversations and mutable domain objects.
4. Read `clock_timestamp()` **after the relevant lock waits**, never PostgreSQL's
   transaction-start `now()`. Validate runtime/grant expiry, revocation and
   generation, current visibility and exact source versions. A new command also
   requires unused quota. A matching successful replay can use an exhausted last
   use; expiry/revocation/visibility/source changes still fail closed.
5. Apply new effects or validate the replay's canonical produced post-state.
   For #153, replays observe the original unchanged effect and never renew or
   reacquire its lease. Historical lease expiry alone does not prevent observing
   that original effect; it never establishes current continued authority. The
   current unit/version/generation/session and checkpoint readability must still
   match the original post-state. Resumed effects require a currently live fence. For native mutable
   targets, current version must equal the receipt's produced version; external
   intervening edit/deletion is a visible stale failure. The effect advancing its
   own input version is not a conflict by itself.
6. Before completing, read fresh DB wall time again and validate authority,
   exact sources and produced post-state. Store domain/coordination changes,
   outgoing intents, use debit and the canonical receipt. Collect immutable event
   intents; after **all** these writes and audience authorization, flush final
   stream-sequence events. No further domain, receipt, debit or lock-taking work
   follows the first stream insert. Commit once or roll back everything.

Execution/review/plan classes and exact operations are enumerated. Review grants
cannot execute, execution grants cannot review, and review publication separately
checks actual reviewer identity differs from the artifact author and that source
versions are current. No wildcard operations/audiences and no authority derived
from self-reported clientInfo, labels or instruction ACKs.

## Composition and tests

`coWorkClaimUseCases` can keep its existing pure command shape: #153's adapter
calls `prepare`, builds `LockedClaimScope`, and stages the outcome from
`saveReceipt`. It calls `complete` with that outcome and canonical claim
postconditions before its shared final event flush. On replay it verifies the
unchanged canonical post-state and returns the original stored outcome, without calling `save`
or creating a new receipt. A receipt whose normalized payload differs fails
before any unit mutation. Both implementations use the same ledger table.

The exact claim condition is aligned to #153 PR #166 at
`4ca13c9d07a603f897d213a27c6916b3fecee1ce` (layout integration later at
`e35dbc59754d6cc100409f59dc9b43d708a7b918`): kind `cowork.claim_state`,
workspace/project/assigned connection, unit ID, actual role, version, generation,
state, lease ID/session/persisted ISO deadline and checkpoint ID. #152 checks the
exact authenticated workspace/project/connection, target unit and request class;
the #153 canonical callback checks every saved field and current checkpoint/source
readability under its complete sorted lock set. Claimed lease session must be the
original server-issued runtime UUID. Release has null lease fields. Expired
historical deadlines remain valid observation evidence, never a renewed lease.
Unknown shapes, cross-operation evidence, missing required conditions and duplicate
condition identities fail before debit or receipt. A foreign/malformed condition
does not reach a canonical row reader. The callback remains disabled until the
actual #153 adapter is integrated and independently verified.

Required integration tests include duplicate concurrent commands, changed
operation/project/session/payload conflicts, exhausted last-use successful retry,
expiry after waiting on a lock, revocation/visibility before replay, source edits,
external produced-target edits, rollback after effect/before completion, no lease
renewal on replay, all domain/debit/receipt writes before final stream events, and
no nested independently committed receipt. Real Codex/Claude activation remains
separate and required by #152/#160.

The independent peer accepted this boundary with the conditions recorded in
[execution-boundary-independent-review.md](execution-boundary-independent-review.md).
The adapter scope is internal and opaque to MCP input; completion verifies the
same transaction/binding/command, and every typed postcondition is read from the
canonical domain rows. Claim-specific post-state alignment remains coordinated
with the #153 implementation owner before enabling claim writes.

## Reserved sender operation: `cowork.request`

Recorded 2026-10-01 after #153's registry-alignment request. This reserves only the
registry entry, class mapping, typed post-state and the database operation list for
#153's request enqueue. It adds no request storage, route, MCP tool, grant target or
recipient behavior; #153 owns those and none is enabled by this reservation. It was
added after the independent review above and has not itself been reviewed.

| Part | Reserved contract |
| --- | --- |
| Operation | `cowork.request`, in `AGENT_OPERATIONS`; migration 0038 adds it to the closed `agent_standing_grants` operation CHECK (0034 stays frozen) |
| Class | `AGENT_OPERATION_CLASSES['cowork.request'] = ['execute', 'review', 'plan']`: the **sender unit's actual role** only, never the recipient's class or the request `kind` (`help`, `review`, `fix`, `handoff`) |
| Object | The sender unit ID; required, never null |
| Payload | Recipient, request kind, source/criteria references, intent key and lifetime travel in the normalized, fingerprinted payload and are neither a class nor authority |
| Post-state | `cowork.request_state`: `workspaceId`, `projectId`, `connectionId` (sender), `unitId` (sender unit, equal to the object), `requestId`, `role` (equal to the command class), `version`, `state` (the request lifecycle values). No recipient, kind, reference or text |

Non-negotiable semantics:

- **Queued intent only.** The command records a durable request. It is not an effect
  on the recipient and not a claim, review, execution or publication.
- **It grants the recipient nothing.** A sender's execution, plan or review role may
  request a peer review without holding that peer's review grant: the grant checked
  is the sender's own `cowork.request` grant for its own class, and the requested
  `review` kind is payload. The exact grant match, the operation and the class are
  part of the fingerprint, so a `cowork.request` grant cannot authorize
  `cowork.claim`, `.renew` or `.release`, and a claim grant cannot enqueue.
- **ACK, deferral, selection, delivery wake and later lifecycle changes are not
  operations.** They have no registry entry, debit nothing and never create or extend
  authority. Names such as `cowork.ack` fail normalization and the database CHECK.
- **The recipient acts only under its own authority.** Before any effect it needs its
  own current `cowork.claim` grant with the matching class, plus current source
  visibility and, for GitHub delivery, its own verified repository access and
  provenance. A request addressed to a foreign owner's connection stays queued
  intent while that owner's execution authority is absent.
- **Fail closed until #153 supplies the reader.** The server port validates the exact
  sender workspace/project/connection/role/unit before it consults any row reader, and
  completes only through an optional `coordinationRequestPostcondition` callback that
  #153 provides. Without it, completion is refused (`COMMAND_POSTSTATE_STALE`) and
  nothing is debited or receipted. Owner grant creation records the operation and
  class like the other co-work operations, but accepts no exact-unit target until
  #153's grant-target adapter is composed. Tools must not advertise the operation
  before an adapter is implemented and independently verified.
- **Open for the #153 callback, not decided here.** A new enqueue produces a `queued`
  request at version 1 and the receipt retains that post-state. How a replay observes
  later request progress (ACK, deferral, claim, resolution, expiry) without a second
  effect, debit or false stale failure is for the canonical callback to define; the
  registry pins only the shape.

Migration 0038 is the lowest number at or above 0038 present on neither `origin/main`
nor any pushed `origin/*` head on 2026-10-01: main ends at 0025 and no pushed head
holds a number above 0037 (0026-0032 are #58, 0033 and 0037 are #154, 0034 is #152,
0035 is #153, 0036 is #74). It is idempotent, preserves rows and leaves 0033, 0034
and 0037 untouched; `FLUX_SCHEMA_VERSION` becomes 38. Numbers above it remained
unreserved, including #154's unallocated 0040/0041 proposals; the native-plan slice
later took 0039.

## Explicit OAuth action ceiling

The independent root peer accepted additive `flux.action.execute` on 2026-10-01.
Its consent label is **Run approved project actions**, with the visible condition
that each action also needs the owner's current standing grant. Connections must
explicitly select it, authorization requests must explicitly request it and the
verified bearer/runtime must retain it. Existing read/proposal selections and
bearers are never upgraded implicitly. The current provider resource allowlist,
signed requested-scope profile, connection validation, consent display and live
bearer/execution checks enumerate the third scope. The command fingerprint keeps
the authenticated scope ceiling. Contributor access alone still authorizes no
standing effect. Coarse action scope does not substitute execution/review/plan
class matching or actual reviewer independence.

Only operations with implemented and verified canonical adapters can be advertised.
Wiki writes and #154 conversation contributions remain unavailable until their
real-actor storage/readers and transaction handoff are verified. (2026-10-02: doc
create/edit and project conversation start/reply now have both; see
[the agent connection page](../../agent-connection.md#project-wiki-docs-and-conversations).) Changed consent
states need fresh visual review; the earlier two-action screenshots certify only
their pinned historical state. Same-client two-tab consent and signed-scope
substitution regressions remain required after this change.
