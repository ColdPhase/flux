# Scoped runtime, grants and domain commands — #152 design delta

Recorded 2026-09-30 after the consent checkpoint. This is the concrete next
implementation boundary under F-018, not evidence that these capabilities ship.
The root peer accepted the context/grant/bootstrap direction with the transaction,
identity, lock-order and authority constraints below. Review the exact payload and
canonical field extensions before enabling their writes.

## Authenticated runtime context

A new server-issued runtime session belongs to one durable OAuth binding:
`ownerUserId`, `connectionId`, `agentId`, `workspaceId`, actual AS-owned `clientId`,
`grantReferenceId` and binding generation. These fields come from the verified
bearer and current binding, never caller-supplied object names, browser project
selection or self-reported MCP `clientInfo`. Reconnect keeps the connection/binding
but creates its own authorization-code refresh lineage; revoking a connection
invalidates all its runtimes immediately. A supplied runtime session ID is useful
only after exact owner/connection/client/reference/generation matching. It does
not create authority. Expired, revoked and unknown sessions fail visibly.

The initial typed action set is project context/search, native task create/update,
result record and decision propose. Conversation contributions consume #154's
transaction-bound genuine-agent command; no synthetic human actor. Project map
commands reuse the canonical sketch commands. Wiki writes require a compatible
real-agent author extension to material/doc storage and all its existing readers,
search/export/helper consumers before they are advertised (2026-10-02: migration
0043 and the updated readers provide it; see
[the agent connection page](../../agent-connection.md#project-wiki-docs-and-conversations)). Human-only decision
acceptance remains unavailable to an agent. Execution and review grants remain
different types; a review must use an independent actual actor and current source
versions. Self-reported application/model names never establish that independence.

## Standing grants and command receipts

An owner creates a standing grant explicitly for their connection and selected
project, under current project-management rights. A project contributor role is
necessary domain authority, not a standing execution grant. Grants contain exact
workspace/project/connection, typed operation, optional exact object ID, project
audience, typed peer-request class, maximum uses, expiry, revocation and generation.
Unknown values fail closed. There are no wildcard audiences or string-prefix
operation matches. Requests without the required standing grant can submit a
human-reviewable proposal through the existing proposal path; they do not publish.

Core owns a small `AgentExecutionPort`. A composition adapter opens one outer
transaction and checks live OAuth binding/runtime/connection, central project
policy and exact grant matching; locks access/grant rows in stable order before
actor command/task/conversation locks. In that same transaction it checks the
canonical request receipt, debits a new grant use and invokes the existing domain
command against that transaction. All domain/coordination rows, use debits, durable
receipts and outgoing intents are written before the final stream-sequence events.
Collect deferred event intents across the adapters and flush them last inside this
same outer transaction; never call an inline-emitting adapter and then write a
receipt. All rows/intents/events commit together or roll back together. Every replay checks current authority and
source/version preconditions before returning its stored result. For a mutable
target, the receipt records the command's produced post-state version: an unchanged
produced version permits replay even though the command advanced its own input
version; a later edit/deletion causes a visible stale-replay failure. Referenced
plan/source versions must still match exactly. A receipt never bypasses these
checks. A replay never debits or applies the effect twice. Receipts are keyed by connection and durable
client command ID; conflicting normalized payloads fail explicitly.

## Native task plan correlation

Tasks remain `project_work_items`, visible in the existing board/conversation.
Canonical commands will add bounded success criteria, same-project dependency
IDs, and an optional immutable plan-intent reference (plan doc/material ID + exact
version + intent key). A new task checks the current referenced plan revision,
existing intent receipt and dependency existence under the project lock. A unique
project/plan-revision/intent key prevents concurrent planners from silently making
duplicate tasks; a materially different payload for that intent conflicts. Update
uses the existing task version precondition. Dependency updates reject self-links
and cycles; a task cannot be claimed as ready while its prerequisite work is open.
No old task is given guessed criteria, dependencies or a guessed plan reference.

## Bounded bootstrap and orientation

`flux_bootstrap` returns a versioned envelope with authenticated connection/runtime
identity, current grant IDs/ceilings/expiry, typed capabilities, server playbook
version/digest and recovery guidance. Policy publishing is privileged and separate;
ordinary messages/wiki/tool prose cannot become approved policy. A project policy
can narrow owner-granted work, never enlarge it. An instruction-loaded ACK is
compatibility evidence, not authority or proof of model obedience; #160 owns its
integrated real-client activation.

Orientation is an authorized, paginated index of project goals/plans/wiki,
conversations, accepted/proposed decisions, native tasks/dependencies, results and
verified repository references. Each source includes its canonical ID and version
or continuation cursor, with declared coverage and visible gaps. The envelope does
not dump all content or any private draft/sketch/helper source. Follow-up reads and
search use the same core ACL and selected-project ceiling. Changes-since compares
canonical versions/checkpoints and yields bounded changed source references rather
than silently rereading or truncating everything.

## Required evidence

Tests must cover exact context substitution failures, grant expiry/revocation,
limits, same-transaction rollback, concurrent duplicate commands, changed payload
conflicts, unauthorized receipt replay, object/audience/class mismatches and
independent review. Native tasks must appear in the browser with criteria and
dependencies, and two concurrent plan decompositions must not duplicate intent.
MCP/domain reads must exclude guessed private sources. Existing people/helper flows
remain working. All application checks run through Docker. Real pinned Codex and
Claude activation and model-driven work remain required and separate from these
HTTP/browser protocol fixtures.

The exact shared #152/#153 transaction/receipt interface, including last-use retry
and fresh DB wall time after lock waits, is recorded in
[execution-boundary.md](execution-boundary.md). Peer acceptance of that concrete
interface is required before its runtime writes.
