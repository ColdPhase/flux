# Proposed bounded native work reads — #155 / #151 / #136

2026-10-01. Pending independent design review; no new public read contract or
runtime optimization is accepted by this document yet. Owner Zamojski5, existing
PR170/worktree. Preserve the full task criteria and native identity, permission,
history, source/version, mutation, draft and reading contracts.

## Problem established by the running baseline

At immutable d53622cfef7616af336d74ce1fd1f93df74b0f1f the public API verifies
1000 native work objects for both actual contributors. The first desktop Tasks
navigation fetches all 1000 plus 3 decisions and 10 results through 12 collection
calls: 836,816 decoded body bytes, 1000 rendered work rows, 1013 rows overall and
9346 current DOM elements. The completed desktop distributions each have 30
warm-up and 200 measured real actions: p95 navigation 329.1ms, input 36.6ms, view
65.1ms and scroll 38.5ms. These meet the proposed latency budgets; fetch/render
bounds fail. Opening native Details preserves the draft, but following its native
message source and returning loses it (length 0). The phone CPU-emulation run is
still in progress here; these observations are not its result or whole acceptance.

The parent project loader and state line assume complete ProjectWork arrays.
MessageObjects, ProjectOverview, WorkDetails and Docs LinkPicker also scan those
arrays. Passing the first page under that type would hide older objects, source
chips, choices and exact counts. Removing rows in the browser alone would keep
unbounded collection loading. Both are insufficient.

## Proposed read model

Keep existing native object GETs, collection routes and commands compatible.
Add explicit read-only contracts using the existing WorkAccess / WorkRepository
ports, server adapters, DB queries and batched native presenter. No client policy
SQL, new audience, cached permission proof or materialized second source of truth.

1. ProjectWorkSummary is a distinct type, never ProjectWork with partial arrays.
   It returns exact global and caller-owned counts for every current group,
   total work and the unparked unfinished Tasks tab count. Caller-owned work uses
   the authenticated principal kind/id; proposals remain project-wide, accepted
   and superseded rules are absent under Only mine, and results use createdBy.
   State-line references identify the newest accepted rule and proposal, newest
   result, representative in-progress/blocked objects and exact counts. These are
   bounded lightweight native id/title/status references, not full WorkItems.
   Show at most three distinct current owner labels with an exact remainder count;
   never present a partial owner list as everyone. Failed required counts or name
   batches produce an unavailable/error state, not zero or a complete-looking list.

2. ProjectWorkPage returns a typed heterogeneous page of existing native WorkItem,
   Decision and WorkResult DTOs, exact selected total and explicit continuation.
   Tasks' All view preserves the present group order: proposals, in progress,
   blocked, open, parked, finished, accepted/superseded decisions, results. Each
   group's records keep createdAt DESC, id DESC ordering. A selected view applies
   its current native predicate before total/page/hydration; parked never means
   done. Default page size 50, maximum 100. All renders one page, not an appended
   growing list. Group labels keep exact total counts; a separate visible range
   describes the current page. Next/Previous controls expose all records, including
   older decisions/results, on keyboard and narrow/wide layouts. Changing views or
   Only mine restores that view's page and native reading anchor. A changed/empty
   page does not imply the entire group is empty; offer an explicit refresh.

3. A bounded batched association query serves actual displayed message IDs (at
   most 100) or one native conversation/message scope. Return native typed objects,
   exact per-message/type association counts and explicit continuation. One query
   batches a window; never one HTTP request per message. MessageObjects needs
   role=source; ProjectOverview includes any link to a scoped message and must
   retain that distinct meaning. Additional links remain accessible through a
   labelled continuation in their native context. Keep material version, native
   thought/project-sketch, doc and message back routes; no private-sketch leakage.

4. Details keeps its native object GET and resolves only its actual related refs
   through batched/paged reads. Earlier/later/parked-by decision refs retain real
   IDs; parked work and choice/history lists have explicit continuation. Propose
   decision choices include every accepted rule. Pivot candidates are unfinished
   and unparked. Attach-result choices include unfinished parked work and the
   explicitly selected deep object, while existing finishability rules still
   apply. Docs LinkPicker's work/decision/result candidates use scoped title
   search and continuation, with native type tags and stable selected references.
   None of these page sizes changes the command's 50-link limit or silently selects
   a page in place of all eligible choices.

Closed query schemas specify group/type, caller-only filtering, native
message/conversation scope, parked-by decision, bounded title search, limit and
continuation; invalid combinations are rejected. Every request uses the current
central project.read policy before counting/selecting/hydrating. Validate scope
against the actual native source/decision records. All list/aggregate operations
are read-only; no acknowledgment, model, media, event or background job effects.

Use complete keyset continuation rather than the existing offset<=10000 limit.
The bounded closed cursor contains version, selector binding and the last native
group/creation-time/id key, with the DB timestamp precision preserved. It confers
no authority and is revalidated under the current project/principal on every
request. No cookie/session/name/title is embedded. Page rows and selected/global
counts describe one coherent DB observation; propose a concrete single-query or
equivalent transaction implementation during review. Between pages the project
remains live: changes can move objects between groups. Explicit refresh rechecks
counts and the selected native anchor; no claim of an immutable multi-page snapshot.

Initial Tasks uses summary plus one selected page, within at most four collection
calls and 100 unique full WorkItems total. Lightweight summary references stay
explicitly distinct. Retain at most 200 rendered work rows in all measured views.
Current unbounded decision/result arrays cannot be a hidden replacement cost.

## Consumer migration and continuity

Migrate ProjectShell, AppLayout tab count, stateParts and both state-line variants
to the explicit summary together. Tasks owns the typed page. MessageObjects and
ProjectOverview own their scoped associations. Details and pickers own their
bounded choice/history/search reads. Do not keep an implicit optional partial
ProjectWork fallback: its absence must never synthesize an empty project.

Each request/cache/page/choice/draft belongs to the account, project, selector and
request generation. Late responses from an older generation cannot overwrite
the current native scope. Keep selected native IDs and current versions across
pages, and retain existing If-Match/Idempotency-Key behavior. Refresh/revocation
must remove unavailable labels/choices without discarding unrelated private text.

The New work draft belongs to the account and project, survives source/back,
view/Only mine/Details/resizing/reload, and clears only after confirmed native
creation. Use a separately mounted composer so editing does not reconcile the
whole list. Storage failure keeps the newest text in memory, including an empty
clear; older stored text must not win on a later SPA remount. Account/project
switches cannot relabel another draft. Preserve focus/selection during passive
resize/refresh and the current per-view native reading anchor.

## Required evidence before claiming the correction

Run actual native policy/collection regression coverage for all group/mine/source,
park/history/search/deep-choice/cursor cases, including objects beyond 10000,
concurrent change/refresh and revoked/foreign contexts. Verify actual browser
pagination, keyboard, deep object/source/back, draft isolation/storage failure,
read-only/no-unintended-command behavior and exact fixture counts. Re-run the
agreed desktop/CPU-emulation distributions on the same 1000-object shape with
the accepted paged usable-state predicate, preserving all 30/200/60s requirements.
Record bytes/calls/unique work/DOM/target memory and before/after native state.
Obtain separate current-head source/functional and neutral rendered assessment.
Physical PWA/Push, real agent Task integration, motion and full release acceptance
remain required and are not certified by this optimization.
