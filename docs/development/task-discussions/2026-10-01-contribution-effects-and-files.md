# Complete native contribution effects and stored files — #154 implementation contract proposal

2026-10-01. Proposed precise interfaces within the already accepted154 AC1–AC5,
UI116-3 and2026-09-30 design, before new command/schema writes. Current shared
native runtime is daa66f0, evidence head d1d03f7. No criterion is waived. Design
review and schema reservation precede implementation.

## Explicit native effects on the canonical thread

All production work adapters compose one native session. Its mandatory core
contribution port prepares command locks and appends through the same task
contribution core use case on that session; it never opens or flushes a nested
unit. Direct human/agent text keeps its existing public identity. Associated
blocker/result/handoff commands identify their real contribution kind and retain
canonical result identity, not just a copied summary or event-log projection.

A nonempty explicitly saved blocker in updateWork is one authored contribution
whose exact body is the saved blocker, together with the version-fenced task
change. Clearing a blocker or changing only status/owner produces no comment.
A createWork command with a blocker still emits its compact creation notice;
creation fields alone are not a separate saved blocker contribution.

A published result linked to native tasks creates one authored result contribution
in every linked task, using the accepting/creating principal and exact result ID.
The body is that author's result title; a typed result reference presents the
canonical finding/evidence and sources through its ordinary authorized API. A
result with no linked task creates no task thread. Preserve private helper prompt/
in-flight output; publication only occurs through the existing explicit accepted
result command. A public handoff instruction uses the same contribute command
with handoff kind, real body, optional bounded authorized versioned sources and
files. #153 alone supplies current sender/runtime/claim/generation authority;
heartbeat/ACK/private logs do not call this command.

Add optional clientCommandId to native update/result commands while retaining
old no-key compatibility. Browser new commands always provide stable UUIDs.
Native command receipts are operation/project/real-actor/UUID/fingerprint-scoped,
retain original produced object IDs and versions, and are distinct from #152's
ONE connection-command grant-use ledger. Revalidate current authorization and
canonical source/postcondition before exact replay. Changed payload conflicts;
changed produced work state is stale rather than overwriting it or appending a
second contribution. No-key result creation cannot deduplicate indistinguishable
retries; version fencing prevents a second identical stale blocker update.

Prepare all contribution UUIDs deterministically from the stable domain command
or canonical result plus exact task ID. Lock authority/source/agent ledger and
all native command identities before complete sorted native task IDs. Acquire
all relevant command locks before the first task lock, not by repeatedly invoking
an independently locking command after tasks are locked. Then append canonical
messages/relationships and associated effects; response hydration, grant debit,
receipts and outgoing intent finish before ONE native final-event flush. Native
result/source references have scoped composite FKs. All app consumers preserve
the actual actor, result ID, chronology, kind and current audience. A provenance
restriction imposed by later74 cannot be replaced by broad project membership.

## Real bytes and attachment-only contribution

Use the accepted local files volume via one injected core-owned FileStorage port
and server adapter, without core filesystem/SQL imports or a new host service.
Stage privately through POST /api/v1/projects/:projectId/files: raw bounded bytes,
current authenticated uploader/connection operation authority, stable upload UUID
and a sanitized display-name parameter. Defaults/limits are explicit: maximum
5MiB per file,10 attachments/20MiB per message,1–200 display-name characters and
100MiB live staged bytes per uploader/project. Reject control/path characters;
the client never supplies storage path or a trusted MIME/digest/size/ready flag.
Store server-selected random object IDs, exact size/SHA256 and generic safe
application/octet-stream type; serve only attachment downloads with nosniff and
private no-store headers. UI previews are readable file name/size, not executable
HTML/SVG or an unverified media renderer.

Stage bytes to a uniquely owned temporary file, verify measured limit/digest,
fsync and rename to the final immutable server path BEFORE committing a ready SQL
staging row. Ready-row failure can leave unreachable private bytes; it must never
produce a public reference to missing bytes. Bound abandoned staging retention
and cleanup to the uploader's own unassociated objects, never published bytes.
Same upload UUID+same bytes/name returns the original ready object after current
access/uploader checks; changed content conflicts. After an uncertain committed
upload response, retry retains its exact ID. Serialize quota/UUID admission under
one uploader/project lock; bytes are never publicly addressable without SQL ACL.

