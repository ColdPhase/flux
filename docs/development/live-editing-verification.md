# Live editing verification evidence

This is the local evidence protocol for the accepted [live editing proposal](live-editing-proposal.md), especially its four gates and latency measurement contract. It adds no feature enablement, public telemetry endpoint or lower acceptance threshold. A driver, producer or collector source change needs a new candidate pin and relevant checks. The earlier `8444a8b506b3600762666d634f37a8132bcfcf96` driver (SHA-256 `353d391cfcfb4b9ffd87cfc7a94777aa575b5b8717906655693a84d61f6857df`) is historical, unverified evidence; its startup descriptor cannot certify a later collector flush.

The driver implementation lives in `app/tests/ui/live_editing_latency.py`. The producer and external collector must implement the lifecycle below before this driver can report complete queue evidence. This document does not claim their implementation, graceful shutdown, browser behavior or latency has passed. Full live editing stays unavailable by default until all four gates pass on the coherent candidate.

## Candidate and environment preflight

Use an isolated stack, fresh project name, database/files volumes and fixture credentials. Build both application and `ui-test` images from the exact frozen candidate; browser tests are baked into the image. Run application, dependency inspection and tests in Docker under [the container contract](containers.md). Preserve the app's ordinary origin, session, authorization and rate checks. The whole-issue candidate uses the production `FLUX_LIVE_EDITING` control (normal default on, explicit off); production merge still waits for all original gates and independent acceptance. `FLUX_DEVELOPMENT_LIVE_EDITING=true` is only the isolated diagnostic marker, not production authority. `FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY=1` additionally requires both enabled editing and that marker; it supplies bounded local stdout observations, not a public API. Original evidence keeps its source pin.

Before starting browser measurements, the runner must:

1. Create a fresh evidence directory shared with the driver and collector. There must be no previous `planned.json`, `summary.json`, `*-rows.json`, `measurement-finished.json` or `queue-seal.json`. Start collection early enough to retain every API producer's initial record.
2. Inventory **every expected measured API instance** from the actual running Docker setup. Give each a unique, nonsecret ID matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Inventory has 1–32 IDs, in stable order. Deriving it from observed telemetry would hide an entirely missing producer. Gate 4 records the actual one/two-instance setup; Gate 3 still requires its separate two-process proof.
3. Inspect the actual environment, dependency pins and image/source contents. Write sanitized `runtime.json`, then compare the baked driver's SHA-256 and candidate source SHA. Do not collect full environment variables, authorization headers, cookies, connection strings or keys.
4. Start a finite collector which retains only the agreed primitive telemetry records as strict UTF-8 JSON lines in `actual-queue.jsonl`. Keep non-telemetry diagnostic logs separately, sanitized. A collector truncation, malformed record, loss or producer stdout backpressure makes evidence incomplete.

The runner-owned reproducible collector path is `scripts/collect_live_editing_queue.py`. Its reviewed source import and execution are separate required work; this recipe remains unverified until the coherent candidate contains it and passes its checks. The runner inventory JSON is a closed object with exactly `schema: 1`, `source_sha`, `driver_sha256`, `api_instances`, and `containers`, where the containers object maps every expected API ID to its actual full Docker container ID. Verify the actual running container's identity and configuration, including `FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE` and `FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY`, without logging unrelated environment values. The inventory and runtime descriptor use identical source/driver pins and expected-ID order.

Run the collector as a yielded foreground process under the runner's cleanup trap:

```sh
python3 scripts/collect_live_editing_queue.py \
  "$evidence_directory" "$inventory_json" --timeout 1200
```

Observe its source/inventory-bound `collector-ready.json` before starting the driver. Retain only the strict JSON suffix of lines beginning with `FLUX_LIVE_QUEUE `; the raw file does not include that prefix or unrelated application stdout. The collector's total deadline is finite and separate from the driver's 15-second post-marker wait. On a validated finish marker, the coordinator asks Docker to stop all inventoried producers with an eight-second graceful stop budget (`docker stop --time 8`), keeps reading their stdout, and waits for **each** log process's EOF and process settlement before sealing. A forced stop, missing final or unsettled process is incomplete; Docker stop success alone cannot certify drain. Tool orchestration launches the long run in a yielded session and checks progress with waits of at most 60 seconds.

The runtime metadata is a closed object with exactly these fields:

| Field | Actual value required |
| --- | --- |
| `source_sha` | Exact lowercase 40-hex frozen source commit; equals `FLUX_LIVE_SOURCE_SHA`. |
| `driver_sha256` | Exact SHA-256 of the driver baked into the measured UI image. |
| `collected_at` | Actual collection timestamp, bounded string of 1–64 characters. |
| `hardware` | Exactly `cpu` (observed CPU description, 1–512 characters), `logical_cores` and `memory_bytes` (observed positive integers). |
| `os` | Exactly `host` and `container`, each an actual bounded OS description. |
| `docker_limits` | 1–32 actual service entries, bounded nonsecret names. Each has exactly `image`, `cpus`, `memory_bytes`, `pids_limit`. Image is the actual measured image/tag/digest description. Limits are observed positive values, or the string `unset` only after inspecting the actual Docker configuration and finding no explicit limit. |
| `db` | Exactly actual `image` and database `version`. Inspect the running image and query the running database version through Docker. |
| `dependencies` | Bounded dependency-name/string-version entries, including `yjs`, `@codemirror/state`, `@codemirror/view`, `y-codemirror.next`, `ws`, and `pnpm_lock_sha256` (exact lowercase 64-hex lockfile hash). Inspect the measured image/lockfile, not an assumed host install. |
| `network` | Exactly `condition` and `setup`: actual healthy-local network arrangement, or the separately identified induced-loss/WAN setup. |
| `server_queue_evidence` | Exactly `path: "actual-queue.jsonl"`, `format: "jsonl"`, matching `source_sha`, bounded description `meaning`, `complete: false`, and the expected `api_instances` inventory. |

