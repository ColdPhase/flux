# Current access-path timing — 2026-10-18

**Canonical FAIL, 8/9: map500/drag200 p95 213.167416 ms exceeds the original
200 ms limit.** All 2,160 scheduled observations completed, with zero missing,
timeout, sample, input or socket errors. Whole #228 / Draft #613 remains
unaccepted. No independent review or neutral visual evaluation has started.

| Cohort | p95 ms | Result |
| --- | ---: | --- |
| map-50-drag-1 | 117.481419 | PASS |
| map-50-drag-50 | 128.478045 | PASS |
| map-500-drag-1 | 118.701714 | PASS |
| map-500-drag-50 | 144.112906 | PASS |
| map-500-drag-200 | 213.167416 | FAIL |
| wiki-10000-editor | 155.055545 | PASS |
| wiki-10000-reader | 142.070410 | PASS |
| wiki-100000-editor | 183.083472 | PASS |
| wiki-100000-reader | 173.048426 | PASS |

Clean source `7af776c7dfd4403e3937c8ccd4b9723c7808d587` includes the current
protected-main navigation, single current sketch-access evaluation and ordinary
roomless conflict repair. [Selected API evidence](../2026-10-18-roomless-conflicts-api/README.md)
passes 50/50 plus 1/1 on two actual APIs. The [current UI integration](../2026-10-18-inherited-navigation-ui/README.md)
passes six maintained Chromium methods, five WebKit methods and two separate
author captures. Its private helper is the only addition to the tested product.
Those checks are separate from performance and independent acceptance.

The original full-nine driver SHA-256 remains
`f331c1af49c8df43df6b257bc7c16795fedb5c3b102cfc11249282ef858df3ee`.
Every cohort retains 30 warmups, 240 observations over 60 s at 250 ms, continuous
trusted input with requested 16 ms sleep, all selected positions and versions,
matching publication/server receipt, geometry, two RAF and recheck, screenshots
and traces. The original minimap, DOM/styles, cadence and budgets remain intact.
No new CPU profile, local-control subtraction or selected-case retry preceded
this run. The command used a clean detached checkout and fresh output directory:

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh --latency \
  /home/hubert/flux-evidence/228-access-7af776c7-latency
```

[Result and segment distributions](result.json) retain every cohort. For the
failed cohort, input→covering publication p50/p95 is 84.741/136.664 ms,
publication→peer receipt 36.316/59.175 ms, covering receipt→painted
37.295/63.543 ms, first receipt→render condition 34.136/47.946 ms, and two RAF
plus recheck 50.389/81.867 ms. Local render control is 66.859/81.044 ms and is
not subtracted. These intervals overlap; their quantiles are not additive.
The [previous full run](../2026-10-18-composed-latency/README.md) remains FAIL
7/9. This later 8/9 result is not a controlled code-only speedup comparison and
does not establish a causal Wiki gain or fix the remaining map criterion.

[The actual collection](collector-result.json) is COMPLETE: 3,222 records /
4,515,567 bytes. [The seal](queue-seal.json) binds the full unmodified
[compressed raw stream](actual-queue.jsonl.gz), original finish marker and its
SHA-256 `0818ecb3e0bcbe14f3a160855ae05d8df2fa6b6d0c4a99600e135fce8f55c2bd`.
There are zero drops, backpressure or reported budget violations; final drained
is true and [all 26 actual final resource gauges](final-resources.json) are zero.
Unavailable per-row queue depths are not converted to zero. Startup runtime
metadata intentionally describes collection as not yet complete; the terminal
seal and collector result establish completion. Complete collection does not
pass the failed latency gate.

Runner/driver exit 1; collector exits 0. The [inventoried producer](producer-shutdown.json)
is actual CID `05b5eadf6e5a6749859467005968dc3034d1464207e0271d3663dcd3ae182ce4`,
started 14:17:18.694723132Z, finished 14:30:38.613750168Z, exit 0, not running,
dead or OOM-killed. [Cleanup](cleanup.json) verifies zero owned containers,
volumes, networks and image tags. The user's demo and Qwen services were
preserved; no other agent heavy workload overlapped. [Preflight](preflight.json)
is one observed host snapshot, not a continuous load measurement or explanation
of the result.

[Runtime](runtime.json) pins the actual Chromium 151.0.7922.34, dependencies,
PostgreSQL 18.6 and immutable image identities on the local Docker network.
The driver records 1440×900, DPR1, zoom1 and visible/reduced-motion contexts.
[Source compatibility](source-compatibility.json) verifies unchanged transport,
codec and Wiki recovery inputs against earlier evidence; it is not a fresh run
or independent acceptance. [The artifact manifest](external-artifact-sha256.json)
pins full rows, publications, correlations, coverage, PNGs, traces and logs at the
external directory above; the full overall summary is retained compressed here.

Next: use existing measurements/source to identify a concrete remaining map
cost, fix and verify it within this same whole issue and PR. Preserve this failed
result. No unchanged blind rerun, threshold waiver, partial merge or production
acceptance follows from it. Fresh neutral visual and consolidated independent
functional/source/method assessment remain pending behind the performance gate.