Messages accept attachmentIds plus body (empty only with at least one valid ready
file). In the contribution transaction validate current uploader, exact project,
ready immutable byte identity and all file rows, then insert canonical message/
file relationships. Lock file IDs in stable order before task/conversation writes;
no filesystem/metadata lookup follows the first stream insert. Another uploader's
unpublished staging row, guessed ID, foreign project or missing/corrupt bytes is
unavailable. A new publication cannot reuse an attachment already published by
another command. An exact same-command replay retains the old relationship and
requires current readable publication/source, not a new upload or second message.
Rollback leaves staged private bytes recoverable and no public attachment/root/
result/event/outbox. Download GET /api/v1/files/:fileId reauthorizes the exact
message/task project's current central policy (and any actual source-provenance
ceiling) before opening bytes; unassociated files are uploader-only. A staged
filename does not leak through list/total/search to other members.

Conversation/Tasks/Map/Agents share one account/project/work draft key containing
body, staged file IDs, bounded source/result refs and stable send UUID, clearing
only on confirmed publication or successful sign-out. Failed upload/send, access
loss and pane changes retain recoverable own draft data without sharing files.
#136 integrates the existing composer/draft API instead of inventing a parallel
shell. Normal bound-conversation replies use the same attachment append and root.

## Migration, export and verification

Propose sparse migrations0040 for native contribution kind/result reference and
native command receipts,0041 for ready stored files/message relationships. Existing
0033/0037 and peer migrations remain immutable. Reservation on153 must avoid peer
0040/0041 allocation; update exact highest manifest only when each file lands.
Old human messages remain wire-compatible when no new optional fields exist;
no inferred roots/files/results, no historical author/time/sequence backfill.
Guarded pre-use reverse must refuse actual new receipt/result/file use. Operational
rollback uses tested paired DB/files backup and exact matching image; it preserves
upgraded data separately and does not claim post-backup changes survived recovery.

Extend portable export intentionally: exact file manifests and stored bytes in
bundle, result-discussion relationships and actual actors, with authorized current
source limits and schema version/consumer changes recorded before release. Do not
relabel metadata-only export or paired restore as production import support. #118
still requires both pending26–32 composition orders and full restore evidence.

Required actual Docker evidence: blocker/result/handoff each becoming first root,
multiple linked tasks sorted before first append, two human actors and genuine
agent, every normal adapter/helper acceptance, exact stable retry and changed
intent/current-source/poststate conflicts; injected failure at each associated
write and before/after final batch; concurrent first contributions/native effects/
undo and opposing sorted tasks. For files use actual bytes, zero/oversized/failed
upload, quota, digest, crash/uncertain response, corrupt/missing objects, foreign
uploader/project, revocation between staging and publication, same-key payload
changes, files-only and multi-file race, actual restricted download, restart and
paired backup/restore/export byte equality. Exercise real UI recovery/shared drafts
and all consumer projections; keep absent136/152/153/supported-client/device checks
explicitly unfinished. Independent review of each new tested head remains required.

## Recorded independent corrections before the corresponding implementation

Independent assessment [here](2026-10-01-contribution-effects-and-files-review.md)
accepts the native model and file direction at original proposal SHA dd91e361,
with five bounded corrections. The following are part of this implementation
contract; the report is not runtime or whole-task acceptance.

1. FileStorage must fsync file bytes, perform an atomic rename within its owned
volume, then fsync the containing directory and any newly created parent entries
before ready SQL can commit. Failure around any step leaves no ready/public row.
Only immutable server paths are opened without following symlinks; cleanup unlink
and required directory sync follow the same ownership/durability boundary.

2. Upload admission briefly authorizes and reserves maximum5MiB under exact
uploader/project quota and upload UUID; it never holds SQL/domain locks while
receiving network bytes. Stream into owned private scratch outside SQL with5MiB
measured limit and a30-second receive bound, then fsync/rename and reauthorize
current uploader/project/actual agent operation before a short ready finalization.
In-flight reservations count toward100MiB together with unassociated ready files.
An upload cannot acquire other source/task/conversation/event locks while streaming.
An in-flight duplicate UUID reports UPLOAD_IN_PROGRESS; committed same UUID checks
actual measured bytes/digest/name and returns its original ID, different content
conflicts. Failed/disconnected reservations expire after15minutes without renewal;
ready unassociated files expire7days after original ready time, not last draft view.
Cleanup claims at most50 expired rows per batch under quota then sorted file locks,
rechecks association/in-flight generation and never acquires task/conversation.
Published bytes/relationships never enter this abandonment cleanup.

