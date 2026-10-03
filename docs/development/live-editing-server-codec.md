# Live-editing server codec integration — #228

Source prepared 2026-10-04. No production route/controller is registered by this
slice. Its build, resource regressions, SQL behavior and full-path latency are
**unverified**. All [four accepted gates](live-editing-proposal.md) remain mandatory.

The production adapter stays in `apps/server/src/editing`, using narrow typed ports
and the pinned public Yjs/lib0 exports. Eight initial MJS copies were verified byte
for byte against `b9581a5` by the author using Python SHA-256; the historical initial
manifest is [live-editing-codec-copy.sha256](live-editing-codec-copy.sha256).
No private Yjs/receiver fields or clientID assignment is added. The public
[document update API](https://docs.yjs.dev/api/document-updates), read 2026-10-04,
documents extracting state vectors from encoded updates; this is documentation
evidence, not a runtime claim for the new adapter.

The graph, decoder, immutable envelope, worker and cache copies remain initially
identical. Production admission/assembly are now deliberately extended: a pending
job reserves maximum 8 MiB SQL state and 8 MiB result, complete retained input
backing and its transfer capacity **before any SQL/intent/hash await**. Binding a
current serialized state can only shrink the reservation; initialization reserves
its future encoded input before reading the native body. A second maximum cold
state with any input exceeds the unchanged 32 MiB budget and refuses. Healthy two
writers must still demonstrate zero overload and measured p95 ≤200 ms; this numeric
fact neither lowers that gate nor permits an uncharged waiting tail.

A completed assembly retains both its chunks and contiguous result in the original
bounded assembly budget while common job capacity is unavailable. Exact retries
reuse that result. Only successful admission transfers ownership into the job lease;
Parts and completion use exact backing stores, avoiding pooled tiny buffers that
would retain a larger slab than their charged logical length.
expiry, closed connections and shutdown release the assembly. Capacity callbacks
must remain bounded and closed-controller aware. The future controller must prove
those actual paths rather than infer them from these primitives.

The current production hashes live in `apps/server/src/editing/codec/source.sha256`
and are checked by `tests/app/editing-codec-source.test.ts`. The frozen historical
calibration modules remain unchanged. The temporary copy is a recorded integration
step: move calibrated regressions to the single production canonical modules after
fresh independent assessment; do not let parallel validator implementations drift.
No `IntentRegistry` model is copied. PostgreSQL owns durable actor/UUID namespace,
payload fingerprint, atomic result and uncertain-COMMIT receipt reconciliation.

The server initializes only a bounded already-saved native body, using a fresh
server-owned generated replica and worker validation, with baseline sequence zero.
Its explicit server replica never impersonates a human contributor. New clients
still enroll before local structs. The worker result/lease stays held until the real
transaction establishes an outcome; ACK is after commit and protected fanout has
its own current authority fence.

Three prepared deferred-admission regressions cover oversized retained input before
the representative asynchronous boundary, full cold-state accounting/shrink, bounded
initialization replacement and completed-assembly wait/retry/expiry ownership.
They are not yet executed and do not replace actual controller/API/SQL falsification.

The first production build/type check passed at c09ab51; lint then exposed an explicit Node URL import missing in both worker-pool copies. Their correction imports the public `node:url` URL class without changing pool behavior. The current source manifest reflects that import-only difference from the historical first-copy hashes. Runtime cases were not reached in that run.
