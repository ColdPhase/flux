# Composed live editing timing — 2026-10-18

**Canonical FAIL, 7/9: map500/drag200 p95 208.690 ms and wiki100k editor
207.680 ms exceed the unchanged 200 ms limit.** All 2,160 scheduled observations
completed with zero missing/timeout/error samples and zero input/socket errors.
Whole #228 / Draft #613 remains unaccepted; independent review has not started.
No unchanged full-nine rerun followed this failure.

The prior selected map500/drag200 attempt passed its timing assertion at
191.902 ms. Its one-case collector correctly refused an incomplete cohort plan;
that result justified the subsequent original full-nine run, not Gate 4 acceptance.
Both actual outcomes remain here without selecting the favorable partial result.

| Cohort | Canonical p95 ms | Result |
| --- | ---: | --- |
| map-50-drag-1 | 118.299 | PASS |
| map-50-drag-50 | 136.406 | PASS |
| map-500-drag-1 | 116.978 | PASS |
| map-500-drag-200 | 208.690 | FAIL |
| map-500-drag-50 | 141.731 | PASS |
| wiki-10000-editor | 164.343 | PASS |
| wiki-10000-reader | 130.802 | PASS |
| wiki-100000-editor | 207.680 | FAIL |
| wiki-100000-reader | 152.021 | PASS |

Canonical clean source: `f30c9910a21911a4287833a1c19faa12bb5d2851`, frozen at
`.worktrees/228-final-latency-f30c9910`. The actual application contains production
availability/explicit-off recovery, Thought content memoization, independent
presence leaves, transaction-local project/private producer checks, stable input
callbacks and fixed resize start height. The original minimap, DOM/styles,
transport cadence, authority checks and budget caps remain intact.

Canonical driver SHA-256:
`f331c1af49c8df43df6b257bc7c16795fedb5c3b102cfc11249282ef858df3ee`.
Selected source: `f09b3b8bbe0098f0b6bc967925b93161afe69fc0`, application-identical
to f30, differing only in the [three cohort-selection lines](selected/selection.patch).
Its driver SHA-256 is
`854ebf24f86d91108e73255a3a6544cf930641f06aaf0febee95b5285166f2b4`.
All non-main driver functions are AST-identical. The earlier prepared `dd0bdaa5`
selection was never run; it was rebased before execution after the resize fix.

Each command used ports 18685/18686 and a fresh absolute evidence directory:

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh --latency /absolute/fresh/evidence/directory
```

Each cohort keeps 30 warmups and all 240 scheduled rows on its original 60 s /
250 ms schedule; continuous trusted input requests the original 16 ms sleep.
Every selected position/version, exact publication/server-named receipt, visible
geometry, two RAF and recheck, screenshot-enabled traces, error denominator and
200 ms threshold remain unchanged. Local render control is not subtracted.
[Selected result](selected/result.json) and [canonical result](canonical/result.json)
retain distributions, cadence, superseded counts and overlapping segment data.
Those segments are not additive or a causal allocation. The difference between
one selected run and a later full run is not a controlled code-only comparison.

The selected attempt writes all 240 rows, no behavioral/input/socket errors, and
p95 191.901796 ms. Its only final failure is actual-server-queue-evidence: the
unchanged collector refuses the one-case finish binding, INCOMPLETE, 366 records /
509,264 bytes. Runner, driver and collector exit 1. There is no complete seal,
terminal drain/resource acceptance or clean producer inspection claim for it.
Its local render control p95 is 78.879 ms, not subtracted.

The canonical attempt writes all 2,160 rows and its original nine-cohort marker.
Driver and runner exit 1 for the two failed timing assertions; collector exits 0.
[Collection receipt](canonical/collection.json) binds COMPLETE telemetry: 3,218
records / 4,510,083 bytes, zero drops/backpressure/budget violations, final drained,
and all 26 actual final resource gauges zero. The exact inventoried API process
has exit 0, not running/dead/OOM, with its original start time and actual finish;
no replacement lifecycle or successful stop command substitutes for this proof.
The [actual raw queue](canonical/actual-queue.jsonl.gz) and per-case correlation
sidecars are retained compressed. Unmatched row depths stay unavailable, never
invented zeros. Complete telemetry does not pass the failed latency gate.

The actual runtimes in each directory bind observed browser/dependency/database,
container/image identities, limits and source. Both use visible two-account
Chromium 151.0.7922.34, 1440×900, DPR1, CSS zoom1, reduced motion, healthy local
Docker networking and the existing map Fit zoom .6. API/DB CPU, memory and PID
limits were observed unset. The host has 24 logical Ryzen7900X CPUs and
66,457,145,344 bytes memory. Per-run preflight captures actual host/Qwen state;
the selected run also has one discrete later snapshot. No continuous host-load
or causal host comparison is claimed. Other agent heavy tests did not overlap.

Every directory retains full compressed overall/per-case summaries, runtime,
method, collection metadata, runner log, cleanup and hashes of all immutable raw
artifacts. Full rows, publications, coverage, PNGs and screenshot-enabled traces
remain outside Git at:

- `/home/hubert/flux-evidence/228-handlers-map200-f09b3b8b-latency`
- `/home/hubert/flux-evidence/228-final-f30c9910-latency`

Both owned projects have zero containers, volumes, networks and per-run image
tags after cleanup; the user's demo and Qwen were preserved. The
[composed functional receipt](../2026-10-18-map-node-input/README.md) separately
passes all 32 maintained live cases per engine and the three-method explicit-off
fixture per engine. [Author renders](../2026-10-18-composed-renders/README.md)
remain unaccepted visually. The next action is a bounded diagnosis of the actual
remaining cost, preserving this failed canonical result and every original
criterion. No new profile, method change, blind rerun, threshold waiver, partial
merge or production promotion is authorized by this report.
