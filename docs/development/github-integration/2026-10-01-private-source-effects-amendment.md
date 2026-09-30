# Private source effects — rule, transaction and consumer amendment

2026-10-01. **Proposed clarification; runtime remains OFF.** Extends the
[CO-3 proposal](2026-10-01-private-source-publication-proposal.md) following its
[independent assessment](evidence/2026-10-01-private-source-publication-independent-design.md).
It preserves #74 AC-1–AC-5 and CW-4. The first-slice runtime remains
`b30da68816b15b0c2f1a9ff99993d34e6eca4b05`; no rule, source-derived native stage,
source notification or #153 request is enabled by this document.

## 1. One aggregate rule and one canonical task view

There is at most one active GitHub standing rule per native task, enforced by a
unique task constraint. Its monotonically increasing `ruleRevision` identifies
the policy, selected required checks and their exact producer App IDs, all
required-output link IDs/roles/provider identities, and author authorization
generation. The rule author must have current native write and their own
verified access to every required repository. A rule cannot be active with no
required outputs, or on parked, done or not-pursued manual work. Related-only
links are never included in the aggregate or its completion conditions.

Create, replace and resume are separate explicit commands. Replace atomically
suspends the previous revision and creates the next revision under the native
work lock; there is no interval with competing active rules. Resume increments
the rule revision and snapshots current native version, complete required link
set and fresh provider state. Neither a webhook nor reconnect/restore/import
can resume a suspended rule. A changed required link/check policy, generation
or native edit suspends the rule; accepting additional outputs requires an
explicit replacement. No last-delivery or partial-reader precedence exists.

The canonical resolver returns the existing task ID and existing `WorkStatus`
values. A reader may see an aggregate effect only after proving current access
to **every** provenance source. Permission to a subset exposes the manual view;
it never composes a different partial effect. A stale, uncertain, missing,
truncated or mismatched provider object/check/head also withholds the effect.
Manual fields remain available throughout.

Default stage evaluation, in this precedence order:

| Complete current aggregate | Effective native stage | Separate execution state |
| --- | --- | --- |
| Any required PR closed unmerged | `blocked` | Closed without its output; never complete |
| Any selected required check at its exact current head and producer has a known failing conclusion | `blocked` | Checks failed |
| Otherwise, at least one required PR remains open/draft, or a required check/review is pending | `in_progress` | Draft/open/checking/review pending, preserving each output's facts |
| All required PRs merged and selected required checks pass at their relevant current heads | `in_progress` | Completion candidate; independently unmet task/result/device/eligible-provider gates remain visible |

Unknown facts produce no effect rather than guessing a blocked or green stage.
The candidate is never an automatic `done` transition. Existing explicit native
result/acceptance commands and real eligible GitHub gates retain their authority;
this rule cannot invent passed acceptance criteria or eligible review. This
bounded mapping meets the same-task movement criterion without changing the
status vocabulary. Other mappings require a versioned, independently reviewed
policy change. Provider authorship and execution/check/review states remain
separate from the native stage and rule author's identity.

## 2. Version, timestamps and manual correction

`WorkItem.version` and `updatedAt` remain the manual native version/time. An
effect has separate `effectRevision` and `effectChangedAt`, incremented only on
a semantic aggregate change. Authorized canonical views disclose the rule,
provenance, manual baseline and effective stage, plus a source-view precondition
containing rule/effect revisions and native version. An authorized view's
effective change time is `max(native.updatedAt, effectChangedAt)`. Withheld
views contain only native time/version, no effect fields or presence marker.
Responses remain no-store. If conditional read ETags are later added, they must
be opaque and reader-bound: native tuple for the manual view; native plus
visible rule/effect tuple for the authorized view. Current mutation ETags stay
the native optimistic version and cannot reveal a hidden effect revision.

All native mutations, including a deliberate same-value status correction,
are manual overrides. Existing `expectedVersion` is the required native CAS.
Successful commands suspend the active rule and withdraw its effect in the
same transaction after locking work; they need no GitHub access. A source-aware
command may additionally supply its source-view precondition. When supplied,
both rule/effect and native versions must match under locks; mismatch returns
409 without mutation only after current source authorization; an unverified
caller receives the ordinary unavailable-source response without rule presence,
hidden revision or conflict details. The UI labels a retry without that optional precondition
as explicit manual override. A Flux-only command needs only native CAS and
cannot be required to learn source revisions. There is no consumer-specific
interpretation of these semantics.

Source evaluation compares the locked active rule revision, native baseline,
required link set, provenance and previous effect revision before writing.
Concurrent manual work wins by changing native version and suspending the rule;
an older provider observation cannot restore it. Rule/effect suspension is also
required for native mutation entry points outside `updateWork`, including
decision pivot/parking, results that finish work, approved helper proposals and
agent commands. Neither manual history nor event payload copies a previous
private stage, blocker or rule. Rule management/history itself requires the
same current source gate, including listing/counting suspended rules.

