# Native work and discussion composition — proposed bounded #154 delta

Date2026-10-01. Proposed for independent review before implementation. Original
issue154 AC1–AC5, the accepted actor/deferred-event contract and #152/#153
authority/one-ledger requirements remain unchanged.

## Problem and desired boundary

The current task-discussion session prepares genuine canonical IDs and flushes
all its events last. The existing work/result adapter still calls the inline
event recorder and the helper proposal adapter nests that result unit before
writing its proposal decision. Combining those adapters can take the global
stream-sequence lock before later domain/receipt/outgoing writes or later audience
queries. A nested savepoint shares atomicity but does not solve that lock order.

Provide one server-owned native transaction session with work use cases and task
discussion use cases backed by the same already-open exported core Transaction,
one event collector and one final flush. No core module imports another module's
SQL adapter. Core work ports retain their bounded domain contracts; a later
blocker/result/handoff contribution hook must use this same session, not an
independent transaction or another final flush.

## Proposed interface and lifecycle

`nativeWorkInTransaction(tx)` exposes the existing work use cases, genuine
`getDiscussion`/`contribute`, immutable `eventIntents` and `flushEvents()`.
`taskDiscussionInTransaction(tx)` remains compatible for discussion-only callers;
its implementation uses the same collector/lifecycle primitive. A caller that
composes work/result/discussion uses one native session and one final flush.

An internal transaction-event session snapshots trusted principal, scope, kind,
canonical identifier data and nested data before retaining an intent. It rejects
recording after closure. Every admitted asynchronous use case is tracked; flush
rejects while any admitted command is active, before closure. The first admitted
flush closes the session, repeated flush returns the same promise, and subsequent
commands fail. Read-only/replayed work queues no new event. The batch recorder
computes all final-state audiences before its first event insert, then writes
only events and their derived audience/outbox rows.

Current authenticated connection/runtime/grant rows remain #152/#153's FIRST
authority fence, ahead of one connection-command identity and sorted native task/
conversation locks. This session supplies no authority, quota, receipt, claim,
lease, grant or outgoing-intent store. Actual callers finish all their domain,
coordination, use-debit, receipt and outgoing-intent writes before awaiting final
flush. Failure at any stage escapes the outer transaction and rolls everything
back. There is no post-commit/asynchronous flush and no catch-and-commit fallback.

Ordinary work HTTP still opens one transaction through its existing unit of work,
prepares the action using this session and awaits final flush before commit.
An outer HTTP transport-cache unit can continue to wrap that transaction; this
does not make the24-hour transport receipt suitable for #152/#153 authority.
The helper proposal acceptance unit prepares native result and helper proposal
decision events into the same collector; after recording the actual accepting
human's result/proposal decision and rendering the response, it flushes once.
Unrelated helper run dispatch remains separately scoped; no provider behavior,
personal payer or private prompt/output publication is added by this delta.

## Explicit scope and verification

This delta establishes safe composition for existing native work/results and
genuine discussion. It does not yet add blocker/result/public-handoff messages,
files, AI undo, shared drafts, real MCP clients or migration reversal. A native
event session alone cannot satisfy those remaining original criteria.

Use actual PostgreSQL/HTTP regression for native task/decision/result operations,
existing helper proposal acceptance and affected notifications/Return views.
Inside a caller-owned transaction, prepare native work plus a genuine agent
contribution, assert canonical IDs exist without acquiring the stream lock, add
an actual final domain marker and change current recipients, then flush once.
Instrument the real transaction to fail any domain SELECT/write after first
event insertion; all audiences must have prepared first. Assert no nested commit,
same flush promise/closed guard, and actual exceptions before/after flush rolling
back work/notice/result/binding/messages/sequence/Search/events/outbox/marker.
Do not certify #152/#153 actual grants/receipts/generation from the marker fixture.

Keep production deadlines unchanged. Run build/type/lint/architecture and the
affected Docker API/helper/persistence cases. If any contract or runtime behavior
changes again, obtain relevant independent evaluation at that new source.