3. Zero-byte uploads are rejected. Valid files are1byte–5MiB. Each file has one
publication message; another command reusing a published staging ID conflicts.
The exact same command replay retains its original relationship after current
scope/provenance checks. Expired staging leaves draft body/send UUID/source refs
recoverable and visibly requires file reattachment; it cannot claim the old file
is ready. Display names reject control/path characters and names '.'/'..'; generic
octet-stream attachment downloads use nosniff/private no-store and safe encoded
Content-Disposition. No executable inline preview or client MIME/path is trusted.

4. Current authority/runtime/action grant/source versions and ONE agent ledger
fences precede native command identities. For source-free154 native composition,
all native command identities → uploader/project quota slots if needed → sorted
file IDs → complete sorted task IDs → actor/conversation sequence → all receipt/
outgoing/response writes → final audiences/events. Normal conversation sends to
a bound thread discover the exact binding without locking and enter that same
order; they cannot acquire conversation first. Existing152/153 slot/graph/source
categories retain their separately accepted order, and any74 credential/source
publication hook must be independently aligned before it can be used. No provider
credential acquisition follows native task/file/conversation locks.

5. Required conversion inventory at current daa66f0 (paths relative to app):

| Consumer | Native contribution/file identity and current authority requirement |
| --- | --- |
| packages/core/src/task-discussions/{service,ports}.ts and apps/server/src/work/task-discussions.ts | One canonical root plus newest window, actual kind/result/file IDs, stable actor/operation fingerprint and current source checks; same prepared append for effects and direct sends. |
| packages/core/src/work/{service,ports}.ts and apps/server/src/work/adapters.ts | Mandatory same-session blocker/result hooks; every command identity and full sorted task set before append; helper/native response then one final batch. No optional no-op port. |
| apps/server/src/conversation/{store,routes}.ts and packages/core/src/conversation/{service,commands}.ts | Generic normal/bound replies preserve canonical kind/result/files; exact retries and binding/file/task order; attachment-only admission only with real valid bytes. |
| apps/web/src/app/ProjectConversation.tsx, app/conversation-api.ts; work/WorkDetails.tsx; shared136 task composer/draft projection | Render actual result links and file name/size/download, same root/task draft identity and recovery in all four views; no fresh shell or fake body for empty file messages. |
| packages/db/src/repositories/personal-runs.ts; packages/core/src/personal-runs/{processor,service,proposals}.ts; apps/server/src/personal-runs/adapters.ts | Metadata references retain exact contribution/result/file identity; helper never reads bytes or private staging implicitly. Explicit accepted result publication uses actual accepting human and native hook. |
| packages/db/src/repositories/{search,returns}.ts; packages/core/src/{search,returns} ports/service; apps/server/src/{search,returns} adapters | Preserve exact canonical root/message/result/file refs before current-ACL snippet/count/page/digest projections. File metadata can be omitted deliberately but attachment-only content is not fabricated as authored text. |
| packages/db/src/repositories/notifications.ts; packages/core/src/notifications/{generate,ports,email}.ts and push/notifications.ts; apps/server/src/notifications/adapters.ts | Actual actor/message/root links and truthful system previews; no staged-file names/counts to others; reauthorize association/source at creation/read/send. |
| packages/contracts/src/{conversation,work,export}.ts; packages/db/src/repositories/project-export.ts; packages/core/src/export/{service,bundle}.ts | Versioned exact canonical actor/kind/result/file relationships and real authorized file bytes; do not advertise ordinary metadata-only v1 or paired restore as production import. |
| Actual152 reads/commands/bootstrap and153 handoff/request/resume adapters | Current verified connection/grant/runtime/claim/source fences and immutable provenance in ONE ledger retry packet. New agent file/contribution tools stay unavailable until this real composition is independently verified. |

