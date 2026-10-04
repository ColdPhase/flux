# Independent revised technical contract assessment — Flux #228

Date: 2026-10-03.
Reviewed file: /home/hubert/Develop/flux/.worktrees/228-live-collaboration/docs/development/live-editing-proposal.md.
SHA-256: **1366410fea8a2d020274ee75febad6ac86cef459dcb3ae3d3ad66e5063b9ce38**.
Repository source baseline: 085214c6c58e265d1d19b2c56a12368a370ed24f.
Earlier inputs: /tmp/flux228-contract-review.md and /tmp/flux228-proposal-revision.md.

Decision: **Accepted for bounded, isolated, disabled non-production calibration.** C1–C4 and the two follow-up wording corrections are resolved in the reviewed hash. There are no remaining blocking technical-contract findings. This accepts the architecture, candidate caps and four-gate method for producing evidence; it does not accept an implementation, prove runtime behavior, or authorize production enablement, merge, performance claims or release acceptance.

## Resolution evidence

**C1 — supported enrollment, identity, replay and recovery:** lines 231–245 enroll a fresh generated Y.Doc clientID before local structs/editable binding, reject collisions atomically, retain durable actor/resource/generation ownership, and distinguish surviving-instance network reconnect from a new browser instance. They forbid assigning/reusing readonly clientID, consistent with [the public Y.Doc API](https://docs.yjs.dev/api/y.doc). Recovery initialization is excluded from the new own-undo stack, and prior-session undo is honestly unavailable.

Lines 246–260 now distinguish stored-receipt/stored-intent exact fingerprint replay from first admission of previously unseen recovered bytes. The latter requires current write authorization, original allowed generation/enrollment, full candidate/dependency validation and serialization/CAS. The server expressly cannot prove pre-crash creation time or original byte identity without a stored record. Client byte preservation remains a protocol requirement rather than a falsely claimed server proof.

Lines 287–305 define complete immutable receipt namespace, actor/UUID intent binding, server-computed SHA-256/length and persistent envelope, full native/Save parameters and CAS fingerprints, original result retention and typed altered-retry conflicts. Transport-only IDs/tokens can change without changing intent. Current authority applies to receipt/result disclosure; automatic pending recovery additionally requires current write authorization. Compaction cannot silently free identity or old replica clocks.

**C2 — unbiased continuous sampling and cadence:** the fixed 250 ms schedule continues under continuous trusted input. Replaceable-state coverage is tied to interaction/generation; committed text/commands require proof of inclusion. Every scheduled row remains, including superseded-covered samples, fixed 1,000 ms timeouts, errors and overload. Failure samples count as +infinity, and a healthy pass requires p95 ≤200 ms plus zero timeout/error/overload. This avoids successful-only or coalescing bias.

Changing cursor/selection activity uses the 40 ms batch window independently of the one-second unchanged-presence heartbeat. Fixtures preserve the 100,000-code-unit body limit through replacements/delete-then-insert plus separate over-limit rejection/recovery. Total 50/500-thought map size is distinct from the 200-thought atomic move limit. The single monotonic driver/two-rAF method is explicitly a conservative DOM/render opportunity observation, not physical pixel proof. Before-pointerup / before-Save and the 200 ms target remain unchanged.

**C3 — authority, fences and uncertain COMMIT:** lines 268–282 require access-before-material-before-live-head locks, commit-only ACK, definite rollback distinction, and reconciliation at the original serialization boundary after an uncertain transaction ends. A found immutable receipt establishes the original result; absence permits exact retry only under that boundary; unavailable locking preserves unknown state. No confirmed reset or false “never shared” claim is permitted; Save waits for unresolved outcomes.

The shared-core external-writer fence precedes no-op/source-link/mention/material effects and inventories HTTP updateDoc/addSection, MCP nativeDocsInEventSession and projection/jobs. Generic material updates retain USE_DOC_API. Dirty live work fences native/metadata writers; clean legacy writes advance generation atomically.

Lines 98–111 define shared PostgreSQL delivery fences and synchronous transport handoff across API processes. Revocation conflicts with those fences; an unlocked send after recheck is insufficient. Application queues are discarded, with previously authorized bytes already handed to the transport accounted separately. Actual ordering is still a mandatory runtime proof.

**C4 — current combined source base:** lines 514–520 use combined #222 13fd739cb1958a92bc52f83490d284956ffe09fa directly and require rechecking the actual head before child claim. Read-only Git confirmed the commit exists and includes #223 e58b46bfc821e5d377df0b04b5a1449b9a660e9d. Obsolete stacking pins are removed.

**Actionable gate sequence:** lines 452–460 explicitly admit implementation/integration in an isolated, disabled development/calibration fixture to build and measure the real SQL, validator, safe-preview and widget path. Shortcuts do not count. Production enablement, merge and live-feature acceptance wait for all four gates and independent assessment. This removes the earlier circular wording without lowering the outcome or claiming acceptance of the fixture code.

## Accepted calibration prerequisites

Pin exact compatible stable Yjs/binding/ws/runtime/DB/browser dependencies, the fixture head and environment before execution; preserve one Yjs instance. The substantial Docker slot requires root's explicit serial grant. No gate has passed through this document assessment.

Candidate caps are accepted for calibration, not as deployment capacity promises: 64 KiB envelopes/60 KiB payload chunks; 2 KiB presence with at most 16 IDs or a lease reference; 200-thought moves; 40 ms batching; 1 MiB flow/output/pending windows; 8 MiB/144-chunk room sync; one assembly/connection and four/32 MiB concurrent assemblies; two 64 MiB workers with 100 ms task deadline and eight waiting tasks; 16 caches/128 MiB and 32 sockets per API. Encoded-byte, struct/delete-range and external-buffer accounting remain required. Adjusted fixture caps require recorded review before the affected run; failed budgets do not relax the 200 ms or live-interaction requirements.

All four finite gates remain mandatory:

1. Actual single-dispatch transport with media on/off, immediate first frames, editing limits, preserved stream maxPayload 1024, pre-upgrade authority and shutdown.
2. Public stable codec and replica proof, complete structural/dependency validation, hostile/unresolved updates, stored-receipt retry and unseen offline first admission, ownership/restart/compaction and bounds.
3. Two-process PostgreSQL authority/persistence races, writer inventory, Save provenance, exact/altered retries, definite rollback versus uncertain COMMIT, missed wakeups and revocation.
4. Actual-path map/wiki/editor/ordinary-live-reader interaction and continuous latency, named cursors, own undo, immutable history/citations, raw scheduled rows and recovery cases.

Failed public validation/enrollment stops the CRDT production path and requires fresh independent acceptance of the bounded OT alternative. Final functional, visual and integrated acceptance remains separate.

Checks performed: complete revision read, focused reread of root's final recovery/gate changes, previous primary API evidence reused, read-only combined-base existence/ancestry, and final hash/status verification. No Docker, application tests, application/source edits, Git mutations or GitHub writes were performed. Only this independent report was written.
