# Native bounded work read contract — #155 / #151 / #136

2026-10-01. Exact public contract independently agreed at
93fb60842277203a6721eccfbcd734a9e82dbf95 by the non-author contract evaluator.
The review covered this document, work-read.ts/export and the existing native
semantics; it did not execute tests or accept runtime correctness/whole #155.
Implements
the [accepted bounded architecture](2026-10-01-bounded-native-work.md), without
changing native commands or replacing legacy GETs. Types and paths live in
`app/packages/contracts/src/work-read.ts`. No new runtime endpoint exists yet.

## Requests and bounds

All paths are beneath `/api/v1/projects/:projectId`. UUID path/query fields use
the existing native UUID validation. Queries are closed: reject unknown keys,
duplicate keys, malformed values and incompatible selector fields with 400.
Booleans use `true`/`false`; integers must be integral. Search `q` is trimmed,
at most 200 characters, literal case-insensitive title substring matching (SQL
wildcards escaped), empty means no search. Default limit 50, maximum 100,
minimum 1. Each cursor is an opaque string of at most 512 encoded ASCII bytes.
Every endpoint is read-only and uses current authenticated project.read access.
Foreign/missing native selectors use the existing non-disclosing 404 behavior.

- `GET /work-summary`: no query fields. Exact native counts, bounded state refs
  and final current access metadata; no object collection or links.
- `GET /work-view`: `limit`, `cursor`, plus exactly one purpose below. Returns a
  `ProjectWorkView`, combining the selected row page with the complete summary.
  `purpose` defaults to `tasks`. Tasks permits only `group` (default `all`, or a
  `WORK_GROUPS` member) and `mine` (default false).
- `purpose=choices`: requires `choice`, no task `group` or `mine`. All choices
  permit `q`. `accepted_decisions` selects every accepted decision;
  `pivot_work` selects unfinished, unparked work; `result_work` selects unfinished
  work INCLUDING parked work and permits one optional `selected` work UUID;
  `parked_work` requires an accepted/superseded native `decisionId` and selects
  unfinished work parked by that decision; `doc_refs` requires `kind` equal to
  work, decision or result and selects all objects of that kind. `selected` is
  valid only for result_work, `decisionId` only for parked_work, and `kind` only
  for doc_refs. An explicit selected work object is returned separately even if
  finished/outside search; it never changes eligible totals or replaces a page
  row. At most `limit` rows plus ONE selected row (101 maximum) are hydrated.
  Tasks never has a selected row. Current command finishability rules are retained.
- `GET /work-associations`: `limit`, `cursor`, `edgeCursor`, `relation` (default
  `source`, or `any`), and EXACTLY one of `messageIds` or `conversationId`.
  `messageIds` is 1..100 unique UUIDs, comma-separated; normalize sort/deduplicate
  only after enforcing the raw input bound. All must belong to this project and
  be currently readable. `conversationId` must be a native project conversation;
  it scopes ALL its messages, independently of the count-window below. This
  selector alone additionally permits `sourceCursor`. No title/body text in input.
- `GET /work-relations`: `limit`, `cursor`, `objects` and optional `role` (one
  existing LinkRole). `objects` is 1..100 comma-separated native `work:uuid`,
  `decision:uuid`, `result:uuid` references, normalized by kind/id after checking
  the raw bound. Validate each object's actual current project. Select DISTINCT
  visible incoming/outgoing edges for the whole set, not a page per object.
- `GET /work-objects/:kind/:id`: no query; kind is work/decision/result. Native
  complete own fields in `WorkDetailObject`, exact relation counts and at most
  three real parked-by/earlier/later decision refs. No implicit links array.

The result-choice exception (101 rows including selection) does not apply to
Tasks' <=100 rows or batched associations' GLOBAL <=100 rows. Relation pages and
association edge pages are globally <=100 edges, independent of input set size.
No full outcome/rationale/evidence is repeated into row projections.

## Native predicates, order and counts

`needs` is proposed decisions. `in_progress`, `blocked`, `open` are that native
work status with no park metadata. `parked` is unfinished work with park metadata;
`finished` is done/not_pursued, regardless of park metadata. `rules` is accepted
or superseded decisions. `results` is native results. Only mine selects work
owner by authenticated principal kind/id, keeps proposals project-wide, excludes
rules, and selects results by createdBy kind/id. It is not a blind halving of
counts. Summary all/mine counts use these predicates even when a page/search
selects another scope. workTotal is all native work; unfinishedTotal is unparked
open/in_progress/blocked work, not results or parked work.

All Tasks preserves existing reading order: proposals, in progress, blocked,
open, parked, finished, accepted rules, superseded rules, results. Those nine
bands have ranks 0..8. Records within a band use createdAt DESC, id DESC. A rules
view still puts accepted before superseded. A single-kind choice has rank 0 and
uses createdAt DESC, id DESC. Association rows use work, decision, result ranks
0..2, each createdAt DESC, id DESC. Edges and conversation source-count entries
use createdAt ASC, id ASC, rank 0 (existing native relationship chronology).
No kind may collide with another object's identity during deduplication.

