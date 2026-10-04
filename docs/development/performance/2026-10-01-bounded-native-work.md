# Proposed bounded native work reads — #155 / #151 / #136

2026-10-01. Bounded architectural agreement at
76b8124c617c6493a5142f44ec455ea81ff98b6b. The [exact public paths/query/DTO contract](2026-10-01-native-work-read-contract.md)
received independent bounded design agreement at
93fb60842277203a6721eccfbcd734a9e82dbf95; no runtime read correction
or whole-task acceptance is claimed. Owner Zamojski5, existing
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
message source and returning loses it (length 0). The completed phone CPU-emulation p95 values are navigation 587.8ms, input
47.7ms, view 176.3ms and scroll 38.4ms; it has the same fetch/render/draft failures.
Both runs retain all 30/200/60s requirements and native work remains unchanged.
See the [complete actual evidence](../../agents/evidence/155-native-work-baseline/README.md);
none of these observations are whole-task acceptance.

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
   Owner distinctness is native principal kind/id, never first-name text (two Ada
   accounts remain two people). Show at most three distinct current owner labels with an exact remainder count;
   never present a partial owner list as everyone. Failed required counts or name
   batches produce an unavailable/error state, not zero or a complete-looking list.

2. ProjectWorkPage returns a typed heterogeneous page of DISTINCT bounded native
   row projections, exact selected total, the complete summary facet from the SAME
   read observation and explicit next/previous continuation. A row retains native
   kind/id/project/audience/title/version, work status/owner/blocker/park metadata,
   decision status/actor metadata or result finding/actor metadata. It is not a full
   WorkItem/Decision/WorkResult: in particular it has no unlimited links array.
   SQL aggregates return exact source/result/decision relation counts; at most one
   actual rule/parked-by reference and a message-source presence flag serve the
   existing row text. Selected relationships have their own bounded native pages.
   Native owner identity and display label remain separate fields.
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
   labelled continuation in their native context. Limit the ENTIRE batch to 50
   typed objects (maximum 100) and 100 association edges, not 100 objects per input.
   Deduplicate objects by native kind/id; count distinct object identities for
   each message/type separately from association edges. Return exact per-input
   message/type totals and global distinct-object/edge totals. A closed selector
   bound to the normalized set of source IDs, relation meaning and authenticated
   scope owns each continuation. If edge and object limits reach different
   boundaries, return their explicit independent continuations; neither partial
   preview means complete. DTO rows use the bounded projection above and edges
   contain only native endpoints/role/version and bounded native title metadata.
   Full material/body/outcome/evidence payloads are not multiplied into batch
   previews; source content still opens at its native route.
   Keep material version, native
   thought/project-sketch, doc and message back routes; no private-sketch leakage.

4. Existing full native object GETs remain compatible, but optimized Details uses
   a DISTINCT detail projection containing the native object's own complete
   fields/versions and exact relationship counts, with no implicit full links
   array. Each relationship page has at most 100 edges globally. Resolve only
   that page's actual related refs through bounded batched reads. A 50-link command
   limit does not bound all incoming links accumulated over time; do not call
   legacy linkReader(repo.links(ids)) to hydrate unlimited incoming edges. Earlier/later/parked-by decision refs retain real
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
continuation; invalid combinations are rejected. Association output pages and
relationship previews are globally bounded independently of the number of input
objects. Current native field length contracts apply; a projection carries no
unrequested full body or repeated full relationship graph. Every request uses the current
central project.read policy before counting/selecting/hydrating. Validate scope
against the actual native source/decision records. Source visibility predicates
apply BEFORE relation counts and page selection as well as final projection
checks; no hidden source contributes a complete-looking visible count. All list/aggregate operations
are read-only; no acknowledgment, model, media, event or background job effects.

