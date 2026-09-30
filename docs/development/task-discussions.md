# Task notices and genuine discussions (#154)

Recorded 2026-09-30 before implementation. This implements the accepted
[UI116-3 contract](../design/studio-v11.6.md), under the delegated independent
[design assessment](task-discussions/2026-09-30-design-review.md). The issue's
AC-1–AC-5 remain required; this design record does not establish delivery.

## Identity and audience

Task creation writes one work item and one durable `task.created` notice in the
same transaction. The notice carries the exact task, trusted creator, time and
source references. It is a separate project activity projection, never a fake
human opening message. Merely opening a task shows an empty discussion.

The first actual contribution lazily creates one canonical project conversation
and its sequence-1 message under a lock on the task. An explicit unique binding
retains those identities. Subsequent contributions use the same flat sequence.
Source conversations stay in place; source links never imply a binding. Reads
expose the exact root ID even when its body is outside the newest message window.

All discussion content has the task's current project audience. Existing helper
in-flight views retain their owner scope; existing committed project answers
retain their actual project audience. Neither becomes a task contribution merely
by being viewed. Accepted result publication keeps its accepting human identity,
canonical result ID and permitted agent provenance distinct.

## Shared commands and atomicity

Browser, API, helper and MCP adapters call the same core use cases through ports.
New creation/contribution commands carry a stable UUID and normalized fingerprint.
Their durable receipt is scoped to current principal, project and operation and
does not expire with the 24-hour HTTP response cache. Changed payloads conflict.
Replays recheck current project access and, for MCP, current connection/operation
grants. Older no-key creation remains compatible and atomic, but cannot promise
deduplication of indistinguishable retries. Browser clients always supply a key.

The common lock order is current access rows, durable command identity, sorted
task IDs, then conversation sequence. Writes, explicit binding, associated task
or result changes and stream events commit together. Simultaneous first sends
serialize on the task: one root, then sequence 2, with each actual actor/content.
No client-supplied author or creation time is accepted.

Explicit nonempty blocker saves are authored contributions; clearing a blocker
and ordinary status/owner changes are not comments. A result publication writes
one result and per-task messages referring to that exact result, locking several
task IDs in sorted order. A public handoff instruction is a contribution;
heartbeats, acknowledgments, private helper exchanges and execution logs are not.
#153 consumes this shared primitive with its own authority/generation fencing.

Agent actors remain agents. Additive nullable agent author/creator columns have
exactly-one-actor checks and workspace-scoped FKs. Existing human fields/times
are preserved. Search, export, helper context, notifications and UI must handle
the actor discriminant before agent discussion writes are considered complete.

## Files, drafts and undo

Attachment-only contributions require real stored bytes. A bounded privately
staged object has an immutable server-selected ID, digest, size and ready state.
Publication validates current uploader/project rights and byte readiness inside
the message transaction; downloads reauthorize. Empty body is allowed only with
valid committed files. Failed saves retain staged private files and draft text;
no public file/root/result/notification may partially commit.

Conversation/Tasks/Map/Agents consume one account/project/task-scoped draft with
body, staged file IDs, references and command UUID. Pane changes and failures
retain it; successful confirmed publication clears it. #136 supplies the shared
shell, #152 the current MCP grants/tools and real-client evidence. Per-view form
state or an alternative shell cannot satisfy those integration criteria.

Safe unused AI-task undo retains the task ID as a read-only tombstone and adds
`task.creation_reverted` history. It never deletes the creation notice or revives
the task on a receipt replay. Current authority, trusted AI origin, expected
version and absence of persisted use are required under the same task lock.
Discussion/result/ownership/status/decision/dependency/handoff use prevents undo.
Delayed notifications must not deliver a fresh assignment for reverted work.

## Migration and acceptance

Reserve migration 0033; #58 owns pending 0026–0032. The #118 exact manifest permits
an isolated sparse 0025→0033 path, but both composition orders need real tests.
Never edit old migrations or infer/backfill notices, authors, roots, timestamps
or source bindings. Preserve old nonempty threads and placeholders with replies.

Schema reversal must refuse unrepresentable new actor/file content rather than
silently destroy it. Before new-feature use, verify a guarded lossless reversal.
After use, preserve the upgraded DB/files and test operational recovery from a
paired pre-upgrade backup and matching image; that recovery does not claim to
retain post-backup writes. Lossless downgrade after such writes remains an
explicit acceptance question, not a completed or weakened AC-4. An old binary
cannot run on the upgraded exact ledger, and manual ledger edits are forbidden.

