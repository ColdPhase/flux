# Live editing receipt reconciliation and real process restart

These are prepared Gate3 fixtures for #228/#239. They do not enable production or
establish any of the four gates without candidate-pinned actual execution.

`tests/app/live-wiki-reconciliation.test.ts` uses real PostgreSQL and the production
wiki authority/codec/storage. Its explicitly labelled public query interposition
waits for the real `COMMIT` to succeed, then loses only that response. The submit
must return outcome unknown without an ACK, discard the backend, and leave one
real journal entry plus the immutable original receipt. A reconstructed controller
reads that receipt under current authority; byte-identical original UUID retries
create no new contribution or project/notification/AI event. A changed payload
under that UUID refuses409; current session revocation still refuses receipt
access. Controller reconstruction is not claimed as a process restart.

`tests/app/live/restart.ts prepare|verify` runs public HTTP/WebSocket clients
against two actually inventoried API containers. Preparation uses real signup,
current cookies, fresh public Y.Doc enrollment before local structures, and a
sealed update. It pauses only the public ws8.22 receive side before the new intent;
read-only SQL observes its committed receipt while the client has observed no ACK.
The pending immutable bytes/UUID and synthetic cookies are retained in a bounded
0600 private fixture file. No authentication/policy/SQL writer is substituted.

Root then force-recreates **both** API containers at the same candidate image and
captures a separate after-restart process inventory. Verification requires changed
actual container IDs on both services, preserved source/image/origin, a valid
original session, confirmed text/generation, and exact old-replica receipt replay
from a newly enrolled fresh Y.Doc. Explicit Save preserves version1/history and
its own exact retry. The map's durable move and monotonic versions survive; its
original server-journal ownUndo/retry and an old native HTTP retry create no
resurrection or duplicate sequence. The script's read-only SQL observes durability;
all application writes use actual public routes/sockets.

Use source- and actual-process-pinned inventories with the same shape described in
[live-editing-two-api.md](live-editing-two-api.md). Select
`FLUX_LIVE_RESTART_TEST=1`, exact `FLUX_LIVE_SOURCE_SHA`, the actual canonical
`FLUX_PUBLIC_ORIGIN`, isolated database URL, and
`FLUX_LIVE_RESTART_INVENTORY=/evidence/restart-before.json` for prepare or
`/evidence/restart-after.json` for verify. The writable
`FLUX_LIVE_RESTART_STATE_DIR` defaults to the isolated `/state` volume. Each phase
has a finite30s deadline and each delivery/durable observation5s; verification
must happen within120s of prepare. Root owns container recreation and exact-project
cleanup; the test has no Docker socket or container-control capability.

Run restart **before** the fresh latency API inventory/collector. Before/after
restart records are functional-test evidence only, not the measurement's expected
producer inventory. After verify, capture fresh API IDs/StartedAt, begin the queue
collector, and then run the source-pinned browser/latency cohort. Never combine
old and new process initial records under one measurement instance.

The public [ws8.22 documentation](https://raw.githubusercontent.com/websockets/ws/8.22.0/doc/ws.md)
(accessed2026-10-04) supports pause/resume. Already buffered old frames may still
arrive; the prepared fixture specifically asserts the brand-new intent's ACK was
not observed. The script makes no unclean-crash, packet-loss, uncertain-COMMIT
transport, offline-browser or healthy p95≤200ms claim. Those outcomes and actual
independent evaluation remain required separately. Neither prepared source nor
a functional restart PASS can replace full Gate4 fixed-denominator DOM evidence.
