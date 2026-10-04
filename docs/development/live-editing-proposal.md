# Live map and wiki editing — proposal for #228

Date: 2026-10-03. Owner: @PelikanFix16. Status: **accepted for bounded, isolated,
disabled non-production calibration; all runtime gates pending**. The independent
[reassessment](../agents/evidence/228-live-editing/contract-rereview.md) accepted
the exact proposal at [8d71f582](https://github.com/ColdPhase/flux/blob/8d71f58217cf40f9c2575f3a8d226ea0bf76a9c7/docs/development/live-editing-proposal.md),
SHA-256 `1366410fea8a2d020274ee75febad6ac86cef459dcb3ae3d3ad66e5063b9ce38`.
This status recording changes no technical criterion. No implementation, runtime
or performance result is claimed. [#228](https://github.com/ColdPhase/flux/issues/228) admits the outcome:
two people see map movement during a drag and wiki writing during typing, with
identified collaborators. Foundation 8.4, 8.7, 8.14 and 8.15 apply.
Revision 2 addresses the independent 2026-10-03 contract review's C1–C4; it does
not claim that any calibration gate has passed or that implementation/runtime
acceptance has been granted.

Choose a native, transactional map with transient movement previews, and a Yjs text
replica for each existing wiki doc. Both use the current API origin, Fastify runtime,
PostgreSQL and WebSocket libraries. No paid service, separate collaboration host,
LiveKit dependency or AI invocation is required. Human editing does not wait for #153.
[F-019 personal AI ownership](../product/decisions.md) and F-020 provider neutrality
remain intact: editing authority never confers permission to invoke another person's
agent. This technical proposal does not overwrite or allocate a founder decision ID.

## Evidence and alternatives

**Source observations**, read at main `085214c6c58e265d1d19b2c56a12368a370ed24f`:

- `app/apps/web/src/sketch/SketchMap.tsx:201–243` changes local offsets during
  pointer movement and calls `onMove` on pointerup. `sketch/doc.ts:163–195` refetches
  after 120 ms and postpones adoption while any local operation is in flight.
  Its generic conflict retry can reapply moves/removals on a newer version.
- `app/apps/web/src/docs/DocEditor.tsx:30–88` restores private session storage into
  local fields; `:117–128` sends the whole body only on Save version.
  `DocViews.tsx:18–25` refreshes on focus or a 20-second interval. These paths do
  not provide live text replication or remote cursors.
- `app/packages/contracts/src/docs.ts:24` allows 100,000 JavaScript string code
  units of body text. `core/src/docs/service.ts:280–325` and
  `db/src/repositories/docs.ts:63–65` serialize version writes against the material
  row. Current HTTP, MCP and Add to docs writes must all join the new fence.
- `app/apps/server/src/stream/` already authenticates origin/session, receives
  PostgreSQL wakeups, rechecks current access before delivery, and bounds queued
  output. Incoming stream messages are ignored. `server/src/index.ts:74` caps
  that WebSocket server at 1,024 bytes. Reusing its endpoint unchanged is inadequate.
- [Sketches](sketches.md), [docs/wiki](docs-wiki.md),
  [access policy](access-policy.md) and [architecture](architecture.md) remain the
  native object, audience, immutable evidence and dependency contracts.

**Primary documentation**, accessed 2026-10-03; these are maintainers' descriptions,
not Flux measurements or independent claims of production performance:

| Source | Relevant documented behavior | Consequence / inference for Flux |
| --- | --- | --- |
| [Yjs document updates](https://docs.yjs.dev/api/document-updates) | Binary updates are commutative, associative and idempotent; state vectors select missing differences. Binary merging alone does not collect garbage. | Reordering/retries can converge; retain a real checkpoint and test compaction, rather than an unbounded concatenation of updates. This says nothing about authorization or durable ACKs. |
| [Y.Doc](https://docs.yjs.dev/api/y.doc) | `clientID` is documented readonly and should not be reused across sessions. | Enroll a fresh client's generated ID before local structs; never assign a server-selected ID or reconstruct a new session with the old ID. Durable enrollment authorizes exact old-byte recovery, not reuse of old clocks. |
| [Yjs UndoManager](https://docs.yjs.dev/api/undo-manager) | Undo can track selected transaction origins, group nearby changes and stop grouping explicitly. | Track this editor's human origin only; exclude remote, initial sync and checkpoint origins. Test concurrent own undo, including replacements. |
| [Yjs relative positions](https://docs.yjs.dev/api/relative-positions) | Relative positions follow shared text rather than obsolete numeric offsets; resolution can return null. | Use them for remote cursors/selections; hide unresolved positions until synchronized. |
| [Yjs awareness](https://docs.yjs.dev/api/about-awareness) | Optional presence is separate from document content; its default is schemaless client JSON and a 30-second timeout. | Do not trust its supplied names/IDs or adopt that timeout blindly. Use a closed server-identified presence protocol and a short explicit expiry. |
| [Yjs CodeMirror binding](https://github.com/yjs/y-codemirror.next) | Supports CodeMirror 6 text, remote selections and separate per-client undo. Its current main is the unstable v14 binding; maintainers recommend stable `y-codemirror.next` with Yjs v13. | Choose the stable v13 family; resolve and pin exact compatible releases in Docker before the spike, and include their notices. Do not copy the unstable main example. |
| [Yjs v13.6.27 public exports](https://raw.githubusercontent.com/yjs/yjs/v13.6.27/src/index.js) and [decoder source](https://raw.githubusercontent.com/yjs/yjs/v13.6.27/src/utils/updates.js) | This inspected stable tag exports `decodeUpdate`, whose result exposes structs and delete ranges, and the public content classes. It marks `PermanentUserData` experimental. | Structural inspection has a public source basis; full room/actor/dependency validation remains a spike obligation. Do not use experimental client author metadata as trusted attribution. This tag is an inspected example, not a claim that it is today's newest patch. |
| [CodeMirror's official OT example source](https://raw.githubusercontent.com/codemirror/website/master/site/examples/collab/index.md) and [collab source](https://raw.githubusercontent.com/codemirror/collab/main/src/collab.ts) | A central authority orders changes; clients retain unconfirmed changes and rebase them over remote changes. The server must retain intervening change information or reject stale submissions. | OT is viable, not disproven. It would require a retained transformation history, cursor mapping and recovery contract; choose CRDT for reorder/offline reconciliation and relative positions. The GitHub source is a moved official repository, not a new-maintenance guarantee. |
| [PostgreSQL NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html) | Delivery occurs after transaction commit; identical notifications in one transaction can fold. Payloads are below 8,000 bytes in the default configuration. Tables can hold the actual data. | Notify bounded record identifiers, then read committed data. A wakeup is neither a receipt nor a substitute for replay. Use short transactions. The installed pinned image's exact version still needs runtime recording. |
| [Fastify WebSocket](https://github.com/fastify/fastify-websocket) | Upgrade hooks can authenticate; message handlers must attach synchronously; post-upgrade messages are outside the ordinary HTTP lifecycle. | Revalidate each editing message/delivery and handle errors explicitly. Do not assume an upgrade check authorizes a later write. |
| [ws multiple-server/authentication examples](https://github.com/websockets/ws#multiple-servers-sharing-a-single-https-server) and [server options](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback) | Separate `noServer` instances can share one HTTP server through one path-dispatching upgrade handler. Each instance has its own `maxPayload`; authenticate before `handleUpgrade`. | A dedicated bounded editing server is supported without raising the event stream's global receiver limit or using private receiver fields. |
| [WebSocket standard](https://websockets.spec.whatwg.org/) and [browser API guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) | `bufferedAmount` exposes queued output; the ordinary browser API supplies no automatic receive backpressure. | Bound queues and work, coalesce transient state, and disconnect/recover slow consumers instead of buffering indefinitely. |

**Decision inference:** plain whole-body CAS plus saved-event refresh cannot satisfy
concurrent character editing before Save. Migrating every map object to a CRDT would
add a second authority for graph relationships, placements and access without a
demonstrated need. The hybrid keeps SQL authoritative for those objects and uses a
text CRDT only where concurrent character operations require it. CRDT convergence
does not excuse silently replacing a working copy or accepting unauthorized bytes.

## Common transport, authority and lifetime

Use a separate versioned `/api/v1/editing` WebSocket gate on the existing Fastify
server, with the existing `ws` no-server/upgrade-dispatch pattern (as used by the
media gate). Keep `/api/v1/stream` and its 1,024-byte inbound limit intact. Public
wire types belong to contracts; policy and use cases/ports belong to core; database
rows belong to db; Yjs codecs and transport adapters belong to server/web, not core.
No new architecture exception or mutable global singleton is admitted.

The existing single upgrade dispatcher selects exactly one owner: media, editing,
or the current Fastify stream emitter. Editing has its own
`WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })`.
Do not register competing upgrade listeners or modify `ws` private receivers.
Authenticate origin/session before its `handleUpgrade`, attach message/error handlers
immediately on acceptance, and use bounded asynchronous admission thereafter. Shutdown
closes tracked editing sockets as well as the separate server. An alternative is
bounded HTTP text-update writes plus editing WS downstream/small presence frames;
it avoids larger inbound WS frames but adds two transport/recovery paths. Keep it as
a fallback if the separate-server integration fails calibration, not an implied
ability to send large updates through the unchanged Fastify stream server.

Each subscription is bound to a server-issued connection/room identity, current
session, resource ID and generation. Actor ID, display name, cursor label and colour
come from server identity; a client cannot set another participant's identity.
Client update UUIDs are receipts, never capabilities. Resolve the existing policy at
subscribe, every write and immediately before delivery; preserve native access-row
locking/order for writes and serialize revocation with pending delivery. Drop queued
data and close the resource subscription when authority changes. Reauthorization
must happen after a failed connection, not just when its initial token was issued.

The editing delivery linearization point is the synchronous handoff of one bounded
frame to the WebSocket transport, while holding a PostgreSQL authorization fence over
the current session and resource's access rows in the established policy lock order.
Every API process uses the same fence; revocation takes the conflicting fence before
committing. Revalidate current rights/expiry under it, check the queue limit, hand off
at most the authorized frame, then release it without waiting for a slow send callback.
After revocation commits, no new protected frame may cross this point; discard all
application-queued content/presence and close its subscriptions. A separate access
query followed by an unlocked send is insufficient. Bytes already handed to the
transport before that boundary were authorized then and cannot be recalled; record
them separately in tests rather than claiming the server can revoke network history.
Prove the fence covers session deletion, membership/grant/DM changes and expiry, not
only in-process room removal. If the existing policy path lacks a shared fence, add
it through core ports before admitting this path, not a second authorization module.

Project maps/docs follow current project roles. Private maps remain author-only;
DM maps remain current-participant-only, with closed 1:1 DMs read-only. Viewers can
receive content and identified presence but cannot write text, start a movement lease
or claim to be an active writer. Agents cannot use this human-session editing route;
their standing-grant native API retains current rights and the wiki fence below.
Invisible resources have the same opaque failure as missing ones. Resource/account
changes cancel subscriptions and clear remote state; local recovery is bound to the
original account, audience, object and generation. A DM-to-project copy creates an
independent room and never forwards private updates or participant identities.

Presence uses closed fields (active mode, selected native IDs or relative text
positions), increasing per-connection sequence and server expiry. Unchanged presence
uses at most one heartbeat per second; **changed cursors/selections/writing activity
are sent promptly with the 40 ms maximum batch window**, not once per second.
Expire after five seconds, sweep at least once per second, and send leave on
blur/navigation/close when possible. Movement/cursor updates also renew activity.
Do not replay expired presence after reconnect/restart. Protocol generations and
terminal sequence watermarks prevent late packets from resurrecting ended activity.
Participant names supplement colour; motion is restrained and respects reduced motion.

Proposed bounded budgets for calibration: 64 KiB inbound update/frame, chunked initial
sync, 2 KiB presence, at most 200 native IDs in a selection/move (existing map limit),
40 ms maximum batching for text/preview and movement, 1 MiB queued output/pending
bytes per connection, and 8 MiB encoded room checkpoint. Rate/burst limits include
25 movement packets/s and 50 text packets/s per connection. Reject oversized,
malformed, cross-resource and unsupported shared types before room mutation; bound
decode/validation time and concurrent work. Byte chunks need room/generation binding,
index/count/aggregate limits and atomic validation; arbitrary binary fragments are
not individually applied. The 64 KiB frame limit includes its envelope; sync payload
chunks use at most 60 KiB each. Initial/checkpoint sync allows at most 144 chunks and an
8 MiB aggregate with a ten-second assembly expiry; its flow-control window is at most
1 MiB, separate from the 1 MiB unacknowledged-edit budget. Candidate per-API caps are
one assembly per connection, four concurrent assemblies/32 MiB aggregate, two codec
workers (64 MiB heap each, 100 ms task deadline and termination on timeout), eight
waiting decode tasks, 16 active room caches/128 MiB aggregate, and 32 editing sockets.
Frame, struct/delete-range and external-buffer accounting must bound work that a
worker heap limit alone does not cover. Record/review any adjusted fixture caps before
running it; these are calibration candidates, not promised deployment capacity.
Coalesce only replaceable presence/movement/preview, never
drop admitted text updates. Close an overloaded client with a recoverable reason.
Storage compaction must keep confirmed text, receipt/provenance information and
replica compatibility; crossing a limit pauses writes honestly, not silent truncation.
The 2 KiB presence limit cannot carry 200 UUIDs: presence includes at most 16 selected
IDs plus total count or a server-issued lease reference; the authorized movement
preview carries the complete selected set within its separately bounded frame/assembly.
Enforce actual encoded byte limits including server identity, not just item counts.

No keystroke, cursor, lease or movement-preview creates project events, unread counts,
return-view items, notifications, AI requests or model charges. Only deliberate
native map commits and saved wiki versions retain their existing durable event behavior.

## Map contract — live preview above native state

1. The map holds a confirmed native snapshot plus this client's pending operations
   and authorized transient overlays. Opening a map subscribes and catches up from a
   revision atomically with the snapshot; gaps trigger snapshot reconciliation.
   Committed server deltas carry room/sketch revision, command ID and affected native
   objects, including deletions. Hydration of object titles/placements still applies
   current read rights. No client-supplied delta is relayed as an authoritative change.
   Cover rename, thought add/update/move/remove, link add/remove and promotion/copy,
   including authorized agent/native writers; copies have independent room identity.
2. Start a drag with a short server-issued movement lease over all selected existing
   thought IDs and their base versions. Acquisition is all-or-nothing; another drag
   on the same thought gets a clear named conflict. Independent thoughts can move
   together. Store only bounded latest preview/lease state in expiring PostgreSQL
   rows; notify identifiers across API processes. It is not native placement/history
   and is never replayed after expiry. This avoids an extra broker or sticky host.
   The HTTP acquire binds actor/current SQL session, resource/generation and gesture
   to the lease. Its first authorized movement or cancellation atomically binds the
   server-generated WebSocket connection ID; subsequent other connections refuse.
   No client-supplied actor or connection identifier creates authority. Current
   lease/session/versions are still checked again in the final native CAS transaction.

3. Send bounded absolute preview positions during pointermove; peers render them
   before pointerup and see the authenticated mover. Preserve each peer's camera,
   selection and keyboard focus. Pan/zoom remains local. Preview does not create new
   thoughts or share #149's private draft text. Resizing follows the same transient
   lifetime; keyboard moves use immediate native commits with the same attribution.
4. Pointerup sends the existing all-or-nothing positions command with idempotency
   key, lease ID and expected native versions; current rights and lease/version
   checks occur in its transaction. ACK follows commit, then a committed delta clears
   the matching preview. Cancellation, expiry, error or revocation removes preview
   and exposes the confirmed placement; unsaved intent stays recoverable locally.
   A concurrent non-drag native/agent command still works under native CAS. If it
   changes a leased thought, end that preview; refuse a stale final move rather than
   reapplying it silently on the newer result. Leases are an interaction safeguard,
   not a new permission or permanent graph lock.
5. Replace global in-flight blocking/refetch debounce with ordered confirmed deltas
   and per-object pending overlays. Remote unrelated adds, edits, links and removals
   remain visible during a long local drag/save. Own undo uses versions/result IDs
   of the command being reversed; if a peer changed the affected object or dependent
   link since, refuse that inverse with a recoverable explanation. Never delete a
   peer edit by retrying an undo against the newest version. A removal inverse must
   also preserve intervening link changes. Camera/outline changes remain local undo.

## Wiki contract — durable shared work, explicit immutable versions

An existing doc has one shared Markdown body (`Y.Text`), initialized from its current
saved material version by the server exactly once. The ordinary current-page reader
shows this working body and named writing locations, with “Shared working copy” and
the last saved version clearly visible. Edit mode explicitly states that typing is
visible to everyone with current project access; there is no private-until-Save
implication. New, not-yet-created docs remain private local drafts until Create doc.
Title, state and version reason stay deliberate native metadata commands in this slice.

Use stable Yjs v13 and the compatible CodeMirror 6 binding. The server accepts only
the one plain-text body type: no client-declared second text, rich-text attributes,
embeds, subdocuments or arbitrary metadata. A server codec validates a candidate
replica without mutating/broadcasting committed state. Malicious/invalid update
failure cannot poison a shared room or crash the API. Text retains the existing
100,000-code-unit body limit; test Unicode/IME and bytes independently of that limit.
Use a bounded Node worker-thread codec so a timed-out/malformed decode cannot block
the API event loop. A source-level spike must prove validation through public exports
of the pinned stable Yjs version, including unknown roots/types, hidden unresolved
dependencies and excessive struct/delete ranges; do not rely on private internals.
An unresolved dependency is bounded pending input, not an admitted/successful edit:
request missing data or a complete bounded pending bundle, then validate/admit it
atomically. Never retain an unvalidated update in the confirmed journal for later
surprise application. Validate complete parent/origin/clock/delete dependencies,
including forbidden state that would otherwise emerge only after a later missing
dependency; a valid `body.toString()` is not sufficient. Reject inconsistent duplicate
struct content and out-of-range/future deletes. Known exact duplicates do not receive
new provenance. Presence uses its separate server-owned identity.

**Replica enrollment:** a fresh `new Y.Doc()` generates its documented client ID.
Before that instance produces any local structs or binds an editable editor, submit
the ID for enrollment into the currently authorized resource/generation. The server
persists ownership `(room, generation, replica ID) → authenticated actor` and records
the active instance lease; the ID is not an authority supplied by the client. An
atomic enrollment collision rejects the candidate. Destroy that still-unused doc
and create a fresh one; never assign `clientID`, patch internals, or reuse the colliding
ID. Every tab/new doc is enrolled independently. Server initialization has its own
recorded replica; new client struct ranges must belong to that client's enrolled ID.
Enrollment/provenance remain durable across API restart and checkpoint compaction;
retiring a socket does not release an old ID for another session to generate under.

A socket reconnect with the **same surviving Y.Doc instance** keeps that instance's
ID/clocks and own undo; it renews its instance lease under current authorization.
A browser reload, new session or destroyed doc creates/enrolls a fresh generated ID.
It must never restore the previous ID into that new instance. The recovering client
retains old pending commands as their original encoded bundles, namespace/UUID and
fingerprint; it does not regenerate or merge bytes under the old ID. For a stored
receipt or stored pending intent, the server verifies exact replay against its durable
fingerprint. Previously unseen recovered bytes are a **first admission**, with current
write authorization, the original generation/enrolled ownership, full candidate and
dependency validation, and the same serialization/CAS boundary. The server cannot
prove their pre-crash creation time or original byte identity without a stored record
and must never label that admission as an already-confirmed retry. Establish or
reconcile the original commands before enabling fresh edits; apply
confirmed recovery/checkpoint into the new doc as remote initialization, excluded
from its new own-undo stack. The UI states that undo from the closed editor session
is unavailable; it must not pretend the new stack reverses that session. If rights
or generation changed, keep recovery private, reconcile any already-admitted receipt
without applying it to the new generation, and offer deliberate text/diff import.
Collision, tabs, surviving-instance reconnect and new-instance byte replay are
mandatory spike cases. If supported public validation/enrollment cannot be proved,
**stop the CRDT production path and require fresh independent acceptance of the
bounded OT alternative**. Neither private API mutation nor weaker guards is a fallback.

PostgreSQL stores the room generation, saved-version binding, checkpoint/state vector,
confirmed text/hash, admitted updates and immutable scoped receipts described below.
A serialized document transaction rechecks policy, locks the material/live head in
the established access-before-material-before-live-head order, validates against
current committed state, and persists the
update/checkpoint, actor provenance and sequence. Only **after commit** does the
server ACK; fanout reads only committed records. A **definite rollback** produces no
admitted journal/receipt, ACK or fanout. A lost/failed COMMIT response is **unknown**,
not proof of rollback: show recoverable pending/unknown state and reconcile the
original immutable receipt in a new authorized transaction at the same serialization
boundary. Acquire the original material/live-head lock after the uncertain transaction
has ended; a found receipt establishes the original admitted result, while absence
at that boundary allows an exact retry. If that boundary cannot yet be acquired,
retain unknown state. Do not reset/delete confirmed data or assert “never shared.”
Include definite rollback and lost COMMIT response injection separately. “Synced”
requires an established original receipt for every local update; Save is disabled
while an update's outcome is unresolved.
Cross-process NOTIFY carries identifiers; listeners replay committed rows after their
last sequence, and reconnect uses state-vector difference plus receipt checks. Missing
wakeups are recovered by catch-up, not by treating NOTIFY as a durable log.

**Receipt identity:** the canonical key includes workspace, resource kind/ID, room,
generation, authenticated actor, operation and command UUID. An actor/UUID intent
binding also makes those namespace fields immutable, so submitting that UUID in
another room/generation/operation cannot masquerade as a new successful retry.
The server computes SHA-256 and byte length over the original text-update bytes plus
canonical persistent envelope (scope/generation, operation, replica and UUID); transient
socket IDs, current session tokens and retry timestamps are excluded. Reconnect may
change that transport envelope, never the stored update bytes or intent parameters.
Native commands hash their canonical request parameters and CAS preconditions. Persist
that fingerprint and original admitted sequence/result atomically with the change.
Changed bytes, namespace or parameters under the same intent receive typed
`EDITING_IDEMPOTENCY_CONFLICT`; do not return success for different content. Exact
retries recheck current authority before returning any protected receipt/result.
Save's fingerprint includes expected material version, live generation, acknowledged
head sequence/hash, title/state/reason and every deliberate snapshot parameter. Its
original snapshot/version result is immutable even after later edits. Generation
changes never rebind an old UUID or admit its old bytes into a new room generation.
Compaction retains namespace/fingerprint/result and enough replica/dependency identity
to reject altered retries; expiry cannot quietly free that UUID or replica clock.

Typing appears locally immediately and remotely from admitted updates without waiting
for Save. “Synced” means all this client's submitted updates are acknowledged, not
that an immutable version was saved. Shared server-rendered preview uses the existing
Markdown sanitizer/reference resolver with a bounded render queue (no 250 ms editor
preview debounce on the measured live path). A live reader must see the text within
the same accepted latency target; editor-only evidence is insufficient. Preview
generation/sequence prevents a delayed render from replacing newer content.

Cursor/selection uses relative text positions and server-identified participants;
recent change ranges can be highlighted briefly beside the author's name. Own undo
tracks only this editor's origin, with deliberate group boundaries and cursor restore;
remote sync and initialization never enter its stack. The ledger attributes admitted
updates to the authenticated actor; CRDT client IDs and client JSON are not forensic
proof of character authorship. Immutable saved versions name the person who saves
and retain the contributing actor/update interval since the previous snapshot, so
one person's Save does not misrepresent all concurrent text as their sole writing.

**Save version** first flushes/awaits this editor's pending updates, then submits an
idempotent snapshot command containing expected material version, live generation
and acknowledged head sequence/hash. Under the same lock it snapshots exactly that
confirmed shared body into `project_material_versions`, with reason/state/metadata,
contributors and saved-by identity. A newer head returns a truthful conflict for
refresh/retry, not a snapshot falsely claiming a previous body. Saving advances the
saved binding without resetting collaborators' text/undo or discarding later edits.
No-op saves retain existing no-new-version semantics.

History, existing `materialId/version` citations, source quotes, mentions/backlinks,
exports/search/agent-source bindings and return events remain based on immutable saved
versions. A live working body is never relabelled as one of those versions. Existing
GET/PATCH version APIs keep their saved-snapshot meaning; the explicit live endpoint
serves working content. Historical readers do not receive live replacement text.
Plain-text source quotes and saved-material projections must resolve the cited saved
body, title and version, never whichever live body the browser currently displays.
Live preview resolves references using current rights but does not mutate saved
mentions/backlinks, source links or material projections per keystroke. Those changes
belong in the authorized snapshot transaction; inaccessible/private reference titles
remain unavailable, including in a delayed preview or historical quote response.

**External writer fence:** all body/section/rewrite paths (HTTP, MCP, Add to docs and
any job) inspect the live head in their current authorized transaction. When working
text differs from its saved binding, refuse the legacy write with a typed
`DOC_LIVE_WORKING_COPY_CHANGED` conflict; metadata-only legacy writes also refuse
until the shared snapshot path incorporates them. Do not silently snapshot/rebase
human text on behalf of an agent. Place the shared-core fence before no-op returns
and before source-link/mention/material mutations, including metadata-only commands;
route guards alone are insufficient. Inventory-test HTTP `updateDoc`, `addSection`,
MCP `nativeDocsInEventSession` and any projection/job writer. The generic material
API continues rejecting doc-kind updates with `USE_DOC_API`.
When the live copy is clean, a valid legacy CAS write
creates its immutable version and a new room generation/checkpoint atomically.
Pending updates from the old generation are fenced and retained privately for
explicit recovery. A simultaneous live update/native save is ordered by the same
lock: either admitted live work fences the native writer, or the native writer changes
generation and the old pending update receives an honest rejection. A bounded merge
API can be planned later; its absence must be explicit to the agent/user, not success.

Old `flux:doc-edit:…` session recovery never initializes or mutates a shared replica.
Offer a separate private comparison, with deliberate selected-text/diff import into
the current body. Offline live pending updates can resume automatically only for
the same authenticated account/resource/generation after current write authorization;
if a generation or rights changed, retain private recovery and explain why it was
not sent. Route/account changes do not reuse another replica's pending queue. Persist
bounded pending data in account-scoped browser recovery and report blocked storage.
Confirmed server text survives process restart; losing a reply after commit is repaired
by deduplicated receipt lookup. Save never reports success while local text is pending.

## Independent verification and latency gate

The proposed healthy local threshold is **p95 input → peer rendered state ≤200 ms**
for map movement, committed map changes, wiki editor text and wiki current-page preview.
It is an unmeasured acceptance proposal, not a vendor promise or a claim about the WAN.
The independent evaluator must accept the fixture/method/budgets before production
work; an isolated Docker prototype then calibrates them before a performance claim.
If a candidate transport/storage budget fails, optimize or review the finite fixture
choice with actual evidence. The p95 ≤200 ms target and movement-before-pointerup /
typing-before-Save outcomes remain; do not redefine them as eventual saved refresh.

Use two distinct authenticated users and real trusted pointer/keyboard inputs in
separate browser contexts, one foreground test at a time. A single test driver uses
one monotonic clock: start immediately before the trusted input; end when the peer
reports a correlated rendered state after the next paint opportunity (two animation
frames). This is a conservative DOM/render opportunity bound including driver hops,
not proof of physical pixel presentation. Report that
overhead through a local-render control, without subtracting it to manufacture a pass.
Do not compare unrelated browser `performance.now()` clocks. Include a recording/trace
showing movement before pointerup and characters/named cursor before Save.

Pin the sampling schedule before running: after warmup, sample the next trusted input
every 250 ms for at least 60 seconds (at least 240 scheduled samples), while continuous
pointer movement at the fixture's recorded input cadence and continuous typing/cursor
changes continue between samples. Do not replace that load with spaced single inputs.
Each row retains input timestamp, account/resource/generation, interaction ID/input
sequence or immutable command/update UUID, publication/receipt sequence and render
sequence. Map preview and safe-reader preview are replaceable: a sample ends when a
rendered later sequence of the **same interaction/generation** covers its sampled
input, even if the exact earlier position/preview was coalesced away. Record that
sample as superseded-covered and retain publication cadence/count, coverage mapping
and superseded count; a final pointerup packet cannot substitute for live drag evidence.
Committed map commands and text require proof that their sampled command/update is
included in the rendered contiguous confirmed head, using its immutable receipt and
generation/sequence or state vector, not a coincidentally matching string/coordinate.

Every sample has a fixed 1,000 ms timeout. Publish **every scheduled row**, including
timeouts, wrong-generation/uncovered observations, admission errors and overload.
The denominator is scheduled samples, not only successful arrivals. Compute nearest-
rank p95 over all scheduled samples, with timeouts/errors assigned +∞; also report
the finite successful distribution separately. A healthy-local pass requires p95
≤200 ms **and zero timeout/error/overload samples**. Superseded-covered samples retain
their measured latency in that denominator; dropped/uncovered samples never disappear.
Induced-loss/slow-network recovery has separate reported failures and cannot replace
the healthy-local run. Named cursor/selection movement is sampled during continuous
typing before Save; the one-second presence heartbeat does not bound its update rate.

Record exact commit/dependency versions, hardware/OS, Docker limits, DB image/version,
browser/viewport/zoom, foreground visibility and network condition. Warm 30 samples,
then collect at least 200 scheduled samples over at least 60 seconds per scenario
(the fixed 250 ms schedule normally produces at least 240); report raw
samples, p50/p95/max, errors, queue depth, commit ACK and rendering segments separately.
Fixtures: two users; 50/500-thought maps and 10k/100k-code-unit docs; continuous typing,
IME, cursor selection, multi-thought drag, simultaneous edits and own undo. Hidden
tabs/background throttling, WAN and overloaded clients are separate recovery cases.
At 100,000 code units, use equal-length replacements and delete-then-insert editing
that never exceeds the limit; include Unicode/IME completion at the boundary. A
separate 100,001-code-unit/oversized-byte test must reject and preserve private pending
recovery without poisoning peers. Do not raise the body limit to accommodate the load.
The 50/500-thought fixtures are total map size, not a selection/frame limit: keep each
atomic move within the existing 200-thought limit and bounded packet/assembly budget.
Measure 1-, 50- and 200-thought drags on those maps where possible; test 201 selected
thoughts as an explicit bounded-input rejection/recovery case. Long histories and
100k preview rendering exercise checkpoint, assembly, worker and queue caps honestly.

| Required case | Independently observable result |
| --- | --- |
| Baseline negative controls | Current pointermove remains local; current typing remains local until Save. New implementation shows peer changes while the originating interaction is still active. |
| Same place, two writers | Same-position inserts/deletes and replacement/undo converge; own undo does not erase the peer. Same-thought drag contention is named; different thoughts proceed independently. |
| Pending local map work | Remote add/link/edit/remove renders while a local request is delayed; camera/focus/selection/private new-thought draft remain coherent. |
| Drop/duplicate/reorder, slow receiver | Confirmed text/deltas converge, transient sequences never revive expired previews, limits close/recover one slow client without stalling others. |
| API restart / reply lost after commit | Acknowledged text remains; definite rollback and unknown COMMIT response are distinguished, and exact receipt reconciliation repairs the latter. Altered retries fail; fresh-instance enrollment never reuses old clocks; expired presence is absent. Include two API instances sharing PostgreSQL for fanout/lease ordering. |
| Revoke session/member/DM access during activity | No new protected dispatch crosses the shared authorization fence after revocation commits. Discard application-queued output, distinguish previously handed-off authorized bytes, refuse writes, and keep unknown/cross-scope rooms opaque. Viewer/outsider/forged actor frames fail. |
| Save/API/MCP race and historical quote | Dirty live work fences every native writer; clean writer changes generation; old pending bytes stay private. Saved version/citation content remains byte-for-byte unchanged while new typing appears. |
| Recovery and safe rendering | Old local draft requires explicit import; account/route/generation change cannot broadcast it. Hostile Markdown remains inert in live preview and saved history. No keystroke unread, push or model work occurs. |
| Phone/tablet/desktop and assistive interaction | Keyboard, IME, focus, touch drag, scrolling, remote selections and reduced motion work at 390/768/1440 widths. Separate neutral visual review uses realistic long content; physical-device checks remain honestly unverified until exercised. |

### Four finite non-production calibration gates

Fresh independent assessment first accepts this revised contract and fixture pins/caps.
Then run each gate once on its pinned fixture, repair demonstrated failures and rerun
only the affected gate. Record a finite pass/fail/blocked result for every gate.
Implementation in an isolated, disabled development/calibration fixture is admitted
to build and measure the actual database, validator, safe-preview and widget path;
that fixture must not substitute a shortcut for those components. Production
enablement, merge and acceptance of the live feature wait until all four gates pass
and receive independent assessment. These gates do not themselves grant final
implementation, visual, performance or release acceptance.

1. **Transport:** actual single dispatcher, media enabled and disabled; immediate
   first frames; 65,536-byte editing boundary accepted and larger rejected; existing
   stream rejects >1,024 bytes; exactly one owner handles each path. Origin/session
   refusals precede protected bytes; shutdown closes media/editing/stream sockets.
   Pin exact dependency/environment versions and the per-connection/assembly/worker/
   server aggregate caps above before running. Compare the stated bounded HTTP
   alternative only if this transport candidate demonstrably fails.
2. **Stable codec and replica:** pin one compatible stable Yjs instance/binding and
   public exports. Validate the complete candidate graph and deletion dependencies,
   not just resulting text. Reject extra roots/types/attributes/embeds/subdocs,
   actor/room/generation spoofing, inconsistent duplicate structs, unresolved parent/
   origin/clock gaps and future/out-of-range deletes, including malicious bundles
   whose forbidden state appears only after another dependency arrives. Exercise
   Unicode/IME, 100k text/bytes, timeout/worker termination, fresh-ID collision and
   multiple tabs, durable enrollment after API restart, same-instance reconnect,
   new-instance byte-identical replay, compaction and long edit/delete histories.
   No confirmed state mutation or provenance fabrication is allowed on rejection.
   **Failure to prove supported public validation/enrollment stops Yjs production;
   the bounded OT alternative needs a new independently accepted contract and the
   same user outcome and latency gates.**
3. **Authority and persistence:** two API processes, shared PostgreSQL, explicit
   barriers for lease/native CAS and stale final drag; own undo with intervening
   links; Save/live edits; every dirty/clean HTTP/MCP/section/metadata writer;
   definite rollback versus lost COMMIT response; missed NOTIFY/restart;
   exact/altered namespace/payload/Save retries and retained receipts/provenance.
   Prove cross-process authorization-fence ordering with session/member/grant/DM
   revocation, application-queue discard and old-generation rejection; separately
   account for authorized bytes already handed to transport. Inventory native
   writers/projections and fence before no-op/source-link mutations. Historical
   plaintext quotes/citations and saved-material projections remain unchanged.
4. **Actual path and interaction:** corrected fixed continuous sampling, original
   50/500-thought and 10k/100k-code-unit fixtures and boundary rejection/recovery;
   trusted inputs, editor **and ordinary live reader**, changing named cursors,
   multi-drag, two concurrent writers and own undo. Preserve p95 ≤200 ms, 30 warmups,
   all scheduled raw rows and failure denominators, 60-second minimum, ACK/render
   segments, queue/cadence/superseded counts, environment/head pins and recorded
   negative controls. Exercise phone/tablet/desktop, keyboard/reduced motion and
   continuous movement-before-drop / writing-before-Save. The actual path includes
   database validation and safe Markdown preview; bypassing them is not calibration.

## Bounded PR sequence and exact bases

All changes use new owner worktrees; existing active peer branches #166/#170 remain
untouched. Record the accepted contract review in #228; no founder approval queue is
created. Current protected GitHub gates and independent approval remain unchanged.

1. **Contract/calibration:** this document lives in `codex-hubert/228-live-collaboration`
   from `085214c6`. Fresh independent assessment must resolve the budget/method and
   inspect replica validation, writer fences and Save provenance. A non-production
   Docker fixture pins stable dependencies and measures the actual proposed path;
   substantial Docker work waits for the active #154 serial test slot as of this
   revision and an explicit root slot grant. No Docker was run for this proposal.
2. **Map live interaction:** new `codex-hubert/<new-issue>-map-live`, PR base
   directly from combined `codex-hubert/222-map-fit` at
   `13fd739cb1958a92bc52f83490d284956ffe09fa` ([#226](https://github.com/ColdPhase/flux/pull/226)).
   Read-only ancestry verification confirms it includes #223's
   `e58b46bfc821e5d377df0b04b5a1449b9a660e9d` ([#227](https://github.com/ColdPhase/flux/pull/227)).
   Recheck/record the actual combined head before claiming the child; do not compose
   the obsolete #222/#223 pins. Deliver common editing gate/authority, native deltas, leases,
   move-before-drop, conditional undo, recovery/privacy and measured map evidence.
3. **Wiki live editing:** new `codex-hubert/<new-issue>-wiki-live`, PR base the pinned
   map-live head (reuses its gate), composing owned wiki UI
   `claude-hubert/136-wiki-panes` at
   `82d0758b0d49dc0bd58699d41879e9d634a686e7` ([#197](https://github.com/ColdPhase/flux/pull/197)).
   Deliver text journal/provider/editor, named cursors, own undo, live reader preview,
   shared-copy visibility, immutable Save/provenance, every native-writer fence and
   two-user/restart/latency/privacy evidence together. Database migration number is
   assigned after reconciling the composed ledger; do not reserve/reuse a peer's number.
4. **Composed acceptance:** pin the final stacked head and exercise map/wiki plus
   existing task/conversation typing, import/link picker, history/citations and
   layout. Include fresh independent functional and visual assessment. Each child
   issue keeps its 3–5 testable criteria; #228 remains open until both outcomes and
   integrated evidence pass. Retarget after dependencies merge and rerun relevant checks.

No implementation needs a merge before starting its isolated stack. The genuine
shared agreement with #155 is narrow: editing owns map/wiki room presence; #155 owns
conversation/task private-composer typing. They use distinct frames/resource bindings,
do not substitute for each other, and must agree on upgrade dispatch, session/revocation
lifetime and reconnect queue limits if both touch the composition root. #153 agent
scheduling is not a prerequisite. Neither old UI import nor an unavailable peer allows
lowering #228's current requirements.

Open verification uncertainties: stable package compatibility/license notices,
malformed CRDT validation cost and checkpoint size under long histories, cross-process
lease/delivery ordering, CodeMirror mobile/IME/undo behavior, and actual persistence
plus safe-preview latency at 100k text. These are concrete calibration/test tasks;
none is already proved by the cited documentation or source inspection.


### Current disabled integration bounds — 2026-10-04

All editing HTTP, wiki and map output/context reservations use one API-wide 32 MiB
budget. Parsed wiki contexts retain the 512-visit/64 KiB ceiling; a closed map
command of up to 200 positions uses at most 4096 visits and 256 KiB conservatively
charged context, plus its separately charged at-most-64 KiB input frame. This does
not increase the common cap. Finite FIFO admission retains charged input before
SQL or hashing, rejects on timeout/close, and has no uncharged continuation queue.
An empty bootstrap waiter has no encoded input yet: its queued codec lease charges
actual retained backing/copy allowance and its continuation stays in the common
context budget. The validated future encoding ceiling is immutable budget-owned
metadata. Promotion atomically adds that future input/copy allowance and the full
state/result reservation before admission resolves to any SQL/body read or input
allocation. A failed promotion changes no lease or byte total; ordinary retained
input and direct cold reservations keep their existing charge semantics. This
bounded future-capacity clarification addresses an actual healthy 100k read refusal
at `cdbf4a57`; the caps, FIFO, slots and deadlines stay unchanged and its repair
still requires independent source and runtime checks.
Each protected authority callback emits at most one frame; received-frame ACKs do
not themselves send the next frame. Public ws-owned frame copies remain charged
through their actual send callbacks after close or revocation. Rolled-back live
errors carry scalar outcome/code only; current protected postimages require a new
held-fence read. These are source integration choices, awaiting current-head
runtime and independent evaluation; they do not close any remaining gate.

### Map persistence integration seam (2026-10-04, implementation pending verification)

The development composition shares `apiEditingOutputBudget` across wiki/map
controllers, live HTTP, and native map HTTP/MCP journals. The existing common
32 MiB cap and frame/chunk/assembly/window bounds remain in force. Native map
HTTP owns its preparation before session/SQL admission; journal adapters reuse
that reservation. MCP retains its native journal reservation through the outer
caller transaction. A native replay still uses the immutable original actor/UUID
and parameters, and reprojects placed-object titles under current locked rights
before HTTP handoff. The client confirms graph state exclusively from ordered
server deltas; HTTP replay does not patch an old graph snapshot.

Migration `0047_live_maps.sql` is reserved in
[the issue record](https://github.com/ColdPhase/flux/issues/228#issuecomment-5975059152).
One atomic join reads the native snapshot with generation/sequence. Native CAS
writes, immutable journal, retained thought versions/link epochs, cleared gesture
leases, original intent receipt and identifier-only NOTIFY commit together;
ordinary identifier events are flushed after native/coordination writes. Separate
API replicas re-read the journal immediately on transactional NOTIFY; periodic
catch-up is recovery only. Each protected callback hands off at most one frame.

The source bounds each room to 32 expiring gestures and 32 presence leases,
and each category to 2048 across the database. A producer reaches a truthful
capacity refusal before admitting a snapshot every reader cannot represent.
A gesture retains at most 200 closed thought CAS records/positions; presence
names at most 16 selections. TTL is at most five seconds and the current SQL
session expiry. First authorized movement/cancel binds the HTTP-issued lease to
the server-generated socket connection, preserving actor/session/room/generation.
Input retains at most 4096 parsed visits/262144 bytes plus its separately charged
65536-byte raw frame; wiki metadata retains its earlier smaller bound. Native
snapshot/affected-link counts and serialized SQL sizes are checked before
allocating graph rows. Required normal 500-thought/200-movement behavior and
capacity boundary tests are pending; these limits do not establish latency proof.

Own undo names 1–200 original command UUIDs from this frontend instance. The
server verifies author, immutable namespace, generation, original poststates,
retained absences and complete dependent-link epochs. It dry-runs inverses in
reverse journal order before any mutation, then applies one atomic native change
with increasing versions/epochs, one receipt and one ordered delta. Any peer
change or delete/restore ABA refuses the entire step; there is no latest-state
rebase. Exact original inverse UUID retry reads its stored receipt. Journal input
is counted and size-checked before SQL result allocation; the complete preparation
remains under the shared reservation. Required rollback/retry/conflict/ABA cases
and actual reader/drag/full-path two-API measurements remain unverified.
