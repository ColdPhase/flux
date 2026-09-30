# Independent deferred-event composition assessment — Flux #154 / #153

Date: 2026-09-30. Independent evaluator: `/root/review165_cli`; implementation owner: PelikanFix16. Read-only source assessment of local clean `2ae9bfaab4474bdc903a7071eef1742aa5a93681`, `packages/core/src/events.ts`, canonical task contribution ports/use cases, the transaction-bound server adapter, accepted task-discussion/actor contracts and the current #153 composition exchange. No production code, grant or GitHub approval was changed by this evaluator. This accepts the design boundary below before implementation; it does not certify future code or whole-task completion.

## Accepted boundary

Use a preparation/final-flush session bound to the existing exported **Transaction** type. Reuse the same trusted canonical contribution use cases and tx-bound current-policy, command, task, sequence and repository ports. The session's event port collects immutable typed event intents containing the real principal, workspace/project, supported event kind and canonical IDs; it must not acquire the global stream-sequence serialization lock during contribution preparation.

The #153 caller establishes and locks current authenticated connection/project/action/class/audience authority before durable command/claim and domain locks. It then performs canonical contributions and its own fenced coordination resolution, durable receipt and outgoing-intent writes in this **same** outer transaction. Only after those writes does it await the session's final flush. No raw executor or pool is exposed through a returned session, no nested independently committing transaction is introduced, and no duplicate message/result content store is added. Exact immutable result IDs remain required; this adapter does not invent result versions or grant publication authority.

The ordinary HTTP task-discussion unit of work creates the same preparation session, awaits its action, then awaits the flush inside its current database transaction before returning success. Existing command receipts return the stored canonical contribution without queuing another event. A read-only action or replay therefore has an empty flush.

## Stream lock and event audience

The existing `recordEvent` resolves one audience and then inserts an event whose database trigger acquires the serialization lock until commit. A naive loop of that function for several intents is insufficient: the second event's policy/audience reads would happen after the first event has taken that lock.

Add a batch operation in the existing allowlisted events adapter that prepares **all** event IDs and current authorized audiences before the **first** event insert. After that first insert, only final event storage and its derived audience/outbox rows occur. Retain `recordEvent` as a single-item wrapper if useful. Core task-discussion modules continue to depend on their event port; add no new DB/Drizzle import or architecture exception there.

All intents are resolved against the transaction's final domain state, including any authorized pre-flush audience change. Recorded audience and delivery-time authorization remain distinct; delivery still rechecks current access. The event-trigger-derived outbox is part of event storage, while #153's addressed outgoing intents must precede the final event phase.

## Session lifecycle and caller obligations

- Close preparation when the first flush starts; reject further contribution/read calls through that session so no new domain locks follow its stream lock.
- Repeated flush returns the same promise, or another explicitly idempotent result, and cannot insert events twice. An unsuccessful flush remains unsuccessful; no retry after partial event preparation can silently duplicate rows.
- Freeze or defensively copy intent principal/data when collecting them. A caller cannot mutate authorship, scope, kind or canonical IDs after authorization.
- Propagate action/flush exceptions out of the owning transaction. Never flush asynchronously, after commit, or from a finally block following a failed domain action.
- The outer caller must await all prepared actions before flushing and must not perform later coordination/domain writes after flush. It retains responsibility for authenticated current authority, durable receipts, generation/session/DB-time lease fencing and sorted multi-task locking. The session does not certify those #153 boundaries by itself.

## Required implementation evidence

1. Two genuine prepared contributions produce canonical root/reply IDs and no event/stream lock before flush. An authorized grant change before final flush affects both prepared audiences, demonstrating all-audience preparation rather than a naive insert loop.
2. Flush-once, second-flush, replay-with-zero-events and closed-session guards retain one exact event per new contribution. Overlapping preparation/flush cannot create a late unflushed contribution or duplicate event.
3. Exceptions before flush and after actual event insertion roll back message, root binding, sequence, search rows, events and derived outbox. Ordinary HTTP success/error retains the same transaction guarantee.
4. Re-run affected genuine actor, simultaneous first-writer, current-grant/replay, normal conversation, helper/search/export/notification/return and actual browser paths at the new clean head. Prior 98 passing integration checks at `2ae9bfa` establish that earlier actor implementation only.
5. #153 independently verifies its actual coordination resolution, durable receipt, outgoing intent and lease/session fencing in the combined outer transaction. The current simulated outer-throw test is useful atomicity evidence, not that integration acceptance.

The boundary is accepted for implementation under these constraints. Original #154 AC-1–AC-5, file/blocker/result/handoff/undo/shared-draft/#136/MCP/#152 and reversible migration outcomes remain required and open. PR #164 remains draft until the complete agreed task and eligible independent review are satisfied.