The OS/database/network strings are each 1–2048 characters. Hardware zero is not an observation substitute. Docker reports such as zero memory/NanoCPUs or an unlimited pids sentinel are converted to `unset` only when the inspected setting actually means unset; inspect other quota controls before deciding a CPU limit is absent. Missing observation is a failed preflight. The driver also records its actual container/cgroup, browser, viewport, visibility, DPR and zoom observations. Keep raw sanitized inspection outputs beside the metadata for independent checking. No example here fabricates hardware, queue or limit zeros.

After the runner has prepared that environment and started the collector, the driver invocation inside the `ui-test` image is:

```sh
FLUX_LIVE_EDITING_TEST=1 \
FLUX_LIVE_SOURCE_SHA="$candidate_sha" \
FLUX_LIVE_EVIDENCE=/evidence \
FLUX_LIVE_RUNTIME_METADATA=/evidence/runtime.json \
python3 tests/ui/live_editing_latency.py
```

Mount the fresh directory at `/evidence`; pass the candidate SHA explicitly through the runner's Docker/Compose invocation. The existing source Compose `ui-test` service uses its configured origin and API upstream. A complete run recipe also needs the collector/shutdown coordinator described below; running this command alone cannot produce a complete seal. Rebuild the UI image after changing the driver. Preserve the isolated stack cleanup trap and retain evidence when a check fails.

A failed preflight has not begun a measurement and cannot publish a valid inventory-bound finish marker. The runner must stop its preparation/collection through its failure cleanup path, preserving diagnostics; absence of a marker/seal never becomes a pass.

## Fixed measurement and retained artifacts

### Founder acceptance of measured latency (2026-10-18)