Acceptance needs Docker API/UI/persistence/race/failure evidence, historical
fixtures and rollback/restore evidence, real authorized agent entry paths, shared
draft/root identity in the integrated #136 views and a separate neutral visual
review. Missing file/MCP/import/shell or migration checks remain unverified.

## Canonical text implementation and historical human checkpoint

The current text slice uses `GET/POST /api/v1/work/:workId/discussion`. Its pure
core use case checks current project access under a transaction, then the shared
conversation command lock, task-row lock and conversation sequence. Normal
conversation sends and task text contributions share the same database append
primitive. A task-specific operation fingerprint prevents reusing an unrelated
conversation command receipt. The binding's composite foreign keys require the
exact sequence-1 root in the same scoped conversation. Reads return the explicit
root even outside the bounded newest-message window and never create content.

The initial human checkpoint supports authenticated human text and exact
material-version citations. Its evidence remains pinned to that historical source.
The later actor checkpoint implements genuine trusted agent text and the affected
conversation/list/root, helper context, Search, export, notification, Return/digest
and browser consumers using the correlated variants below. No agent is represented
by a human user. Actual authenticated MCP operation/grant/runtime composition and
supported local clients remain integration requirements under #152/#153.

Attachments, blocker/result/handoff adapters, unused-AI undo, integrated shared
drafts and compatible migration reversal remain required. The current
[source-pinned actor and layout evidence](../agents/evidence/154-task-notices/actors-and-layout/README.md)
is incremental verification, not a reduction of AC-1–AC-5 or whole-task acceptance.

## Accepted actor compatibility delta

The independent [actor design assessment](task-discussions/2026-09-30-actor-design-review.md)
accepts two correlated wire variants: unchanged human `authorId`/`createdBy` strings,
or null human field with required explicit `{kind:'agent',id}` actor. Apply creator
identity to both conversation and list summary. Internally every author is a
mandatory actor reference; no fabricated user or opaque agent string enters a
human field. Friendly agent names are display metadata and always retain an agent
marker. Human-only DMs/material authors remain human. Mixed-conversation support
requires the current actor-aware browser; arbitrary old clients are not certified.

Actor storage uses exactly-one human/agent checks, restrictive workspace-scoped
agent FKs and separate per-agent durable retry uniqueness with kind-scoped locks.
Revocation preserves historical authorship. Existing owner-account deletion can
be refused by restrictive authored-agent history; no message deletion substitutes
for an account-erasure policy. Reads of past messages do not require the old author
to retain present access. Search/export/helper/notifications/return digests and
browser author actions must preserve the actor before agent writes are enabled.

Migration0033 is frozen at the implemented human-root source. Reserve **0037 for
this #154 actor extension**, after0034/#152,0035/#153 and0036/#74 agreed on the
coordination issue. No old migration or historical author/time/source is rewritten.
Guarded pre-use reversal and refusal after unrepresentable agent/file use remain
required migration acceptance, not an implied completed rollback.

## Transaction-bound co-work composition

The #153 composition root prepares a `taskDiscussionInTransaction(tx)` session
inside its actual open exported core `Transaction`. The trusted use cases return
canonical contribution IDs and collect immutable actor/workspace/project/kind
event intents; they acquire no stream-sequence lock during preparation. The
session opens no transaction and commits nothing itself. The caller establishes
current authenticated connection/runtime/action-grant authority and locks it
before command identity and sorted domain task/conversation locks. It then writes
its fenced control-request resolution, use debit, durable receipt and outgoing
intent before awaiting `flushEvents()` as its final domain operation. A receipt,
claim ACK, client payload or display name never supplies that authority.

The flush resolves **all** queued audiences before the first event insert takes
the stream-sequence lock. Only final event storage and its derived audience/outbox
rows follow that lock. A loop of the old inline recorder is insufficient because
it would evaluate later audiences while already holding the lock. The session
closes when flush begins, rejects later commands and returns the same flush promise
on repeat; a replay queues no event. Any preparation or flush failure must escape
and roll back the caller's transaction. There is no asynchronous/post-commit flush.
Ordinary HTTP keeps one transaction and automatically awaits final flush after its
action completes. Actual #153 receipt/generation/claim recovery remains a separate
integration obligation, not proved by this adapter's rollback fixture.
