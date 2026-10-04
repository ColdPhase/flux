# Live editing verification evidence

This is the local evidence protocol for the accepted [live editing proposal](live-editing-proposal.md), especially its four gates and latency measurement contract. It adds no feature enablement, public telemetry endpoint or lower acceptance threshold. A driver, producer or collector source change needs a new candidate pin and relevant checks. The earlier `8444a8b506b3600762666d634f37a8132bcfcf96` driver (SHA-256 `353d391cfcfb4b9ffd87cfc7a94777aa575b5b8717906655693a84d61f6857df`) is historical, unverified evidence; its startup descriptor cannot certify a later collector flush.

The driver implementation lives in `app/tests/ui/live_editing_latency.py`. The producer and external collector must implement the lifecycle below before this driver can report complete queue evidence. This document does not claim their implementation, graceful shutdown, browser behavior or latency has passed. Full live editing stays unavailable by default until all four gates pass on the coherent candidate.

## Candidate and environment preflight

Use an isolated stack, fresh project name, database/files volumes and fixture credentials. Build both application and `ui-test` images from the exact frozen candidate; browser tests are baked into the image. Run application, dependency inspection and tests in Docker under [the container contract](containers.md). Preserve the app's ordinary origin, session, authorization and rate checks. `FLUX_DEVELOPMENT_LIVE_EDITING=true` is only for this explicitly isolated candidate. The proposed `FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY=1` additionally requires the development capability; it supplies bounded local stdout observations, not a public API. Its existence and implementation need separate source/runtime verification.

Before starting browser measurements, the runner must:

1. Create a fresh evidence directory shared with the driver and collector. There must be no previous `planned.json`, `summary.json`, `*-rows.json`, `measurement-finished.json` or `queue-seal.json`. Start collection early enough to retain every API producer's initial record.
2. Inventory **every expected measured API instance** from the actual running Docker setup. Give each a unique, nonsecret ID matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Inventory has 1–32 IDs, in stable order. Deriving it from observed telemetry would hide an entirely missing producer. Gate 4 records the actual one/two-instance setup; Gate 3 still requires its separate two-process proof.
3. Inspect the actual environment, dependency pins and image/source contents. Write sanitized `runtime.json`, then compare the baked driver's SHA-256 and candidate source SHA. Do not collect full environment variables, authorization headers, cookies, connection strings or keys.
4. Start a finite collector which retains only the agreed primitive telemetry records as strict UTF-8 JSON lines in `actual-queue.jsonl`. Keep non-telemetry diagnostic logs separately, sanitized. A collector truncation, malformed record, loss or producer stdout backpressure makes evidence incomplete.

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

Each retains 30 peer warmups, 240 scheduled rows at 250 ms over 60 seconds, continuous trusted input between samples, and the separate 30-sample local render control. The existing 1000 ms deadline, exact receipt/generation/coverage checks, all selected map positions and two animation-frame opportunities remain. Every error/timeout stays in the denominator as infinity. A pass needs nearest-rank p95 ≤200 ms and zero errors/timeouts/overload; the finite successful distribution is reported separately. No driver, local-render, collector or telemetry overhead is subtracted. ACK or publication coverage alone is not rendered visibility. A superseded-covered row retains its actual later same-interaction rendered observation and measured latency.

Keep each case's original rows, coverage, publications, local control, summary, traces and screenshot. Queue correlation sidecars (`<case>-queue-correlations.json`) contain only actual matched server observations by row index; they do not rewrite original measurement rows. Unmatched per-row server depth stays null. Actual aggregate queue/resource peaks remain mandatory.

## Finish, drain, flush and seal

Use the following ordering, including on a measurement failure:

1. The driver completes its attempts, settles actual browser teardown and validates the retained row artifacts. It atomically writes `measurement-finished.json` with mode 0600 using a temporary file, file flush/fsync and rename. This is a request to finish collecting, not proof that tests passed.
2. The runner validates and hashes that marker. It gracefully closes **all expected API producers**, keeping the collector running. Each producer settles gate/controller/authority/SQL/codec shutdown and WebSocket send callbacks, and emits its terminal record with actual gauges/peaks. A finite shutdown deadline produces a false/incomplete drain; it must not invent resource zeros.
3. The runner captures the final record from each expected instance and actual producer stdout completion. **Only then** stop and flush the collector, reach clean EOF, and make the raw file immutable. An earlier dropped/backpressured observation remains cumulative; later flush cannot erase it.
4. The runner validates the final raw byte/line counts and SHA-256, then atomically writes `queue-seal.json` using the same local temporary-file/flush/rename method. The driver polls asynchronously for at most **15 seconds from finish-marker publication**, then independently validates the marker, seal and finalized raw file. Budget producer shutdown/collector flush within this finite window. No seal, a malformed seal, timeout or interrupted run is incomplete evidence.

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