Hubert (@PelikanFix16) explicitly accepted the small overrun in the supervising
session: “jak wyjdziem ytroche za limit nic sie nie stanie 213 jest niezlym
wynikiem”. The [recorded direction](https://github.com/ColdPhase/flux/issues/228#issuecomment-6251802241)
accepts the **213.167416 ms** map500/drag200 result in the retained
[complete nine-cohort run](evidence/live-editing/2026-10-18-access-latency/README.md)
at `7af776c7dfd4403e3937c8ccd4b9723c7808d587`. The other eight cohorts meet
the 200 ms target; all 2160 scheduled rows have zero input/sample/socket errors,
the actual collector is COMPLETE, all 26 final gauges are zero, and the original
producer has a verified clean exit. The later selected 214.850179 ms result
retains its [original source and incomplete collector](evidence/live-editing/2026-10-18-lazy-outline.md#coordinators-subsequent-selected-timing);
it cannot replace the complete run or establish resource acceptance.

The 200 ms target, original driver, raw verdicts and source pins remain unchanged.
The delivery may accept this specific measured departure with the founder's
authorization; it is not a blanket future latency bound. No new profile or
measurement is required solely to turn this small overrun into a strict 200 ms
pass. Final independent evaluation still assesses the retained evidence's
compatibility with the composed application. Functional recovery, current
authority/privacy, complete resource evidence and protected independent approval
remain required. No new run or application-only speedup is claimed.

**Whole-issue technical acceptance, 2026-10-18:** [final independent evidence](evidence/live-editing/2026-10-18-final-review/README.md) accepts candidate `c66eefc7` using compatible retained measurements and final composed Chromium/WebKit interaction/renders, including all three resolved P2 findings. The founder exception above applies; eligible protected approval is still required.

### Candidate identity-read method change (2026-10-18, #228 / #613)

The failed canonical run at `8ba5f87ae065d52b4b69158648f8e863b3d3f9cb`
remains [FAIL, 8/9 cohorts](evidence/live-editing/2026-10-18-map-body-performance/README.md#subsequent-canonical-g4-run-fail),
including map-500-drag-200 p95 230.479ms. It used driver SHA-256
`11b71d4f9d34a471367de974ec93bde207b4b6f0a6b813babaa2d68c1a79e3c3`.
No later method change can relabel that evidence or establish a code-only speedup.

One private, non-acceptance diagnostic at
`28ad6b43e91cea907b1bf22c0de343265c91387f` preserved the application, screenshot
flags, 30 warmups and 240 scheduled map-500-drag-200 rows. The unchanged collector
rejected its one-case marker; it is not a G4 pass or a complete queue capture.
In the exact scheduled 60 seconds, its owner trace records 1279 repeated attached
canvas lookups with cumulative protocol duration 14.219s (p95 17.654ms), while the
CPU profile samples 7.862s in Playwright's `computeBox`. These times overlap with
application work and cannot be subtracted from latency.

The post-pointer identity read uses `Locator.evaluate`. In pinned Playwright
1.62.0, [that method](https://github.com/microsoft/playwright-python/blob/v1.62.0/playwright/_impl/_locator.py#L177)
resolves an attached element through `wait_for_selector`. The
[server lookup](https://github.com/microsoft/playwright/blob/v1.62.0/packages/playwright-core/src/server/frames.ts#L783)
computes visibility even for the attached state; its
[box computation](https://github.com/microsoft/playwright/blob/v1.62.0/packages/injected/src/domUtils.ts#L109)
reads style and geometry. The driver needs the current canvas identity at this
point; its separate peer observation still verifies the visible result.

The bounded candidate changes **only this repeated identity read** to a fresh
`page.evaluate` query. It must require exactly one connected current canvas and
return the same gesture ID, generation, numeric sequence and document visibility.
It must retain the existing refusal of missing/current-invalid identities.
Trusted pointer input, continuous input cadence, all selected positions, versions,
leases, server-named receipts, coverage, visible target bounds, two animation
frames and recheck, screenshots, traces, row counts, deadlines, error denominator,
queue/shutdown validation and the 200ms gate stay unchanged. No peer lookup or
application optimization is admitted by this diagnostic alone.

Before a new canonical run, verify old/new identity equivalence against a running
application and rejection of missing/duplicate canvases, plus relevant driver and
evidence checks. Pin the changed driver and candidate separately. Implementation
and author verification are admitted in the isolated disabled fixture; independent
source/method evaluation and the complete canonical result remain required before
acceptance. This record is a candidate method decision, not a claim of either.

### Candidate combined peer-paint observation (2026-10-18, #228 / #613)

**Status after the later founder direction above:** retained private experiment,
not part of PR #613. The implementation and partial author calibration remain on
the private branch; WebKit equivalence was not run and no new timing acceptance
is claimed. PR613 keeps the original canonical `painted()` helper. The proposal
below records what was considered before the founder accepted the measured
overrun; it creates no remaining implementation or review gate for this delivery.

The original full-nine run at `7af776c7` remains FAIL8/9, including map500/drag200
213.167416 ms. After the later application corrections, selected source
`e568243c3de2f40f7c8280edb9b8aa37295352eb` still failed at214.850179 ms. Its
[source-pinned result](evidence/live-editing/2026-10-18-lazy-outline.md#coordinators-subsequent-selected-timing)
and incomplete single-cohort collector are unchanged by this proposal.

That existing peer trace records270 observations including30 warmups. The
first `JSHandle.jsonValue` round trip has p50/p95 9.921/14.276 ms; the separate
two-RAF evaluation27.305/49.071 ms; the separate full final geometry evaluation
15.049/24.806 ms. These protocol intervals overlap other work. They are neither
pure application cost nor values to subtract from the reported latency. No new
CPU profile or runtime retry supports this candidate.

At baseline `2017906dcd150f508edd2fc99e10fb3024ec66db`, change only the
`painted()` helper's transfer of results. Keep the exact `wait_for_function`
predicate, arguments, RAF polling and timeout. Once its truthy handle resolves,
record Python monotonic `condition_at`. Using the public
[JSHandle.evaluate API](https://playwright.dev/python/docs/api/class-jshandle#js-handle-evaluate)
and [pinned1.62.0 implementation](https://github.com/microsoft/playwright-python/blob/v1.62.0/playwright/_impl/_js_handle.py),
retain that first plain value in its existing browser context, await the same
nested two `requestAnimationFrame` callbacks, then evaluate the exact complete
predicate again against the current DOM and arguments. Await its value as the
old `page.evaluate` does. Return both complete `first_render` and `render`
objects in one serialized response. Set `painted_at` only after that response
has arrived; reject a false final result with the existing error.

The first result is a fresh plain snapshot, not a DOM node or a reusable current
state. Keeping it must never substitute for the full post-RAF recheck. No DOM,
element, geometry or identity cache is introduced. All200 positions, versions,
generation/gesture/lease, current visible bounds, exact publication/server-named
receipt coverage and named Wiki cursor checks remain. All other driver
functions and constants, continuous trusted input, warmups,240-row/60s schedule,
deadline/error denominator, original200 ms gate, local control without
subtraction, trace screenshots and actual collection/shutdown/seal stay intact.

`condition_at` now marks initial handle resolution before the first snapshot's
JSON transfer; formerly it followed that transfer. Disclose this difference in
`condition_at` and `two_raf_and_recheck_ms`; do not compare those subsegments as
unchanged or subtract them. The total input→complete post-RAF response still
uses the one driver monotonic clock and includes the actual protocol overhead.

The independent `review_612` agent assessed this concrete plan in the supervising
session before implementation: accept with required equivalence checks, no
P1/P2 gap. Publisher/implementation owner isPelikanFix16; this assessment is
neither a final review ofPR613 nor an eligible GitHub Code Owner approval.
Before a new canonical run, verify old/new on the actual application in both
Chromium and WebKit:

- Complete first/final snapshot shape, exact identities and all200 positions for
  held input, then real later same-gesture coverage with actual wire receipts.
- Refusal of wrong generation/version and hidden/clipped target; invalidation
  after initial success but before final recheck must fail rather than reuse the
  first snapshot. Invalid-state controls may change test DOM, never transport.
- Actual Wiki editor and ordinary reader predicates, including named cursor
  evidence, current confirmed sequence and visible character geometry.

Pin the implementation and prove all driver AST outside `painted()` unchanged.
Only after those checks may a fresh original nine-case measurement collect its
own2160 rows and complete actual queue/seal/producer evidence. Final independent
source/method/functional and neutral visual evaluation remain required before
acceptance. Preserve every previous failure; a new observer implementation
cannot establish an application-only speedup or relabel an old result.

The nine case names are fixed:

```text
map-50-drag-1
map-50-drag-50
map-500-drag-1
map-500-drag-50
map-500-drag-200
wiki-10000-editor
wiki-10000-reader
wiki-100000-editor
wiki-100000-reader
```

Each retains 30 peer warmups, 240 scheduled rows at 250 ms over 60 seconds, continuous trusted input between samples, and the separate 30-sample local render control. The existing 1000 ms deadline, exact receipt/generation/coverage checks, all selected map positions and two animation-frame opportunities remain. Every error/timeout stays in the denominator as infinity. A strict driver pass needs nearest-rank p95 ≤200 ms and zero errors/timeouts/overload; the finite successful distribution is reported separately. Delivery acceptance of the specific 213.167416 ms result follows the founder exception above without changing that raw verdict. No driver, local-render, collector or telemetry overhead is subtracted. ACK or publication coverage alone is not rendered visibility. A superseded-covered row retains its actual later same-interaction rendered observation and measured latency.

Keep each case's original rows, coverage, publications, local control, summary, traces and screenshot. Queue correlation sidecars (`<case>-queue-correlations.json`) contain only actual matched server observations by row index; they do not rewrite original measurement rows. Unmatched per-row server depth stays null. Actual aggregate queue/resource peaks remain mandatory.

## Finish, drain, flush and seal

Use the following ordering, including on a measurement failure:

1. The driver completes its attempts, settles actual browser teardown and validates the retained row artifacts. It atomically writes `measurement-finished.json` with mode 0600 using a temporary file, file flush/fsync and rename. This is a request to finish collecting, not proof that tests passed.
2. The runner validates and hashes that marker. It gracefully closes **all expected API producers**, keeping the collector running. Each producer settles gate/controller/authority/SQL/codec shutdown and WebSocket send callbacks, and emits its terminal record with actual gauges/peaks. The source candidate handlesSIGTERM/SIGINT with a7s application deadline inside the runner8s stop allowance, then waits for the one terminal stdout write callback/flush outside SQL. The runner must inspect each stopped actual container and requireRunning=false, Dead=false, OOMKilled=false and ExitCode=0, as well as clean stdoutEOF/collectorflush. A forced8s kill can make Dockerstop itself return0; that return alone does not establish a clean producer exit. An unexpected first terminal write(false)/error/timeout cannot retroactively change its already-written JSON: the producer reports a nonzero/incomplete process outcome, never a replacement final. A finite shutdown deadline produces a false/incomplete drain; it must not invent resource zeros.
3. The runner captures the final record from each expected instance and actual producer stdout completion. **Only then** stop and flush the collector, reach clean EOF, and make the raw file immutable. An earlier dropped/backpressured observation remains cumulative; later flush cannot erase it.
4. The runner validates the final raw byte/line counts and SHA-256, then atomically writes `queue-seal.json` using the same local temporary-file/flush/rename method. The driver polls asynchronously for at most **15 seconds from finish-marker publication**, then independently validates the marker, seal and finalized raw file. Budget producer shutdown/collector flush within this finite window. No seal, a malformed seal, timeout or interrupted run is incomplete evidence.

The root-owned collector also preserves bounded `producer-shutdown.json` (at most65536 bytes), atomically flushed/fsynced/renamed beside the seal. Its exact schema is `schema:1`, `source_sha`, `inventory_sha256` of the unchanged initial private inventory, and `producers` keyed by every expected API instance. Each producer retains the actual `container_id`, initial `started_at`, observed `finished_at`, `exit_code`, `oom_killed`, `running`, and `dead`. Acceptance compares the exact inventoried containerID AND unchanged initialStartedAt, `State.Status=exited`, `ExitCode=0`, `Running/Paused/Restarting/OOMKilled/Dead=false`, emptyState.Error and an actual nonzeroFinishedAt. Capture terminal callback flush and actualstdoutEOF from that same process lifecycle before raw/seal completion. Neither a replacement/restarted container nor a successful Dockerstop CLI return establishes clean shutdown. This additional actual-inspection artifact is independently bound to source/inventory; it does not add unknown fields to the driver's closed seal schema. Missing or mismatched inspection is incomplete evidence even with a well-formed final record.

Both local handoff files are strict UTF-8 JSON objects, at most 4096 bytes including the newline, with no duplicate fields, unknown fields, NaN/Infinity or bool-as-integer counts. The finish marker has exactly:

| Field | Meaning |
| --- | --- |
| `schema` | Integer 1. |
| `measurement_id` | Fresh canonical UUID for this run. |
| `source_sha`, `driver_sha256` | Exact preflight pins. |
| `api_instances` | Exact initial expected inventory, including order. |
| `planned_cases` | Exact nine case names in the order above. |
| `completed_case_count` | Number of actual row artifacts containing every unique index 0–239 and passing structural row validation. This is artifact coverage, not latency success. |
| `scheduled_rows_written` | Rows in those structurally validated artifacts, including their error/timeout rows; never loop attempts or successful summaries. Partial arrays count only their validated retained rows. A malformed artifact is excluded and reported. |
| `teardown_complete` | Actual boolean observation of completed browser teardown; false/partial is preserved. |
| `finished_at` | Finite nonnegative driver monotonic timestamp. It is not compared with another process's clock. |

Row validation checks case/source, unique bounded scheduled index, fixed deadline, account/workspace/resource identities, scheduled/observed timestamps, outcome and finite deadline-bounded successful latency or null for error/timeout. The existing behavioral assertions remain the authority for visibility and latency. Gate 4 requires all nine complete artifacts and all 2160 rows; a telemetry seal cannot repair missing rows or a failed case. Partial/failing runs still publish an honest marker so the runner can close and retain evidence.

The seal has exactly:

| Field | Meaning |
| --- | --- |
| `schema` | Integer 1. |
| `measurement_id`, `source_sha`, `api_instances` | Exact bindings to this finish marker and initial inventory. |
| `measurement_finished_sha256` | SHA-256 of the exact published marker bytes. |
| `raw_path` | Fixed relative basename `actual-queue.jsonl`. |
| `raw_bytes`, `raw_sha256`, `record_count` | Exact finalized raw bytes, SHA-256 and retained line count. |
| `complete` | Boolean integrity conclusion, checked independently by the driver. Startup `complete: false` has no authority to override it. |
| `dropped_records` | Sum of cumulative dropped-record counters from **each instance's final**, not maximum across instances. |
| `backpressured` | OR of the cumulative final backpressure flags. |
| `final_drained` | AND of the actual producer `finalDrained` observations. |
| `end_reason` | Exactly `drained`, `collector-error`, `timeout` or `size-limit`. |

The raw file is a regular file, never a symlink or FIFO; no handoff/raw file may change while being validated. Raw bound is **32 MiB**, **65,536 retained records**, **4096 bytes per newline-terminated line**. Empty, appended, partial or oversized lines fail validation. Canonical UUIDs and lowercase exact 40/64-hex hashes are required. Numeric counters are exact nonnegative integers ≤2^53−1, excluding booleans. Reserve room for each bounded final rather than silently truncating it at the collector/producer cap. A size limit is incomplete even if earlier records exist.

## Closed producer record schema

Each retained record has exactly the common fields below, all 26 resource gauges and their 26 derived peaks, and the three cumulative record counters. Only the enumerated correlation/final fields are optional. The additive `wikiCursorPending` field records the bounded latest waiting cursor; historical 25-gauge evidence, including the failed original nine-case run on `431d4566c4e6a8f3f47ede8e6df17ba272543b7f`, remains tied to its original producer, driver and collector. It cannot certify this later schema.

| Field | Required semantics |
| --- | --- |
| `schema` | Integer 1. |
| `apiInstance` | A member of the initial expected inventory. |
| `kind` | Exactly `initial`, `wiki`, `map` or `final`. Each instance starts with one initial; its final is terminal, with no later record. |
| `resourceId`, `generation` | Null on initial/final, canonical UUIDs on wiki/map. |
| `backpressured` | Actual cumulative boolean; once true it cannot reset. A Node stdout write returning false is an accepted retained write with backpressure, not a missing line; later deliberately declined writes count as drops. |
| `commandId`, `interactionId` | Optional canonical UUID correlation, only on wiki/map. No text, names, positions, cursors, credentials or client-provided authority. |
| `inputSequence`, `confirmedSequence` | Optional exact nonnegative integer correlation, only on wiki/map. |
| `finalDrained` | Required only on final. True requires **every resource gauge below to be zero** after actual shutdown settlement; final peaks and record counters remain real nonzero observations where applicable. |
| `attemptedRecords`, `retainedRecords`, `droppedRecords` | Cumulative per-instance counts **including the current retained record**. Attempts = retained + dropped. Retained count must equal the actual captured lines for that instance. No peak aliases for these counters. |

The 26 gauges are:

```text
gatePending gateConnected
wikiConnections wikiReading wikiWriting wikiCursorActive wikiCursorPending
assemblyCount assemblyBytes
httpQueued nativeQueued wikiOutputQueued admissionQueued
codecLeases codecWaiting codecActive wikiSqlActive
mapQueued mapActive mapSqlActive mapConnections mapOperations
mapPendingMovement mapPendingPresence
externalInputBytes externalOutputBytes
```

For **every** gauge, derive exactly `peak` plus its first letter capitalized: `peakGatePending`, `peakCodecActive`, `peakAssemblyBytes`, `peakExternalOutputBytes`, and so on for all 26. The producer maintains these actual peaks synchronously on every relevant enqueue/promotion/reservation/release/resource mutation. Sparse receipt/final sample maxima cannot stand in for peaks between samples. Emit bounded initial, accepted wiki receipt/map preview and terminal final records, without an unbounded telemetry queue or samples array. The source candidate samples ordinary frames on a fixed200ms timer (at most5Hz per API), retaining one common-budget-charged primitive latest correlation. Each real accepted receipt/preview may replace that pending correlation; all26 peaks still update on EVERY underlying mutation. Coalesced interactions remain in the original latency denominator; their optional row-correlated depth is null. Unsampled interactions are not telemetry frame attempts. An attempted sampled write that is refused/dropped increments the cumulative counters. Initial/final are outside that ordinary sampling timer; shutdown stops the timer and releases its charged pending metadata before terminal observation. Counts/peaks/backpressure cannot reset within an instance. Each peak must be at least its current gauge.

Producer source getters read the actual transport reservations/clients, wiki active connection/read/write/cursor operations (including closed connections whose work is settling), assembly maps/bytes, HTTP/native/wiki preparation queues, codec admission/leases/waiting/active state, held wiki/map SQL operations, map granted/queued admissions and controller operations/coalesced slots. Those component shutdowns retain their operation handles until actual settlement; no missing getter substitutes zero. The source mappings and mutation callbacks remain unverified until current-pin source assessment and runtime falsification.

`wikiCursorActive` counts actual unsettled cursor authority operations. `wikiCursorPending` counts one replaceable latest waiting cursor per current connection/generation, independently of that active operation. Before retaining either continuation, the controller charges its raw/parsed metadata to the shared output/context budget; a replacement releases the old waiting lease, not the active lease. The waiting cursor expires after the existing five-second presence bound, and close releases it while retaining the active continuation through actual settlement. Promotion invokes current authority again. Cursor/ACK refusals carry no text command UUID; only a bounded actual text frame can identify its own text refusal. This coalesces transient presence and does not change any sealed text intent or durable retry bytes.

These are actual component counters, with overlap: they are not values to sum into a new memory cap. `externalInputBytes` observes `CodecPool`'s `AdmissionBudget.bytes`: retained raw backing, transfer-copy allowance and current/reserved codec state/result charges, with its separate 32 MiB cap. `assemblyBytes` observes retained assembly chunks plus the completed assembly copy, with the existing separate 32 MiB cap. `externalOutputBytes` observes the **one shared API `EditingOutputBudget.bytes`**, capped at 32 MiB, including immutable authority metadata continuations, HTTP/WS protected source preparation, parsed map input/context, payloads and outstanding WebSocket wire copies. Ownership transfers conservatively charge overlap; metadata ceasing to occupy the codec budget must remain charged in the common output budget. Both current values **and mutation-maintained peaks** must respect each distinct cap: a final zero cannot erase an earlier 33 MiB peak. This does not certify whole-process memory. No counter omission is interpreted as zero. Telemetry flags are development-only and telemetry's actual overhead stays inside the measurement.

## Integrity verdict and required checks

Queue evidence is `COMPLETE` only with every expected instance's valid terminal final, true actual drain, zero current resource gauges, no drops/backpressure/overflow, clean `drained` end reason and matching source/marker/raw bytes/hash/counts. The seal must agree with actual finals; seal-only true is insufficient. Missing inventory/initial/final/counter, cumulative reset, unexpected field, mismatch, collector error or timeout is `INCOMPLETE`, making the entire Gate 4 fail. COMPLETE telemetry can accompany a failed latency measurement and never clears its failures. Do not reinterpret missing per-row correlation as zero queue depth.

Run bounded protocol regressions in Docker before the real nine-case measurement: initial false plus a valid sealed final succeeds; initial true preflight, missing expected producer/final, stale source/measurement/finish hash, truncated/appended raw, wrong byte/record count, invalid UTF-8/duplicate JSON/NaN, symlink/FIFO/oversize, counter reset/drop/backpressure, non-drained final, current/peak budget overflow and collector timeout all fail. Prove short resource mutations survive in each recorded peak rather than computing peaks from sparse snapshots. Also run an honest partial/failed measurement: its finish counts and failures remain intact while the collector is allowed to drain.

Finally exercise the actual backend shutdown/collector EOF path and all nine real two-account browser cases on the exact candidate. Retain the original 2160 rows and all traces, metadata, sanitized inspection output, raw log, marker, seal and summary. Independent evaluation must inspect those current source pins and actual checks. Screenshots or a protocol-unit test alone do not establish collaboration, persistence, keyboard behavior, physical phone evidence or the four-gate completion.

## Driver revisions 2026-10-09 (#389)

Two driver defects made rows fail whatever the product did. Thresholds, deadlines,
denominators and correlations are unchanged.

- **Last visible character.** The reader check took the last non-empty text node of
  `.doc-prose`. Sanitized Markdown ends a block with a newline text node, which has
  no glyph and a zero-size rectangle, so no reader row could ever paint (every row
  timed out at the paint step). The check now takes the last character of the last text
  node that has visible content; the editor checks are unaffected.
- **Released keys.** The input task was cancelled between a key's down and up, leaving
  Shift pressed for the next case. That case's first replacement then selected nearly
  the whole document: the 10k reader measured a two-character body. The task now
  finishes its input in progress and the owner's modifiers are released.

**Fixture transport, 2026-10-10.** The same-origin forwarder the fixture shares with every
browser check (`start_forwarder` in `tests/ui/test_app_shell.py`) left Nagle's algorithm on.
A small frame written while the previous one awaited its TCP acknowledgement then waited
for the receiver's delayed ACK, about 40 ms, on a hop that no deployment has: browsers,
Node and real proxies set `TCP_NODELAY`. The forwarder now sets it on both sockets
(`ForwarderTransport` in `tests/ui/test_live_editing.py`: 41 ms per small exchange before,
3 ms after). The driver, thresholds, deadlines, denominators and correlations are unchanged.

## Accepted trace-snapshot decision (2026-10-13)

The current driver starts Playwright tracing with `screenshots=True` and
`snapshots=True`; the fixed measurement contract above requires retained traces and a
standalone peer screenshot, but does not specify that DOM snapshots must be enabled.
The accepted [measurement note](live-editing-proposal.md) records that, at 200 changed
thoughts, each trace snapshot serialized the changed positions (about 125 KB per peer
snapshot versus 9 KB for drag-1), while the driver's visibility checks already inspect and
return all 200 positions. It also records one same-code comparison with snapshots enabled
at 209 ms and disabled at 161 ms, and says a reduction in this measurement work is a
driver decision. The founder's [PR #389 handoff](https://github.com/ColdPhase/flux/pull/389#issuecomment-6093931519)
likewise says changing trace snapshots requires a separate decision.

A separate, non-acceptance diagnostic on source `00d1d99cb93393c40223efe6ed5730e493b59f0f`
kept 30 warmups and all 240 scheduled rows for `map-500-drag-200`, disabled both
Playwright snapshots and trace screenshots, and added 5 ms CDP sampling. Its rows had no
behavioral failures and p95 was 146.681 ms, but its one-case marker was rejected by the
unchanged nine-case collector contract, so the collector seal was incomplete and the
overall command exited 1. This diagnostic cannot establish a passing Gate 4 or isolate the
effect of snapshots: it also disabled trace screenshots and added CPU profiling. Its owner
profile nevertheless showed Playwright-injected sampling fall from 27.237 s in the earlier
snapshots-enabled partial profile to 8.080 s in the no-snapshot diagnostic; those samples
are observer work, not a source-level hotspot. The canonical nine-cohort run at the same
application candidate remains **FAIL**, including map-500-drag-200 p95 237.477 ms against
the unchanged 200 ms limit and the separate map-500-drag-50 identity failure.

**Independent contract decision accepted and implemented.** On docs head
`323669643d2529d036aa1d74b31cd412764b8f3f`, PelikanFix16 accepted the bounded decision in
[this review comment](https://github.com/ColdPhase/flux/pull/389#issuecomment-6151484881).
That evaluation is not a formal GitHub approval. This driver change sets only
`snapshots=False` on both Playwright traces, retains `screenshots=True` in the traces and
the standalone peer screenshot, and leaves every row, freshness, geometry, receipt,
coverage, socket, paint, p95 and zero-error assertion unchanged. It subtracts no observer
time. The canonical nine-case plan, 2,160-row finish marker, actual queue collector,
shutdown checks and seal are unchanged. This source change has its own exact pin; it needs
independent source review before the full canonical nine-cohort run and complete seal at
that pin. Preserve the earlier failed run as-is. The separate diagnostic above changed
both trace options and therefore supports investigation, not this one-option change's
causal effect.

The supporting files remain outside the repository to avoid adding large traces and row
artifacts to every clone. On the shared host, the diagnostic directory is
`/home/hubert/Develop/flux-evidence-archive/flux389-profile-diagnostic-00d1d99-nosnap/`;
the canonical failed run remains at
`/home/hubert/Develop/flux-evidence-archive/flux389-gate4-00d1d99-current/`. Key SHA-256
pointers:

| Artifact | SHA-256 |
| --- | --- |
| Diagnostic 240 scheduled rows, `map-500-drag-200-rows.json` | `3299f81bdb30929bb8e78d0c960f79e2c0852f226c37519e1e15916cc8a7f837` |
| Diagnostic owner CPU profile | `c3498dad1fdec8cb9804e2eda664fc1d9f5ae42ae098a0959ca88d2241e5b432` |
| Diagnostic peer CPU profile | `f17cb2b1a0e9d8a946c1b2a06c6f32d0369fbe55c97890ccc3adf9c4c0407750` |
| Diagnostic owner runtime metrics | `2e808080d85aa0bef7624645ee47956001c6acd94687ecc549a0378655117de0` |
| Diagnostic peer runtime metrics | `2f4438ada2ff4e3a77c3ce513b0f492ab9329aa9b0919397c91f28b03adc7b35` |
| Diagnostic cohort summary, `map-500-drag-200-summary.json` | `8b037fd14d020d9ab16ce302eda87c72ca79af21575e0e26304de39b5b8d38cd` |
| Diagnostic whole-run summary, including the incomplete queue-seal failure | `7d7a6a4909f4576186eed22f6a0e15a6f9795aad20bc7972d5e7517a2ee944e0` |
| Canonical Gate4 map-500/drag-200 summary (p95 237.477 ms) | `513897eeb1052e43d577c75896904c9e80ac8d654c0f58411a5eb439a663370b` |
| Canonical Gate4 map-500/drag-200 rows | `b8633c617fd594f40fba9ee836f9517ee26c50622d0eb664378eceb03416ff49` |

The author's prior separate-decision note is
[here](https://github.com/ColdPhase/flux/pull/389#issuecomment-6093931519). The local
analysis report and full manifest, including instrumentation hashes, remain in
`/home/hubert/Develop/flux-evidence-archive/flux389-profile-diagnostic-manifest/`.

## Cursors, presence and a current-head run (2026-10-17, #228)

**Peer-visible cursors and presence.** The map now draws each other writer's pointer as a small
colour-coded name label (`.sk-peer`, the colour is the wiki's per-person colour) and lists who is on
the map (`.sk-here`). The pointer travels as the existing `map-presence` frame (`cursor` in stored
plane units, at most every 50 ms, re-sent each second, expires with the presence lease); readers
publish nothing. `app/tests/ui/test_live_map_cursors.py` proves, with two real accounts and sockets,
the map cursor and who-is-here and the wiki's named caret and writer line. Chromium and WebKit
2/2 each (`FLUX_LIVE_EDITING_SHOTS=/dir ./scripts/check_live_editing.sh test_live_map_cursors`
keeps the screenshots).

**Gate 3 cross-process.** `./scripts/check_live_editing.sh --two-api` at `dd43b8d7`: 1/1 pass.

**Gate 4 latency at `dd43b8d7ffd5d7939a1624395533a91ca0ed0ff0`** (`--latency`, nine cohorts,
clean checkout, collector sealed, collector exit 0, driver exit 1 "retained case failures").
Zero errors and zero timeouts in every cohort. Nearest-rank p95 (ms) against the 200 ms limit:

| Cohort | p95 | |
| --- | ---: | --- |
| map-50-drag-1 | 147.6 | pass |
| map-50-drag-50 | 166.9 | pass |
| map-500-drag-1 | 148.5 | pass |
| map-500-drag-50 | 167.0 | pass |
| map-500-drag-200 | 230.1 | **fail** |
| wiki-10000-editor | 182.3 | pass |
| wiki-10000-reader | 160.1 | pass |
| wiki-100000-editor | 211.1 | **fail** |
| wiki-100000-reader | 191.2 | pass |

The run is **not** a pass for the 200-drag and 100k-editor cohorts. It was taken on a shared
24-core host with about 15 other containers and a load average near 7, not the isolated healthy
host the target names; it is a measurement, not an acceptance claim, and the earlier
`79e3a14b` PASS is neither replaced nor repeated by it. Raw rows: `/home/hubert/flux-evidence/228-live-cursors/latency/`.


### Candidate native WebKit composition check (2026-10-18, #228 / #613)

The [integrated baseline](evidence/live-editing/2026-10-18-integrated-baseline/README.md)
retains two WebKit harness errors without passing the required paths. CDP composition
remains the actual Chromium path. WebKit needs native preedit and commit rather than
a synthetic DOM composition or an inserted final Japanese string alone.

The candidate runs **only the WebKit IME journey** headed in its own Xvfb display,
using GTK's built-in Simple IM context and real XTEST keyboard input. GTK documents
[Ctrl+Shift+U hexadecimal Unicode composition](https://gnome.pages.gitlab.gnome.org/gtk/gtk4/class.IMContextSimple.html).
The pinned Playwright [native dependencies](https://github.com/microsoft/playwright/blob/v1.62.0/packages/playwright-core/src/server/registry/dependencies.ts)
include the X11/GTK runtime; its existing digest-pinned UI image is the dependency
boundary. Use installed Xvfb, libX11 and libXtst with explicit availability failures;
do not silently fall back to JavaScript events or Playwright protocol key dispatch.
[The latter bypasses GTK's input-method filtering](https://github.com/microsoft/playwright/blob/v1.62.0/browser_patches/webkit/patches/bootstrap.diff).
[XTEST key input](https://www.x.org/releases/current/doc/libXtst/xtestlib.html) goes
through the native GTK/WebKit input path.

Send separate hexadecimal preedits for U+65E5 and U+672C, observing preedit before
committing each. Require native trusted composition start/update/end events and
native trusted input, then exactly one `日本` in both actual authorized replicas,
no leftover preedit, an honest shared ACK and unchanged saved history. Keep the
original Chromium kana preedit/commit assertion. Also exercise completion at the
100,000-code-unit limit through trusted deletion of enough characters to keep
intermediate composition within the existing limit, then restore exactly 100,000
with the native commit and ordinary suffix. Inspect the real public live head;
never replace the application's editor content or collaboration transport.

A temporary unique browser-window title may identify the writer's native X11
window; it changes no editor or product state and is restored. Isolate and clean
up the display/browser even on failure, refuse ambiguous/missing windows, and
record the actual input witness. Other UI/latency journeys keep their original
headless configuration. This proves native GTK Unicode composition in the
required WebKit engine, not a physical Japanese keyboard, kana candidate UI,
iOS keyboard or all platform IMEs. Physical devices remain optional under #266;
this method and its actual runtime result still need the single consolidated
independent functional assessment. Until runtime proof succeeds, WebKit IME
acceptance remains pending; no criterion is waived by this candidate record.


### Full editor text through a trusted Copy payload (2026-10-18, #228 / #613)

The WebKit native IME journey now completes its small and100k cases at
`4618e319b992137c83475fdfb943cf4c355ec114`; this does not change the other failed
checks in that run. WebKit's clipboard-read selection still produces a real
`NotAllowedError` in the current headless fixture. Do not turn that into passing
quota/undo coverage or claim system-clipboard/paste compatibility.

The full-text observer candidate reads the `text/plain` payload of the actual
trusted Copy event, after the existing CodeMirror handler has populated its
ClipboardEvent data and prevented default copying. The observer adds no editor
state, text, synthetic event, transport or clipboard content. A fresh nonce and
sentinel require a new event from the current focused editor; require
`isTrusted`, the current source element, handled default action and a complete
plain-text payload. An old witness, absent event, untrusted event, empty payload
or viewport-only text must fail. Remove the temporary listener and observation
when done. This verifies the actual user Copy output of the complete editor,
not permission to read or paste the operating system clipboard.

Keep both accounts' exact99,999/100,000-character comparisons, real server
ACK/generation/sequence/hash quorum, concurrent own-undo refusal and over-limit
input refusal unchanged. The observer replaces only an unsupported observation
mechanism. Its browser results and source remain required in the consolidated
independent review; the original failed clipboard attempts retain their pins.

### Where the retained evidence pins resolve (2026-10-22, #613)

The pins `aade67efde45b8156fe933c2124ab5a2a96d580a` (roomless conflicts, API
50/50 and two-API), `759ecb40696f88cccb231dd33c49b739563d4e76` (lazy outline,
confirmed Undo) and `e568243c3de2f40f7c8280edb9b8aa37295352eb` (unchanged
map200 author diagnostic) were local-only worker commits and are not ancestors
of the squash-merged PR. They are published as the tags
`archive/228-pin-aade67ef`, `archive/228-pin-759ecb40` and
`archive/228-pin-e568243c`, so each pin resolves with
`git fetch origin tag archive/228-pin-<short>`. Their trees are the sources the
retained evidence describes; the PR head still differs from them as the
dossier states.
