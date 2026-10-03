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

Attachments, unused-AI undo, integrated shared drafts and the complete compatible
migration reversal remain required; the blocker, result and public-handoff effects
are implemented in [the next section](#explicit-native-effects-on-the-canonical-thread). The current
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

The independently accepted [native work/result composition](task-discussions/2026-10-01-native-event-composition-review.md)
provides `nativeWorkInTransaction(tx)` for work/result/decision and discussion
commands sharing one collector and final flush. Use this one session when combining
domains; do not flush a separate discussion-only session mid-composition. Ordinary
work and helper proposal acceptance prepare their response/domain writes before
one awaited final batch. The collector snapshots nested canonical data and tracks
every admitted action. These primitives supply no connection/runtime/grant, quota,
receipt or coordination authority; #152/#153 retain their own current FIRST fence.

### Read-only root seam for alias consumers

`getDiscussion` returns the root plus a bounded message window under the access-row
lock and always returns exactly the declared `TaskDiscussion` keys (never the stored
binding row). A consumer that needs only the task's canonical identity, such as the
#153/#155 task-to-conversation alias, uses the pure read beside it, on
`taskDiscussionUseCases(db)`, `taskDiscussionInTransaction(tx)` and
`nativeWorkInTransaction(tx)`:

```ts
getDiscussionRoot(principal: Principal, workId: string): Promise<TaskDiscussionRoot | null>
type TaskDiscussionRoot = { workId; workspaceId; projectId; conversationId; rootMessageId }
```

It validates the UUID like the other operations and needs current `project.read`
without the access-row lock. A task in a project the caller cannot see, and an
unknown task, are the same `WORK_NOT_FOUND` 404 (`getDiscussion` and `contribute`
share this mapping, so the error never reveals that a task exists). `null` means
only that a visible task has no genuine contribution yet. Otherwise the exact
sequence-1 root is checked as in `getDiscussion` and its identity returned; later
messages never move it. It creates no conversation, message, binding, name, event,
outbox or other row. Inside a caller transaction it queues no event intent and is
rejected after that session's `flushEvents()`. It supplies no connection, runtime
or grant authority; there is no HTTP route for it.

## Explicit native effects on the canonical thread

First part of the [2026-10-01 contract](task-discussions/2026-10-01-contribution-effects-and-files.md)
(files and attachment-only contributions are not part of it). Its
[independent assessment](task-discussions/2026-10-01-contribution-effects-and-files-review.md) corrections on
effects, atomicity, hooks and lock order apply; the file corrections remain for that part.

- **Meaning.** A nonempty explicitly saved blocker contributes its exact saved text; clearing it or changing only
  status/owner/title/outcome contributes nothing; creation with a blocker keeps only its creation notice. A result
  creates one canonical result and one authored contribution per linked task (body: the result title, marker:
  that result's id). A result with no linked task creates no thread. An explicit public handoff is
  `POST /api/v1/work/:workId/discussion` with `kind: "handoff"` through the same primitive as text; blocker and
  result kinds cannot be requested directly, the generic conversation entry takes no kind, and heartbeats,
  acknowledgments and private logs never contribute.
- **Wire.** A message of an explicit effect carries `contribution`: `{ kind: 'blocker' | 'handoff' }` or
  `{ kind: 'result', resultId }`. Ordinary text omits it, so human JSON is unchanged; genuine agent authors keep the
  tagged `author` variant. Conversation, task-discussion root/window, the browser and `getDiscussionRoot` agree.
- **Storage (migration 0040).** `project_messages.contribution_kind` (default `text`, so historical rows are
  truthfully plain text and nothing is inferred) and `result_id` with a scoped composite FK to the result and a check
  that the kind `result` and a result id go together; `native_command_receipts`, one row per real actor, project,
  operation and client UUID with fingerprint, produced task version or result and the contribution message ids. The
  guarded pre-use reversal is `app/packages/db/migrations/reverse/0040_native_contribution_effects.down.sql`: it is not
  a numbered migration and refuses once a receipt or a non-text contribution exists.
- **Mandatory hook.** `WorkPorts.contributions` (`WorkContributions`) is required by type. Every work adapter composes
  it (`createWorkContributions`) over the same transaction and event session as the discussion use cases: ordinary
  HTTP, `nativeWorkInTransaction` (same-transaction agent execution), the helper proposal acceptance and the tests'
  failure injections. It opens no unit of work, commits nothing and never flushes.
- **Order.** Current project write access, then the command's durable identity (the native receipt, then every
  derived message identity, sorted), then the project task-graph lock when the command starts or finishes a task
  or replaces prerequisites ([native plan order](agent-connection/2026-10-01-native-plan-contract.md); a plan
  material row, only on creation, precedes the identity), then the complete sorted task set (a finishing result
  locks its linked tasks and the finisher's prerequisites in ONE ascending pass), then the domain writes and
  canonical appends, then the receipt, then ONE final all-audience event batch owned by the caller's unit of work. The
  handle enforces `prepare` → `lockTasks` → `append` once each. A generic reply to a task-bound conversation
  discovers the binding without locking and takes the task row before the conversation sequence, like every
  contribution. Message identities are deterministic from the stable command (or the canonical result) plus the
  exact task. The helper acceptance path uses its locked proposal as the command identity and only reads the task it
  finishes (authority check); the result then locks that task in the order above and fences the version it read.
- **Retries.** `clientCommandId` on `PATCH /api/v1/work/:id` and `POST /api/v1/projects/:id/results`; semantics in
  [work and decisions](work-decisions.md#contributions-to-the-task-conversation-154).
- **Consumers.** Search, notifications, Return and helper context needed no code change: each reads the real
  authored body and actor, which is what the contribution is. Their output legitimately changes: the Return view and
  "Since you left" count the opening of a task thread that a result created like any new conversation, and the
  Conversation tab's default (the project's newest conversation) can now be a task thread. Both are interim
  behavior for the integrated #136 shell to settle, not a decision made here. Portable export carries the marker
  additively.
- **Not in this part.** Stored files and attachment-only messages, shared drafts, unused-AI undo, #152/#153 tools
  and import.

## In the project stream (web, 2026-10-03)

The one project stream (UI116-1) shows both halves of UI116-3:

- **Announcements.** The conversation route reads `GET /api/v1/projects/:id/task-notices` (newest first) beside
  the newest roots. Each announcement is one compact line, merged with the roots by time (an announcement first at
  the same instant): "New task · creator", then the task's current title, which opens exactly that task in Details.
  It has no replies, actions or avatar. While earlier roots are not loaded, announcements older than the first
  loaded root stay hidden with them; loading those roots shows them in their place, and older announcement pages
  are read as far back as the loaded roots reach. A refresh that skipped past the loaded announcements reads
  forward until it meets them. Reading never creates an announcement, task or root.
- **The task's root.** `GET /api/v1/projects/:id/conversation-roots` adds `task: { workId, title }` (the current
  title) to a root that opened a task's discussion. The stream and the thread header show it as the task's chip;
  replies from the thread drawer use the task contribution operation and the shared task draft described below.

- **Details of a task.** A Discussion section reads `GET /api/v1/work/:id/discussion?limit=1`: the root with its
  true author and time and the reply count, linking to the thread in Conversation. Before anyone has written, a
  person who can write starts it there with `POST /api/v1/work/:id/discussion` (`kind: 'text'`). Its draft and
  retry id are the task's own, `task:<id>` and `task:<id>:pending` in the browser's draft store: the identity the
  Agents task composer (#183) uses, so a lost answer retried from either stores the message once.

Still open in #154: unused-AI undo and real #152/#153 clients. The shared composer and stored-file UI slice below
requires its own commit-specific functional and visual evaluation before delivery.

## Stored files and attachment-only messages (#154, migration0045)

The file slice follows the [accepted contract and independent corrections](task-discussions/2026-10-01-contribution-effects-and-files.md).
Human HTTP uploads stage private files through `POST /api/v1/projects/:id/files`
with `application/octet-stream`, stable `uploadId` and display `name` query fields.
Responses expose measured size and SHA-256. `attachmentIds` on conversation start,
ordinary reply and task discussion append publish the uploader's ready files in
one transaction with the authored message. Raw `body` remains empty for files-only
messages; optional message `files` carries ordered id/name/size metadata. Empty
body without files is rejected. Bound task replies use command → sorted file →
sorted task → conversation locks. Exact command replay retains the original
relationship after current policy checks.

`FileStorage` uses private `attachments/tmp` and immutable
`attachments/objects/<first two UUID characters>/<UUID>` under `FLUX_FILES_DIR`.
File bytes are synced outside SQL; the short uploader-locked finalization checks
the live reservation, renames and syncs directories before ready SQL; paths never use client
names or follow symlinks. Limits are5MiB per file,10files/20MiB per message and
100MiB staged per uploader/project. Receiving reservations expire in15minutes;
ready unpublished files in7days. Ready-UUID replay uses a bounded digest-only
stream and a zero-byte serialization marker, so an uncertain response can be
recovered at the full quota. A10-minute bounded cleaner retires at most50expired
rows, and durable `file_garbage` tombstones retry unlink and directory sync. It
never deletes published files. An uncertain finalization first reads the actual
row under the admission lock and retains possibly committed bytes.

Download rechecks current project access, uploader ownership for private staging,
expiry and actual byte integrity. Responses are generic attachment octet streams
with encoded display names, `nosniff`, private `no-store` and sandbox CSP.
Notifications, Return and conversation labels use a system attachment-count
preview without inventing authored text. Helper context includes filename/size/id
and actual contribution/result identity; it does not feed file bytes to a model.
Search preserves the actor and raw body. [Portable export](../operations/export.md)
includes exact bytes and manifests through both HTTP and the operator CLI.

Migration0045 adds scoped file/message identity, optional relationship metadata
and the body-or-attachments invariant without backfilling old messages. Its
[guarded pre-use reversal](../../app/packages/db/migrations/reverse/0045_stored_files.down.sql)
refuses file or deletion-queue use. Operational recovery uses paired DB/files
backup. Shared composer drafts and rendered UI acceptance remain the separate
#136 integration; #152/#153 must compose real grant checks before agent file writes
can be enabled. Real client and device evidence is still required for release.

## Shared structured composer slice (#154/#136, 2026-10-03)

The accepted Files/drafts contract above applies to one browser record per signed-in
account, project and task, shared by Conversation, Tasks/Map Details and Agents.
The record holds body, ordered private upload metadata/staged IDs, exact material
reference, command UUID and unconfirmed state. Ordinary conversations and new
project roots retain their own scope. Private helper prompts use a separate scope;
public body/files/references never become helper input through a view switch.
Human DMs and authenticated agent file operations retain #225's unavailable status.

A send captures its original scope and immutable command. Every task-bound composer
uses `POST /api/v1/work/:id/discussion` with `kind: 'text'`, so a lost-response retry
from another view retains `task.contribute` and the exact work ID in its durable
fingerprint. Failed or uncertain sends retain the entire draft. Only confirmed
publication clears the matching command; delayed A results cannot clear B or
navigate a person away from their new work. Selection order is publication order.
Local file/count/total checks retain existing text/files/references; server checks
remain authoritative. Unconfirmed uploads retain their upload UUID; bytes stay in
visit memory, and after reload recovery explicitly asks for the same file. Draft
storage refusal keeps the current visit's newest copy and visibly describes its
limit. Ready private files expire under #225's policy and failed publication does
not silently discard them. An expired staging timestamp is shown truthfully; an
unconfirmed send keeps its original command because published files survive that
timestamp. The server resolves a retry against current access and durable receipt.
If an unpublished file is unavailable, the person explicitly removes and selects
it again; that payload change receives a new command UUID while text and reference
remain. A revoked or unavailable file/source response does not falsely imply that
the person's text was sent or erased. Because send `404` deliberately also hides
unavailable file/source identity, the composer confirms actual project access
through the existing authorized project read before hiding the conversation UI.

Agents task selection freezes the previous composer at navigation start, before
another input can reach it. While the next task/project route is loading, its
textarea, file controls and send are disabled, with a visible opening status.
The selected destination is shown, but only the committed, authorized task's
mounted composer can edit or send. Cancellation restores the original scope;
loader failure shows the route error and preserves both complete records. The
navigation requests the documented [synchronous DOM update](https://reactrouter.com/api/hooks/useNavigate)
and uses the [DOM RouterProvider](https://reactrouter.com/api/data-routers/RouterProvider)
that supplies it (React Router 8.4, checked 2026-10-03).

**Additive wire delta, independently agreed by the coordinator before mapping:**
`ConversationFields.task?: { workId, title }` has the same shape and current title
as `ConversationRoot.task`. After ordinary current project authorization, the
conversation GET reads the exact binding scoped to the same workspace, project,
conversation and genuine canonical sequence-1 root. Every bounded message window
carries this identity, even when neither its root nor the stream's old root is
loaded. Ordinary conversations omit it. This avoids routing a deep-linked task
reply through a competing generic-operation fingerprint. Reads write no domain
rows, new endpoint or migration; no legacy relationship is inferred or rewritten.

Validation for this slice includes full/bounded GET binding and non-task absence,
real authenticated two-person file-only roots/replies and exact downloads, lost
response replay across views, failed/revoked/conflicting/expired upload retention,
held async A→B→A and account/project changes, reload/storage refusal, keyboard/focus
and rendered 320/390-phone and 1440-desktop evidence. These checks and separate
visual/functional review remain required; this record does not certify them.