Ordinary human HTTP remains human authenticated. Trusted agent core composition
cannot be nominated by an HTTP author field. A source-private74 derived state
cannot enter a broad project message/result/file or event by this154 command;
that distinct publication boundary stays disabled until its consumer agreement.
Schema0040/0041 allocation is recorded on153 before any new SQL write. Current
helper/native source, actor and deadline semantics remain unchanged until the
corresponding implemented/tested new head is recorded.

## Implemented at `a846a31` — explicit native effects (first part)

2026-10-01. Branch `codex-hubert/154-contribution-effects`, from `origin/main` `919c1db`
with later main merged. This records only the section "Explicit native effects on the
canonical thread" and the effects, atomicity, hook and lock-order corrections of the
[independent assessment](2026-10-01-contribution-effects-and-files-review.md). The
file-durability corrections, stored bytes, attachment-only messages, quotas, shared
drafts, migration 0041, unused-AI undo and the real #152/#153 tools are **not**
implemented and remain required. Operational detail is in
[the task-discussion record](../task-discussions.md#explicit-native-effects-on-the-canonical-thread);
verification is in the [evidence note](../../agents/evidence/154-task-notices/contribution-effects/README.md).

Final names. Contracts: `MessageContribution`, optional `ConversationMessage.contribution`,
`TaskContributionCommand` (`kind?: 'text' | 'handoff'`), optional `clientCommandId` on
`UpdateWorkCommand` and `CreateResultCommand`, optional `ProjectExportMessage.contribution`.
Core: mandatory `WorkPorts.contributions: WorkContributions` (`prepare` → `lockTasks` →
`append`, plus `confirm`), `ContributionAnchor`, `ContributionDraft`, `PreparedContributions`,
`NativeCommandReceipt`, `createWorkContributions`, `contributionIdentity`, `derivedUuid`,
`messageContribution`, and `WorkRepository.nativeCommand`/`recordNativeCommand`. Database:
**migration 0040** `0040_native_contribution_effects.sql` (`project_messages.contribution_kind`,
`result_id`, `native_command_receipts`; guarded pre-use reversal
`migrations/reverse/0040_native_contribution_effects.down.sql`; `FLUX_SCHEMA_VERSION` 40,
0039 belongs to #171 and 0041 is unallocated). Server: `workPorts` composes the hook in
every adapter; `taskDiscussionRows.lockBoundTask`.

Interpretations and refinements (none lowers a requirement):

- Native receipt operation names are `work.update` and `result.create`; the #152 ledger keeps
  its own `result.record`. A work-update replay checks the produced task version
  (`COMMAND_POSTSTATE_STALE`); a result replay checks the immutable result, its stored
  contribution messages, current authorization and the canonical sources, like #152's
  versionless `result` postcondition.
- Message identities are `UUIDv5`-layout hashes of operation, stable command (or canonical
  result) and exact task. Without a client UUID a fresh command UUID is generated, so only
  the version fence stops a stale identical blocker retry, as specified.
- The helper-accepted result path has no client command: its locked proposal is the stable
  command identity and is acquired before the task lock that proposal authority already takes.
  Its fresh result id cannot contend with any other identity lock.
- A public handoff is requestable by a human through the task-discussion route
  (`kind: "handoff"`); blocker/result kinds are rejected there and the generic conversation
  routes reject any `kind` instead of silently stripping it. One exact versioned material
  `source` is the existing canonical citation; several sources per message and files need a
  relation the files part adds, so plural handoff sources are a **remaining ambiguity**
  to settle with #153 and that part.
- Portable export carries the marker as an additive optional `contribution` (format version 1
  unchanged); a consumer validating strictly must use the schema in the bundle. #118 must
  record this. Search, notification, Return/digest and helper-context consumers needed no
  code change: they read the real authored body and actor, which is what the contribution is.
- Existing tests whose counts legitimately changed (a linked result now also opens or extends
  task threads) were updated: native session intents, export conversations and the Return
  summary, the Playwright work and return-view journeys (the Conversation tab opens the newest
  conversation, which can now be a task thread; the Since-you-left summary counts a thread's
  opening), and the agent-execution fixture, which now uses the production native composition.
  Whether the integrated #136 shell should keep that default is left to it. The new Chromium
  journey is part of `scripts/check_application.sh`.
- The tested application source is `a846a31c90513059b0ca79757ab9a38cb0c959ff`; later commits on the
  branch change only the Python browser journeys, documentation and evidence.