## 3. One composed lock and final-event order

Discovery is unlocked and bounded: collect exact candidate task/source/recipient
IDs from explicit links/subscriptions, never scan arbitrary repositories. All
external token/refresh and current repository checks finish before acquiring
connection/project/receipt/native/binding locks. Unknown recipient proof omits
that recipient; unknown source proof prevents the effect. Recipient identity is
the actual human or current connection owner, never the rule/binding author.

The following is the **proposed complete shared order**, not a claim that the
current #152/#153 implementations already follow it. At #152 `867b925`, prepare
locks current access/binding/runtime/action grant, connection-command ledger and
sorted current material versions before native graphs/tasks; #153 reserves
connection slots before project graphs. Inserting credential pins ahead of that
ledger therefore needs an explicit shared interface/ordering review and hook,
including the material-source lock category. No source adapter is usable until
the complete order is agreed and tested together. Within one caller-owned
transaction the proposed order is:

1. Sorted connection slots and their verified runtime/action-grant authority,
   then complete sorted project policy graphs, when applicable.
2. Sorted `(provider host, Flux user ID)` credential share pins for every source
   author and actual recipient needed by this operation. Recheck current
   App/client/GitHub user/generation/expiry against preflight before continuing.
   No provider method can open a second credential transaction after this point.
3. The single connection-command ledger/claim boundary and complete sorted
   current native material-version rows, when applicable; these precede tasks.
4. Complete sorted native task IDs.
5. Complete sorted GitHub binding IDs, then sorted delivery/processing IDs,
   rule IDs and effect IDs, each category in that order.
6. Coordination unit IDs, then actor/conversation resources under their existing
   order. Required native result/reference rows join the existing native order.
7. Revalidate locked native/rule/link/provenance and every current authority;
   write all domain, debit, receipt, outgoing/causal intent and response hydration
   state. Prepare **all** event audiences using the already pinned capabilities.
8. Insert the first event only after every preceding operation succeeds. Flush
   one final batch, with no subsequent domain/receipt/audience preparation.

Every category sorts IDs before locking; discovering an additional lock target
after a later category starts aborts/restarts preparation rather than acquiring
it backwards. Delivery/replay establishes new own-recipient proof; an earlier
prepared capability cannot be reused beyond its operation. Timeouts preserve
the reviewed PostgreSQL cancellation-before-driver deadline and drain rollback.

Manual native commands omit provider/credential/binding processing and use
project authority → sorted work → rule/effect suspension → later native
resources → complete preparation → final events. GitHub revocation uses its
credential → binding → rule/effect authority withdrawal order, never acquires
native work afterwards, and never modifies the manual baseline. It may skip
unused categories. A recipient proof acquired after work/binding locks, or an
inline-emitting native command followed by a receipt write, violates this order.

Today's #74 `githubUseCases.process` takes binding/processing locks before its
linked tasks. This is valid only while it records source observations and the
undelivered internal bridge. Before adding effects it must discover targets and
enter the composed sorted work-first order; wrapping today's processor is
insufficient. The same rule applies to link changes/disconnect and recipient
preparation. Today's #152 ledger has no #74 provenance pin/replay publication
hook; composition stays unavailable until that hook and current-source receipt
read checks are implemented and independently verified.

Verified #154 seam at `d1d03f70f1ddb7c78d05216ac570c9359cb5290c`:
`app/apps/server/src/work/transaction-events.ts` exports
`transactionEventSession(tx)` with `run`, `record`, immutable `eventIntents` and
one `flushEvents`; `work/adapters.ts` exports `nativeWorkInEventSession` and
`nativeWorkInTransaction`. It grants no authority. Its existing ordinary
project audience must **not** carry a source effect. A coordinated explicit
source-authority event intent/collector extension is needed: private event
provenance and recipients are prepared through the operation-local source
authority port before the one final insert batch; ordinary manual intents use
their existing policy. Until that extension is accepted and tested, private
events remain internal/pending and no generic work refresh is broadcast.

## 4. Semantic causal identity, delivery and replay

The effect's causal key is SHA-256 of versioned canonical JSON containing
workspace/project/task, native baseline version, rule ID/revision, sorted
required link/binding/host/repository/PR stable IDs and roles, current heads,
normalized PR state/merge commit, original provider source-change identities
and timestamps, and sorted relevant check IDs/producer IDs/head/conclusions and
current-head review IDs/reviewer IDs/verdicts. Stable IDs remain lossless strings.
Canonical JSON sorts object keys and sorted sets by their complete stable key.
The key excludes webhook GUID, observation-row ID, GET verification time,
delivery time, access proof time and refresh token details.

