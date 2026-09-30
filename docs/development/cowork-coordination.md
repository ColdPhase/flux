# Durable local-agent coordination (#153)

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
order. Revoke versus publish, renewal versus expiry and reassignment versus late
result need actual PostgreSQL race evidence before acceptance.

## Core ports and consumers

The `core/co-work` module depends on contracts and core-owned ports. It imports
no SQL, Drizzle, pg-boss, HTTP or client SDK and adds no architecture exemptions.
Server/worker composition supplies transaction-bound adapters.

| Port responsibility | Required behavior |
| --- | --- |
| Current authorization/context | #152 supplies trusted context and transactional grant/access/compatibility checks. |
| Claims and slots | One active author per logical unit; generation/session/DB-time fencing before every domain effect; bounded per-connection execution/review concurrency. Two sessions do not evade a connection slot. |
| Addressed requests and receipts | Atomic deduplication, versioned transitions, exact target supersession, durable pending state and one recipient. |
| Checkpoint/recovery | Bounded current-authorized pending replay and snapshots after context loss or cursor gaps; last checkpoint and active claim facts remain distinct. |
| Task contribution/artifact | #154 publishes truthful canonical actors/content inside the outer transaction; exact immutable or versioned target references. |
| Delivery intent | A durable outbox intent commits with its request. Delivery is at least once; a hint/ACK/renewal adds no ordinary unread chat event and invokes no model. |

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
#153 `0035` and #74 `0036`. Do not edit already merged migrations. #153 must
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