Every page includes items, exact total, requested limit, exact `before` count
(selected objects preceding this page in THIS observation), and independent
nextCursor/previousCursor. Empty initial pages have before=0 and null cursors.
An empty continuation caused by concurrent change retains an opposite-direction
cursor based on its supplied boundary if earlier/later selected objects exist;
refresh starts again. The UI explicitly exposes refresh and does not call an
empty page an empty project. `before` is not an offset navigation mechanism.

Summary refs use newest createdAt/id accepted rule, proposal and result;
active/in-progress and blocked first refs use the same newest order. Active count
is unparked in-progress count; blocked count is unparked blocked count. Up to three
distinct active-work owners use native kind/id ordering, excluding null owners,
with exact ownerTotal. Current names are batch-resolved. No first-name grouping.

Each row/detail has exact visible native edge count and distinct related-object
counts: outgoing role=source message identities; outgoing role=source material
identities INCLUDING pinned version; incoming/outgoing decision identities; and
incoming/outgoing result identities. Related-object counts exclude self and
deduplicate by native type/id (material additionally version). Work `rule` is
the oldest visible related decision (edge createdAt/id order), matching the
legacy row helper; parkedBy is the actual native parked decision if readable.
Invisible/deleted/private source endpoints are excluded before every count,
selection and title resolution; none contributes a hidden label or count.

## Association windows

With relation=source, a matching edge must go from a native work/decision/result
object to a scoped message and have role source. With relation=any, its role may
be any existing role; doc-owned edges do not invent a work object. Native objects
are DISTINCT across all scoped messages, with one GLOBAL row page and total.
`edgeTotal` counts all matching visible edges in the complete source scope.

`sources` gives exact work/decision/result DISTINCT object counts and edge count
for EACH selected message, including zeros. messageIds returns all <=100 entries,
sourceTotal is their count and both source cursors are null. A conversation has
independent <=100 message-count entries (including messages with zero links),
sourceTotal is its currently readable message count. `sourceCursor` pages these
entries without narrowing the overall object/edge selector. Its row bound is
fixed at 100, independent of object limit.

`edges` is one GLOBAL matched-edge page for ONLY the currently returned object
window, not one per object. Its exact total and before describe that edge scope;
it has its own next/previous cursor passed as `edgeCursor`. Reset edgeCursor when
the object cursor/page changes. It binds the normalized selector AND the actual
ordered kind/id row window; if concurrent changes alter the window, reject it
with 400 and refresh that page. sourceCursor does not change the object window.
Full additional relationships use work-relations; source native routes preserve
message conversation, thought sketch, material version and doc/sketch identity.

## Cursor and observation fences

Cursor is a closed version-1 base64url JSON envelope with v, direction, scope
and boundary {rank,createdAt,id}. Scope is SHA-256 of a canonical normalized
endpoint/project/principal-kind/id/selector/search/limit tuple (and edge object
window where relevant); source/ref sets are represented by their fixed-size
digest. No session credential, title, name or complete input set is encoded.
Reject unknown fields, invalid keys/timestamp/rank/version and scope mismatch.
Preserve the native PostgreSQL timestamp's full microsecond precision. Cursor
is a continuation hint, never an authority capability. Editing its boundary
cannot add unreadable objects. Next compares after the last displayed key in
normal order; Previous compares before the first key in reversed SQL order then
reverses the bounded result. A direct URL/reload requires no client history stack.

Counts, page, policy, current labels and context refs are computed together in
one read-only REPEATABLE READ transaction. observedAt is that transaction's
timestamp, not an immutable multi-page snapshot. Combined view.summary has that
same observation. Association row/source/edge totals and all windows are from
its same observation; unrelated GETs explicitly remain separate observations.

Before serialization, outside that transaction, resolve the same exact native
session and central current project.read policy again. Recheck relevant native
source visibility, INCLUDING source facts that contributed to counts without
being in the returned window, using bounded current-policy queries/aggregate
scope fingerprints rather than hydrating an unlimited graph. A revoked/expired/
replaced session, removed project access or changed source-visibility scope
invalidates the assembled response; source scope drift uses 409 `work_read_changed`
and explicit refresh. Deleted/foreign required selectors use 404. Access metadata
comes from the final current-policy check. No policy failure becomes zero counts.
Fail required DB/name/count operations as unavailable, never fabricated totals.

Clients bind responses to account/project/selector/generation; late responses are
ignored. A combined page+summary replaces its active shared facet atomically;
a standalone summary cannot overwrite that active page with another observation.
Native command versions, If-Match, idempotency, 50-link limit and creation/park/
finish semantics do not change. The existing behavior/performance evidence gates
remain required after implementation, including the private draft continuity fix.