Each retained record has exactly the common fields below, all 25 resource gauges and their 25 derived peaks, and the three cumulative record counters. Only the enumerated correlation/final fields are optional.

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

The 25 gauges are:

```text
gatePending gateConnected
wikiConnections wikiReading wikiWriting wikiCursorActive
assemblyCount assemblyBytes
httpQueued nativeQueued wikiOutputQueued admissionQueued
codecLeases codecWaiting codecActive wikiSqlActive
mapQueued mapActive mapSqlActive mapConnections mapOperations
mapPendingMovement mapPendingPresence
externalInputBytes externalOutputBytes
```

For **every** gauge, derive exactly `peak` plus its first letter capitalized: `peakGatePending`, `peakCodecActive`, `peakAssemblyBytes`, `peakExternalOutputBytes`, and so on for all 25. The producer maintains these actual peaks synchronously on every relevant enqueue/promotion/reservation/release/resource mutation. Sparse receipt/final sample maxima cannot stand in for peaks between samples. Emit bounded initial, accepted wiki receipt/map preview and terminal final records, without an unbounded telemetry queue or samples array. Counts/peaks/backpressure cannot reset within an instance. Each peak must be at least its current gauge.

These are actual component counters, with overlap: they are not values to sum into a new memory cap. `externalInputBytes` observes `CodecPool`'s `AdmissionBudget.bytes`: retained raw backing, transfer-copy allowance and current/reserved codec state/result charges, with its separate 32 MiB cap. `assemblyBytes` observes retained assembly chunks plus the completed assembly copy, with the existing separate 32 MiB cap. `externalOutputBytes` observes the **one shared API `EditingOutputBudget.bytes`**, capped at 32 MiB, including immutable authority metadata continuations, HTTP/WS protected source preparation, parsed map input/context, payloads and outstanding WebSocket wire copies. Ownership transfers conservatively charge overlap; metadata ceasing to occupy the codec budget must remain charged in the common output budget. Both current values **and mutation-maintained peaks** must respect each distinct cap: a final zero cannot erase an earlier 33 MiB peak. This does not certify whole-process memory. No counter omission is interpreted as zero. Telemetry flags are development-only and telemetry's actual overhead stays inside the measurement.

## Integrity verdict and required checks

Queue evidence is `COMPLETE` only with every expected instance's valid terminal final, true actual drain, zero current resource gauges, no drops/backpressure/overflow, clean `drained` end reason and matching source/marker/raw bytes/hash/counts. The seal must agree with actual finals; seal-only true is insufficient. Missing inventory/initial/final/counter, cumulative reset, unexpected field, mismatch, collector error or timeout is `INCOMPLETE`, making the entire Gate 4 fail. COMPLETE telemetry can accompany a failed latency measurement and never clears its failures. Do not reinterpret missing per-row correlation as zero queue depth.

Run bounded protocol regressions in Docker before the real nine-case measurement: initial false plus a valid sealed final succeeds; initial true preflight, missing expected producer/final, stale source/measurement/finish hash, truncated/appended raw, wrong byte/record count, invalid UTF-8/duplicate JSON/NaN, symlink/FIFO/oversize, counter reset/drop/backpressure, non-drained final, current/peak budget overflow and collector timeout all fail. Prove short resource mutations survive in each recorded peak rather than computing peaks from sparse snapshots. Also run an honest partial/failed measurement: its finish counts and failures remain intact while the collector is allowed to drain.

Finally exercise the actual backend shutdown/collector EOF path and all nine real two-account browser cases on the exact candidate. Retain the original 2160 rows and all traces, metadata, sanitized inspection output, raw log, marker, seal and summary. Independent evaluation must inspect those current source pins and actual checks. Screenshots or a protocol-unit test alone do not establish collaboration, persistence, keyboard behavior, physical phone evidence or the four-gate completion.
