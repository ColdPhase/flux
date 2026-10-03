# Live-editing native persistence checkpoint — #228

Prepared 2026-10-04 after transport/retained-backing source correction `b9581a5`.
This is source prepared for finite Docker verification, **not runtime acceptance**.
The [accepted outcome and all four gates](live-editing-proposal.md) remain required;
the actual room controller, two-process authority/receipt/restart proof, frontend
integration and measured p95 ≤200 ms remain unfinished.

Migration 0046 adds shared doc heads, retired generations, immutable admitted updates,
durable replica ownership, saved contributor intervals and actor/command intent bindings.
Replica ownership explicitly distinguishes a real authenticated human from the
server's once-only native-text initialization; initialization never impersonates
a person or becomes a contributing human update. The kind/actor/instance tuple is immutable.
It initializes no room and backfills no saved text, events or source projections.
The local queue already uses 0042 for provider connections, 0044 for project policy
and 0045 for stored files; the root records this next free reservation on the issue
before checkpoint. The frozen peer #170 c5f81391 migration inventory ends at 0041.
The database checks safe sequences, hashes, saved-version scope and bounded 8 MiB JSON
codec storage; application validation must additionally enforce 100,000 UTF-16 code
units. Database `char_length` is only a backstop. The encoded-state storage ceiling
is a fail-closed candidate that must be measured alongside the existing complete
checkpoint/ledger charge; a larger serialization is refused, never truncated.
Retired codec JSON, contributor intervals and original receipt JSON also have an
8 MiB storage backstop. These checks do not prove bounded query/result allocations;
the actual room controller must reserve jobs/state before asynchronous processing.

The [shared DTO seam](../../app/packages/contracts/src/editing.ts) defines separate
live bootstrap/enrollment/Save/receipt paths and one editing socket. Map bootstrap
contains its native snapshot and revision atomically; committed deltas contain
authorized postimages, tombstones, command identity and cleared lease IDs, using
bounded chunks for large deltas. Native GET is only bootstrap/resync. The candidate
instance lease lasts 30 seconds with 10-second renewal; movement/cursor presence
expires after 5 seconds, with current-authorized movement renewing the gesture.
The root's acceptance of this seam retains all existing authority/latency gates.

Prepared application pins match the calibrated MIT dependencies: Yjs 13.6.33,
y-codemirror.next 0.3.6, CodeMirror state 6.7.6/view 6.43.13, y-protocols 1.0.7,
server public decoder lib0 0.2.119. The workspace pins one Yjs version through
[pnpm's public overrides configuration](https://pnpm.io/settings#overrides), read
2026-10-04. Package manifests are prepared; the application lock is deliberately
pending a root-authorized finite Docker install. No host installation was performed.

The mandatory shared-core native fence locks the live head after current policy and
material locks. HTTP `updateDoc` and `addSection`, including no-op and metadata-only
commands, and the same `nativeDocsInEventSession` used by OAuth/MCP standing grants
all refuse dirty shared text before version/source-link/mention/event mutations.
A clean native change archives the exact old head and starts a new generation in the
same transaction; original ownership and receipts remain retained. A no-op native
change leaves the generation unchanged.

Explicit shared Save accepts an acknowledged generation/sequence/hash and reads the
body from that locked head. It appends an immutable saved version, records the saver
and distinct journal contributors since the previous saved interval, updates saved
mentions and records one existing project event. It advances only the saved binding;
the CRDT checkpoint/generation remains intact. Ordinary/current/version/material/
search source readers continue returning saved text. No keystroke, cursor or unsaved
preview becomes an event, saved quote, mention/backlink or source projection.

Prepared finite cases:

- `tests/app/live-doc-native-fence.test.ts`: real HTTP body/no-op/metadata/section
  refusals; exact-head Save with two named contributors and immutable history;
  definite pre-COMMIT failure rolls all prepared effects back; clean legacy rebind
  preserves original ownership/receipts; actual OAuth/MCP standing-grant refusal
  makes no effect/debit. Its installed fixture head isolates this native boundary
  and does **not** establish successful real codec admission.
- `tests/app/live-editing-migration.test.ts`: upgrade from the prior actual sparse
  manifest, unchanged saved rows/search, no room backfill, immutable receipt/replica/
  journal/snapshot guards and rerun retention. Runtime is unexecuted.

The next controller must persist the update, complete codec state and global immutable
intent/result atomically, distinguish definite rollback from uncertain COMMIT, and
resolve the original receipt under the same authorized resource boundary. No current
source test proves those requirements or current-rights delivery under revocation.
