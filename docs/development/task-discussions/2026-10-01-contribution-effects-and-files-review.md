# Independent design assessment — #154 contribution effects and stored files

2026-10-01 Europe/Warsaw. Reviewer `/root/task74_github_app`, independent of
#154 authorship. Reviewed proposal
`docs/development/task-discussions/2026-10-01-contribution-effects-and-files.md`,
SHA-256 `dd91e3613f66d8950d5eedb35b6beb70fb2839a75f707507dc0a31fd9f67a3bc`,
against the accepted 2026-09-30 task-discussion design and independent assessment,
current d1d03f70f1ddb7c78d05216ac570c9359cb5290c native adapters/core work and
discussion/append entry points, and #152/#74 composition constraints. Read-only;
no peer source edits, runtime tests, GitHub approval or full-task acceptance.

**Accept the native blocker/result/handoff contribution model and mandatory
same-session hook. Accept the local private staging/SQL-ACL file architecture,
with the following precise contract corrections required before corresponding
file/schema/command implementation.** These elaborate the existing required
atomicity/current-authority/recovery criteria; they do not lower them.

Accepted native boundaries: one canonical root/flat sequence and real actor;
nonempty explicitly saved blocker contributes exact saved text, clearing/status
alone does not; one canonical result ID with deterministic per-linked-task
contributions; explicit public handoff through the common primitive, no ACK/log
publication. Prepare every native contribution command identity before any task
lock, complete the full sorted task set before append, and retain #152's ONE
connection-command debit/receipt ledger. All domain/receipt/outgoing/response
preparation precedes one all-audience/final-event batch. Mandatory adapters must
include ordinary HTTP, same-TX agents, helper accepted results and all generic
bound-conversation replies; an optional/no-op hook cannot certify these effects.

1. **Complete file durability before the ready row.** Fsyncing a temporary file
   followed by rename does not itself make the new directory entry durable.
   Record: fsync the bytes, atomic rename within the owned volume, fsync the
   containing directory (and required newly created parent entries) before SQL
   commits `ready`. Cleanup/unlink must follow the same explicit durability and
   ownership rules. Inject crash/fault around rename/directory-sync/ready commit;
   a ready/public row cannot refer to bytes lost by the documented crash model.
   Reject a storage adapter without these guarantees instead of pretending its
   `ready` flag is proof. This does not require a new storage service.

2. **Do not hold a database quota/command transaction while receiving an
   arbitrarily slow upload.** The text leaves whether streaming spans the
   uploader/project lock unspecified. Use a bounded durable reservation/claim:
   briefly authorize and reserve UUID/quota, stream and fsync owned bytes outside
   domain/receipt locks, then reauthorize uploader/project and finalize the
   exact reservation/digest under a short transaction before `ready`. Alternatively
   stream to bounded private scratch first, then perform only a bounded local
   finalization under quota locks. Reserve in-flight bytes as well as ready staged
   bytes so concurrent uploads cannot exceed quota. Failed/cancelled/uncertain
   finalization must release or safely expire its reservation, never reuse a
   different payload or leave an idle transaction. Current access is checked
   again after bytes are staged, not inferred from admission.

3. **Record the full command/file/task order and cleanup exclusion.** Specify
   authority/runtime/action grant/source versions → all native command identities
   → uploader/project quota slots when used → sorted file IDs → complete sorted
   task IDs → conversation sequence → all receipts/outgoing/response → final
   audience/event batch, with any #152/#153 shared-order delta independently agreed.
   Generic replies to an already bound conversation must discover its exact task
   without locking and enter this same order; they cannot lock conversation first
   and later acquire task/file/command locks. Cleanup locks the corresponding
   quota/file rows, rechecks unassociated/claim state under the same locks, and
   never acquires task/conversation afterwards. Publication locks those file rows
   and records the association atomically so a cleanup race cannot delete bytes
   about to become public. No speculative delete/rename after a ready public
   reference, and no provider credential acquisition after these native locks.

4. **Make retention/draft and publication-identity semantics exact.** Choose and
   record ready-unpublished/failed-reservation retention durations, cleanup batch
   bounds and zero-byte policy before schema/validation code. A draft referring
   to a legitimately expired staging row must retain text/send intent and show
   that the file needs reattachment; it cannot claim send readiness. Published
   bytes are excluded from abandonment cleanup. Specify one publication owner
   per file unless deliberate authorized reuse is admitted; exact same-command
   replay returns the existing relationship under current authority, while a
   different command reusing a published staging ID conflicts. Both normal
   conversation and task surfaces obey that rule. Guessed/unpublished foreign
   IDs reveal no filename/size/readiness/count to other uploaders.

5. **Pin every new contribution/file projection and retry envelope.** The
   current shared wire/DB message converter must carry canonical kind/result/file
   identity, including root + paged windows, ordinary conversation/list/preview,
   Return/digest, helper context/continuations/proposals, search/snippets/counts,
   notification generation/inbox/send, portable export and source/result links.
   Metadata-only consumers may deliberately omit file bytes, but cannot fabricate
   a text contribution or lose the attachment-only root identity. Downloads and
   exported attachments prove current central audience and any source ceiling;
   ordinary project membership does not authorize later #74 private-derived
   content. A stored native/agent receipt must carry relevant immutable source
   identities/versions/provenance and recheck current authority before returning
   its original value, not merely rerun broad project policy. Future source effects
   remain disabled until their separate canonical consumer conversion is accepted.

Sparse migrations0040/0041 are proposals, not allocation proof. Confirm the
shared reservation with #153 before writing; never rewrite0033/0037 or pending
peer migrations. Pre-use reverse/post-use guarded refusal and paired original
image/DB/files recovery preserve their stated limits. Real bytes in portable
export plus exact actor/result/file relationships are required evidence; no
production import or post-backup write preservation is inferred.

Next: record these bounded corrections and shared lock order, then implement the
accepted native effects/file paths in the owner's branch. Obtain fresh independent
runtime/UI/persistence/race/recovery evaluation at the resulting head. Current
human-only HTTP authentication stays human; genuine agent file/contribution
operations remain unavailable until actual #152/#153 operation/grant/runtime
composition is implemented and verified. Full #154 remains open.