Use complete BIDIRECTIONAL keyset continuation rather than offset<=10000.
The closed cursor (maximum 512 encoded bytes) contains version, direction,
project/principal/selector binding and a native group/creation-time/id boundary,
using a fixed-size digest for a normalized multi-source selector (never embedding
up to 100 source IDs into the cursor),
with raw DB timestamp precision preserved. Next uses the last displayed key and
normal order. Previous uses the first displayed key, reverses the SQL order and
comparison, then reverses the bounded result into normal display order. No client
history stack is required: a direct URL/reload includes its cursor, selected view
and Only mine, and obtains valid next/previous cursors from that actual page.
Empty/changed pages retain explicit navigation/refresh; never invent an earlier
page from a cached length. A cursor confers no authority and is revalidated under
the current project/principal on each request; it contains no cookie/session/name/
title. Association/relationship cursors additionally bind their native scoped
selector and relation meaning. Do not use lossy JavaScript Date milliseconds for
DB cursor boundaries or deduplicate people by display text.

A new READ ONLY REPEATABLE READ per-request unit of work, following the existing
export adapter pattern, evaluates native policy first, then computes all counts,
page rows, summary refs, names, bounded links and relation counts within that SAME
snapshot/transaction. No locks through browser/network waits, durable snapshot
cache, event or background effect. Every next/previous query opens a new native
read observation. Before exposing the assembled response, resolve the exact
native session again outside the snapshot and check current central project read
access: a revoked/expired/replaced session or removed audience invalidates the
response. Recheck object-specific source visibility (including private sketches)
under the current source policy; a changed scope invalidates the response for
refresh instead of returning its old labels. Effective writable/read-only UI
metadata comes from that final current-policy check. The snapshot describes data
as observed, not an authority capability or historical attestation.

A combined page response carries its own exact summary and replaces the shared
project summary facet atomically in the active account/project/view generation.
A standalone summary response is an independent observation; it cannot overwrite
that page's counts/refs or be claimed as the same snapshot. Refresh of an active
page fetches the combined read again. Non-list views may use standalone summary
plus separately scoped association/detail reads, explicitly separate observations.
Between pages objects can move groups; refresh rechecks the selected native anchor.
No claim of an immutable multi-page snapshot is made.

Initial Tasks uses one combined summary/selected-page response, within at most four collection
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

Choice pickers (2026-10-04, #170 review): each search keeps its own page position while
the picker stays mounted, so A → B (paged) → A returns to A's page and B keeps its own.
At most 20 positions per picker are kept (the least recently moved is dropped and opens
at its first page). Positions belong to one account and project; Refresh returns the
current search to its first page. The cursor stays an opaque continuation hint.

The New work draft belongs to the account and project, survives source/back,
view/Only mine/Details/resizing/reload, and clears only after confirmed native
creation. Use a separately mounted composer so editing does not reconcile the
whole list. Storage failure keeps the newest text in memory, including an empty
clear; older stored text must not win on a later SPA remount. Account/project
switches cannot relabel another draft. Preserve focus/selection during passive
resize/refresh and the current per-view native reading anchor.

Thought task counts (2026-10-04, #170 integration of #196): a project Map shows how many
tasks link to each thought and lists them. It never reads the project work collection.
`GET /api/v1/projects/:projectId/work-thought-tasks?thoughtIds=` takes 1..100 thought UUIDs
(raw bound before deduplication, closed query, no cursor) and returns, in one read-only
REPEATABLE READ observation with the final session/project.read fence:
`counts` — the exact number of distinct native tasks with a visible link from the task to each
requested thought (any role), listed only for thoughts with at least one; a missing, foreign,
private-sketch or DM-sketch thought is indistinguishable from one with no tasks; `links` — one
global window of at most 100 (thought, task) pairs ordered by thought id, then unparked before
parked, then in progress, blocked, open, done, not pursued, then created time and id;
`linkTotal` — all such pairs; `items` — the distinct tasks in that window as native work rows
plus `createdBy` (the chooser's "added by"; the same project audience as the task itself).
The final fence also requires the set of selected thoughts that are project thoughts to be
unchanged (409 `work_read_changed` otherwise) and the existing link-visibility digest. The
client chunks a sketch's thoughts by 100; a thought whose pairs are not all in its chunk's
window is read on its own when its chooser opens (at most 100 tasks, the rest named as a
count). Counts refresh on `project.work_*`, `project.link_*`, `project.result_*` stream events,
on window focus and after Create work.

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
