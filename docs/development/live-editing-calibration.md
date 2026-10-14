# Bounded live-editing calibration — #231

Prepared 2026-10-03. Source baseline: `583acb1a7a69afff27ad9484343ca92316348471`,
branch `codex-hubert/231-live-transport-codec`. This composes the combined map head
`13fd739cb1958a92bc52f83490d284956ffe09fa` and ready contract PR
[#230](https://github.com/ColdPhase/flux/pull/230). The single implementation owner
is PelikanFix16; the source author cannot provide final independent evaluation.

[F-021](../product/decisions.md) requires movement during drag and actual shared wiki
characters/named writers while typing. This standalone fixture prepares
[#231](https://github.com/ColdPhase/flux/issues/231), not the completed
[#228](https://github.com/ColdPhase/flux/issues/228) feature. Its
[accepted contract](live-editing-proposal.md#four-finite-non-production-calibration-gates)
admits disabled calibration only. No route, migration, application dependency or
default Docker service imports this directory. Full application integration follows
the finite codec proof; all four gates and independent assessment remain required.

## Stage status and finite sequence

**Partial source checkpoint; production disabled.** The granted isolated inventory
passed on Node 24.21.0. The first author matrix passed 19/19 in 8.355 seconds; a
strengthened matrix passed 21/21 in 10.197 seconds, with no failed/skipped/cancelled
cases. Raw results and exact fixture/runner hashes are retained in the evidence
directory below. On frozen `b439b29c306d997c72ee9b8a45c0f9d940329986`, the author
matrix subsequently passed 23/23 in 10.374 seconds. The independent ten-case probe
passed six cases and demonstrated four failures: a legitimate public surrogate-split
checkpoint, unbounded intent-registry retention before worker admission, stranded
exact assembly retry after copy pressure, and incomplete chunk intent binding.
Those failures stop production enablement. The original failing source remains
unchanged as a negative control in the #231 worktree.
Shell syntax, tracked whitespace and foundation link/setup checks passed; none of
these substitutes for current-source codec, application or independent acceptance.

The 2026-10-04 correction source is in the separate #228 worktree,
`codex-hubert/228-live-map-wiki`, based on
`6a387d0e60147a9f78bb15180c2126b87dca035d`. Its thirty-case author matrix is
**unverified** until a frozen source run. It retains original UTF-16 ledger text and
allows replacement halves only at graph cuts established by admitted novel edits;
negative controls still refuse unproved replacements and altered neighbouring text.
Registry waiters and actual worker jobs now share a reservation before hashing or
awaiting, with cancellation, close and finite waiting controls. Complete assemblies
retry an equal final chunk when copy capacity returns, and retain a deep-frozen
closed persistent envelope containing operation, replica and semantic parameters.
The independent pressure reproduction needs the newly mandatory valid operation
and replica fields only; its original pressure and completion assertion stay intact.

1. Prepare the standalone lock inside Docker. Record its exact resolved dependency
   versions/integrities and source license hashes before the first codec test.
2. Build the isolated image and retain its runtime/dependency inventory. Unexpected
   licenses, a second Yjs instance or missing source license abort before tests.
3. Execute the finite codec matrix once; retain complete TAP, source hashes, head,
   inventory, image ID, limits and actual durations. Repair demonstrated failures
   and rerun only affected evidence. No hidden successful-only sample is retained.
4. Continue #231 AC-2 using the actual application single upgrade dispatcher, with
   media enabled/disabled, initial frames, session/Origin refusal and shutdown.
   Existing stream `maxPayload: 1024` stays intact; a substituted media upstream
   proves dispatch only. The assembly utility here is **not** this transport proof.
5. Carry the same source author directly into #228 SQL authority/persistence and
   actual editor/live-reader/map interaction gates. Preserve measured full-path
   p95 ≤200 ms and movement-before-drop / typing-before-Save. Standalone worker
   durations and an EditorState construction are not those UI/performance results.

Failure to prove the public decoder, complete graph guard, compatible editor updates
or fresh-ID enrollment stops Yjs production. The strict bounded OT alternative
requires a newly independently accepted contract and identical live outcome/latency
gates; passing only ordinary edits cannot waive a negative control.

## Pinned candidates and primary evidence

Official registry metadata and source archives were read on 2026-10-03 with the host
standard library; nothing was installed. These are observed archive/package facts.

| Package | Exact pin | Source license | Archive LICENSE SHA-256 |
| --- | --- | --- | --- |
| [yjs](https://registry.npmjs.org/yjs/13.6.33) | 13.6.33 | MIT | `341baa53605ed85d6f95782322854cca56c655ebc7fd4712649b8e7afc6020ff` |
| [y-codemirror.next](https://registry.npmjs.org/y-codemirror.next/0.3.6) | 0.3.6 | MIT | `005143d73a1ddc93bfa434bde58f538f49bced8f0cae42daf7d577ca0a504e1f` |
| [@codemirror/state](https://registry.npmjs.org/@codemirror%2fstate/6.7.6) | 6.7.6 | MIT | `05c6130cda97e7600ca91427a41e8a065efcf82365fc0293e7de80faec494c07` |
| [@codemirror/view](https://registry.npmjs.org/@codemirror%2fview/6.43.13) | 6.43.13 | MIT | same CodeMirror license hash |
| [y-protocols](https://registry.npmjs.org/y-protocols/1.0.7) | 1.0.7 | MIT | `5446db1e43fe52faf3faab7e9959fe3762ac11bdc61c0945934c498affd52d73` |
| [lib0](https://registry.npmjs.org/lib0/0.2.119) | 0.2.119 | MIT | same lib0/y-protocols license hash |
| [ws](https://registry.npmjs.org/ws/8.22.0) | 8.22.0 | MIT | `2b29dcfe0d6471f7e8c92c5fb38c9f93edee10330937055440192f1832b1ecef` |

Observed binding peers accept Yjs `^13.5.6` and CodeMirror state/view `^6.0.0`;
the selected CodeMirror view requires state `^6.7.0`. Overrides force one exact
instance. Semver compatibility is an inference, not runtime editor/IME proof.
Transitive pins and integrity values will be frozen in the standalone lock before
execution and listed by `inventory.mjs`; no permissive install runs during tests.

The repository's unchanged Node base is
`node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`,
with pnpm 12.6.0. The later application transport/SQL/UI stages retain the repository
Fastify 5.6.1, ws 8.22.0, Playwright 1.63.0 and pinned PostgreSQL/browser images;
their actual running versions/environment must be recorded in those stages.

[Public Y.Doc API](https://docs.yjs.dev/api/y.doc) marks `clientID` readonly and
requires a different ID for a new session. Each fixture creates a fresh Doc, reads
its generated ID and records actor/workspace/kind/resource/generation ownership
**before local structs**. It never assigns clientID. Same-Doc reconnect retains the
ID; a new instance can present old exact pending bytes under retained old ownership
and current authority, without adopting that old ID or claiming a pre-crash receipt.

Observed pinned [public exports](https://github.com/yjs/yjs/blob/v13.6.33/src/index.js)
include Item/ID/content constructors and V1 encoders/decoders.
[decodeUpdateV2](https://github.com/yjs/yjs/blob/v13.6.33/src/utils/updates.js)
accepts an exported decoder constructor. A subclass captures its public constructor
input and [lib0 decoding](https://github.com/dmonad/lib0/blob/v0.2.119/decoding.js)
checks remaining bytes; no Doc store/share, receiver internals or underscore field
is read. Adversarial encodings use exported encoder methods and Item.write only.
This observed mechanism still requires the independent codec execution/review.

## Guard, storage and allocation accounting

Before applying bytes, a separate immutable interval ledger proves root, parent,
origin/right-origin, ownership, contiguous clocks, duplicate original text/graph,
and complete delete-range coverage. New GC/Skip/tombstone intervals are refused
when original graph/content cannot be established; already proven deleted duplicates
can be checked against the retained original ledger. Unresolved dependencies never
enter a confirmed pending store. Only then does a disposable bounded worker apply
the complete candidate/checkpoint and compare state vectors and plain body shape.

Receipt keys include workspace, kind, resource, generation, actor, operation and
UUID. The immutable fingerprint includes replica, exact bytes and all semantic
parameters. Save-parameter hashing here is a helper test: definite ROLLBACK,
uncertain COMMIT reconciliation, historical projections and actual Save/native/
MCP/section fences remain gate 3, using the accepted contract unchanged.

The independent preflight identified false attribution for already-known structs/
ranges and absence of actor/UUID binding across valid rooms. The subsequent source
adds explicit receipt-only semantic no-ops (no sequence, journal or original
provenance change), tracks only newly deleted subranges, and a shared actor/UUID
intent-registry model. Its serialized in-memory boundary is **not** a proof that
room/intent writes commit atomically, survive restart, use the prescribed access/
intent/material/live locks, or reconcile uncertain SQL COMMIT. Those remain gate 3.
The original frozen model failed the independent pre-worker retention control. The
correction reserves input, transferable copy, charged state and maximum result in
the same budget used by the actual pool before immutable intent hashing/queueing.
Borrowed byte mutation is checked before dispatch and before result publication.
The corrected `7c5e447f` checkpoint passed 30 author cases and 10 independent probes
in the root's isolated Docker runs. A later independent source review found that a
small typed-array view still retained its full, previously uncharged backing store.
The next source refinement reserves the entire backing capacity (maximum capacity
for resizable/growable stores) plus the transferable view copy, and refuses a backing
larger than 8 MiB before hashing/queueing. Its new positive accounting and oversized/
growable refusal cases are **unexecuted**; the earlier PASS is historical evidence,
not a claim that the new resource boundary has passed review.

| Candidate limit | Value / accounting |
| --- | --- |
| Frames/chunks | 65,536 total bytes / 61,440 payload bytes; bounded metadata |
| Assembly | one per connection; four / 32 MiB per process; ≤144 chunks, 8 MiB, 10-second expiry; reordered exact duplicates allowed, altered/scope/count changes refused |
| Assembly completion | charge original chunks plus contiguous result before allocation; refuse if that copy would exceed the shared 32 MiB assembly budget |
| Workers | two; 64 MiB JS heap candidate partitioned 48 MiB old + 16 MiB young; explicit 16 MiB code range / 2 MiB stack; verify public worker-reported values; terminate after 100 ms task deadline; separate **2,000 ms finite bootstrap** deadline |
| Jobs | ≤8 waiting; reserve complete retained input backing capacity + transferable view copy + charged checkpoint/ledger + full 8 MiB result copy **before queueing**; input backing ≤8 MiB; 32 MiB aggregate; the external limit can refuse before the count limit |
| Serialized intent admission | shares that job budget; proposed 3,000 ms finite waiting deadline, current cancellation and close rejection; no per-room promise tail outside the reservation |
| Graph decode | ≤65,536 decoded/retained structs and ≤65,536 delete ranges; larger headers remain constrained by worker heap/deadline |
| Confirmed room cache | ≤8 MiB charged state, including original deleted text, body/checkpoint strings, receipts, enrollment and explicit object headroom; 16 rooms / 128 MiB aggregate |
| Body and runner | ≤100,000 JS code units; test container 512 MiB RAM/swap ceiling, two CPUs, 64 PIDs, read-only filesystem, no network; 90-second node / 120-second outer test deadline |

The 2-second bootstrap, structural counts and 8 MiB complete room-charge ceiling are
explicit fixture refinements proposed for review before execution. `stateCharge`
charges worst UTF-16 serialized strings plus 512 bytes/node, 128/delete/enrollment
and 256/receipt object headroom. This is conservative accounting, not a claim that
V8 RSS equals that number: the hard process/container limits cover allocation
overhead, buffers and failure. Cache-only compaction cannot discard provenance or
original duplicate evidence to pass; hitting a limit preserves pending text privately
and refuses honestly. Durable SQL compaction/restart and its continuing compatibility
need gate 3. Input fixtures run separately from the service and are not capacity claims.

The [Node 24.21 Worker API](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)
documents separate old/young/code/stack limits, excludes external ArrayBuffers and
can terminate a worker when JS limits are reached. These are documentation claims;
the fixture checks reported values and explicit timeout/bootstrap/exit controls.
They do not establish a process RSS guarantee or replace external/copy accounting.

## Commands and expected serial slot

After the root's explicit serial grant, from this worktree:

```sh
FLUX_LIVE_CALIBRATION_GRANTED=231 ./scripts/prepare_live_editing_calibration.sh
FLUX_LIVE_CALIBRATION_GRANTED=231 ./scripts/check_live_editing_calibration.sh inventory
FLUX_LIVE_CALIBRATION_GRANTED=231 ./scripts/check_live_editing_calibration.sh codec
```

Lock preparation: hard 180 seconds plus ten-second termination grace. Each build:
hard 300 seconds plus grace; cached follow-up should be short. Inventory: 30 seconds.
Codec: 120 seconds maximum, expected below 60 seconds with the finite case matrix.
Run only one serial slot, stop on any failed/unknown result, and retain
`/tmp/flux-231-codec` raw evidence. No ports, database, browser or media containers
are started in this first stage; no other project's containers/images are removed.

Source author hands recorded results and all source changes to the root for
commit/push and fresh independent assessment. Neither the source author nor this
preparation document changes protected GitHub gates or marks #228 finished.

## Frozen checkpoint handoff and remaining findings

Actual retained artifact directory:
`docs/development/evidence/live-editing/2026-10-03-codec/`.
The lock has all twelve dependency versions/integrities; inventories include every
source license hash. The first lock run exposed ignored package.json overrides:
[pnpm's supported workspace settings](https://pnpm.io/settings) fixed that before
testing. First inventory stopped on generated lock mode0600; mode0644 fixed the
unprivileged image read. Both failed preparations and successful raw runs are recorded.

The corrected #228 source remains a draft with these independent findings pending:

- Prove semantic no-op receipts and shared valid-room intent binding on the frozen
  corrected source, including absence of new provenance and namespace-changing retry.
- Re-execute the exact assembly backpressure/retry negative control and semantic
  header controls against the correction; preserve the original failing raw result.
- Prove the public Yjs UTF-16 surrogate-split checkpoint behavior without weakening
  original duplicate content/ownership checks or using private fields.
- Independently assess job/registry/assembly allocation and bounded wait accounting.
- #231 AC-2 actual application upgrade dispatcher and all #228 SQL/UI gates remain.

The correction checkpoint is handed to the root for commit/push and independent
probe. Earlier passes apply to their recorded source hashes, **not** the subsequent
untested changes. The next finite codec run uses a separate evidence directory,
`/tmp/flux-228-codec-corrections`; it preserves all historical negative observations.
No readiness, merge or complete-live-feature claim follows. The same implementation
owner continues the actual application dispatcher, SQL authority, editor/live-reader
and map integration; calibration alone cannot complete #228.