An unchanged semantic state under a new GUID or fresh GET creates no new effect
revision/event/request/notification. Store the processed observation receipt
for transport recovery separately. A new rule/native baseline/head or genuine
canonical fact change produces a new causal key; old/out-of-order deliveries
first reconcile current provider truth. A task aggregate is compared atomically
under its rule/effect locks, with a unique `(taskId, ruleRevision, causalKey)`
effect identity. Absence/retry of one required output never publishes a partial
aggregate. Local outgoing intents and provider external IDs link back to that
causal identity; correlation is not a grant or a substitute for current truth.

Each actual #153 target additionally deduplicates `(causalKey, targetConnection,
requestClass, subscriptionRevision)` through its single durable receipt, current
runtime/claim/lease/subscription fences. Replays may return only values whose
provenance remains authorized now; a valid old receipt is insufficient. Source
host/App/client, immutable repository/object identities, authorization generation,
rule revision and supplied source-view precondition join the normalized command
fingerprint and receipt provenance envelope. Changing them under a reused
command ID is an idempotency conflict, never replay of another source context.
Current authority is still rechecked even when that immutable fingerprint matches.
Source
publication/review writes require separate eligible provider authority and
external once-only write reconciliation before retry. The internal
`github_bridge_outbox` row currently remains `pending_audience_adapter`.

## 5. Concrete conversion inventory and enablement gate

Inventory below is of actual first-slice source at b30 unless another pin is
explicit. It names conversions still required; none is claimed shipped. One
operation-scoped canonical source-aware work resolver must be supplied through
domain ports to every reader. Direct SQL work projections cannot bypass it.

| Consumer/entry point | Required conversion before effects |
| --- | --- |
| `core/src/work/service.ts`: `presenter`, `listWork`, `getWork`, `listAssigned`, result/decision/link reads; `server/src/work/{routes,adapters}.ts`; `db/src/repositories/work.ts`: `listWork`, `listAssigned`, `findWork`, `titles`, `links` | Canonical same-ID effective view; current provenance before filter/count/page/status/title/reference output. All native writer paths suspend rules atomically. Assigned-work unfinished filtering must use the authorized effective status before totals/windowing. |
| `web/src/work/{ProjectTasks,WorkDetails}.tsx`, `web/src/project/ProjectOverview.tsx`, `web/src/work/inline.tsx`, `web/src/app/{AppLayout,shellContext,views}.tsx` | Consume one authorized view, including board/group/count/detail/assigned/state summary. Clear source overlays before recheck/on loss; no source state in shared ordinary shell/session/service-worker cache. Manual source-aware packet/precondition semantics are identical to API. |
| `core/src/returns/service.ts`: `summary`/`build`; `db/src/repositories/returns.ts`: `audienceAfter`, `work`, `resultWork`; `server/src/returns/{routes,adapters}.ts`; `web/src/returns/{SinceYouLeft,WhatMatters}.tsx` | Recheck source event/history and current effective work before grouping, recaps, next-step/digest text, result-to-work references and counts. A prior audience row/return point does not authorize current source facts. Ordinary digests remain manual-only until converted. |
| `core/src/search/{service,sources}.ts`; `db/src/repositories/search.ts`: `page`, `counts`, `explain`; `server/src/search/{routes,adapters,cursor}.ts`; `web/src/search/{SearchPage,JumpTo,ResultRow,recent}.tsx` | Current provenance before candidate matching/ranking/snippet/facet/limit/count/cursor; separate source index and reader-bound cursor. Recent queries do not cache source results or grants. Ordinary native index never receives private effect text. |
| `core/src/personal-runs/processor.ts`: `readSources`, `fit`, dispatch recheck and `commit`; `personal-runs/service.ts`: `answerView`/`runView`; `personal-runs/proposals.ts`: `proposalView`/`decide`; `db/src/repositories/personal-runs.ts`: `openWork`, `findRun`, proposal reads; `server/src/personal-runs/{adapters,composition,routes}.ts` | Ordinary helper context remains manual-only. Source context requires real owner plus current agent/connection grants, own repository proofs and explicit context-provider delivery authority before each token-count/dispatch. Persisted answers/proposals/continued earlier answers with source provenance need current read gates; never publish private-derived text into ordinary conversation/proposal/result fields. Accepted finish-result commands are manual overrides and suspend rules. Source text conveys no new command authority. |
| `core/src/work/service.ts`: `linkReader`, `getResult`, `createResult`, decision pivot; `core/src/personal-runs/proposals.ts`; `db/src/repositories/work.ts`: `titles`, `links`, `targetExists`; `server/src/work/task-discussions.ts` at #154 d1d03f7 | Gate source/result/assessment references, linked titles, counts and history. Source-generated contribution lives separately with provenance; no copied private text in ordinary native discussion. Result/parking/manual edits preserve ordinary author/history and suspend effects without revealing the prior stage. |
| `core/src/events.ts`: `eventAudience`/`recordEvent`; `server/src/stream/{delivery,work-route}.ts`: cursor resolution/`drain`; #154 `work/transaction-events.ts` | Explicit private source audience preparation and current recipient delivery/replay gate. Ordinary project authorization is insufficient. No withheld event ID, cursor/version tick or generic refresh to an ineligible recipient. All audience preparation precedes first final insertion. |
| `core/src/notifications/generate.ts`: `candidatesFor`/`generateNotifications`; `core/src/push/notifications.ts`: inbox creation/read; `core/src/push/delivery.ts`; `core/src/notifications/email.ts`: `deliverNotificationEmail`; `db/src/repositories/notifications.ts`; `server/src/notifications/{routes,adapters}.ts` | Explicit source subscription plus current recipient proof at creation/send/inbox replay. No private notification count/text/source ID in ordinary rows or unguarded push/email payload. Until a separate delivery authority and gated storage exist, private-source generation is disabled, including content derived from an effective stage. |
| `core/src/export/{service,bundle}.ts`: `exportProject`/`exportBundle`; `db/src/repositories/project-export.ts`: `work`/`links`; `server/src/export/{routes,cli,adapters}.ts`; operator backup/restore archives | Ordinary project export is manual-only and excludes effects/rules/credentials/requests. Full operator encrypted-at-rest/server backup is separate restricted server administration, not a project publication grant; restore still revokes integration before writers. Separately requested source-history export/dormant import remains unimplemented and requires current exporter proof plus imported provenance verification, never checksum-based provider attestation. Controlled archive downloads require current appropriate authority; downloaded permitted files cannot be recalled. |
| #152 committed `867b925`: `server/src/agent-connection/{context,domain-reads,mcp-tools,mcp-route,execution,tool-registry}.ts`, `core/src/agent-connection/{reads,execution}.ts` | Real bearer/current owner/connection/runtime/action-grant gates remain. `flux_list_work`/`flux_get_work`, search, result/decision/material/wiki/conversation/map crosslinks and command values need the canonical resolver and explicit source context authority. Source pin before ledger/task locks; receipt replay checks current provenance before returning stored values. No stored private command outcome without provenance and current replay policy. |
| #152 bootstrap/orientation accepted design, still under implementation: `server/src/agent-connection/bootstrap.ts` → `core/src/agent-connection/orientation.ts` → `db/src/repositories/agent-orientation.ts` | Index/count/title/snippet/checkpoint/orientation packets need current source gate and reader/connection-bound caches. This is an integration obligation, not a shipped adapter. Tools/provider readiness stay unavailable until actual conversion/tests. |
| #153 committed `1a99d2ac97ef5d15fb6a18a92683d5ba709911a4`: `db/src/repositories/cowork.ts`, `coworkUnitRows.lock`/`save`/`checkpoint`/`insertCheckpoint`; `db/src/repositories/cowork-requests.ts`, `coworkRequestRows.enqueue`/`acknowledge`/`defer`/`pendingPage`/`readyCandidates` | Storage only: caller supplies current target owner/grants/source access, complete sorted locks, ONE ledger and final batch. GitHub stable binding/link/head refs remain typed metadata; ACK is transport only. Snapshot/candidates require current recipient provenance before any record/count and an opaque connection/project-bound continuation. Preserve immutable native-task/run lineage, budgets and causal intent fingerprint; a new GUID cannot create another lineage/request or consume a fresh budget. |
| #153 event/comment bridge, source-authorized request admission/claim/resolution, subscription/recipient delivery, resume/reference packets and receipt replay; core/server composition absent at `1a99d2a` | Current actual target owner/grants/repository/context-delivery subscription and stable causal key on admission and each replay/effect. Acquire source/recipient capabilities before native locks, preserve the ONE ledger and final batch. Missing actual provider audience and consumer adapter plus agreed shared order keeps the global enablement gate OFF; storage fixtures do not certify it. |

Paths in the table are relative to `app/packages/` (`core`, `db`) or `app/apps/`
(`server`, `web`). Native reference reads and helper/Return/assigned consumers
are explicit gate requirements, not documentation-only exemptions. New consumers
must join this inventory before effects can be enabled. A complete migration
audit must identify every remaining raw work/status/blocker/history projection
and persisted downstream derivative at the eventual integrated code head.

Before enabling: independently agree on this amendment and source audience/153
interfaces, land the complete consumer conversion, then verify all privacy,
same-task stage, all-output, semantic duplicate, manual-CAS, withdrawal/recovery,
receipt replay and lock/cancellation regressions at one pinned integrated head.
Real App/public TLS/local-client/device acceptance stays separately required.
