# Presence/producer candidate: selected 500/200 — 2026-10-18

**FAIL: p95 208.803 ms exceeds the unchanged 200 ms target.** This is author
measurement in whole-issue Draft #613, not independent review or Gate 4 acceptance.
No unchanged full nine-cohort run followed this failure; #228 remains open.

Clean selected source `1c12127070e6de9dbc3245e2c9cbb83975f41b49` is based on
`1a8c7281c3b64a39163e4db2ab1c11267055b668`. Application runtime inputs match
composed `7cbdd7fd9d1007db65ea76144b4fcb1f71693481`: only documentation,
two cursor-test harness fixes and the private cohort selection differ, as listed
in [method.json](method.json). The application contains the transaction-local
project/private producer memo and isolated cursor/People subscription. It retains
the original minimap, message cadence, authority fences and queue limits.

The [selection patch](diagnostic-selection.patch) changes only planned/executed
cohorts in `main`. All other driver functions remain AST-identical. Canonical
driver SHA-256 is `f331c1af49c8df43df6b257bc7c16795fedb5c3b102cfc11249282ef858df3ee`;
selected driver SHA-256 is
`854ebf24f86d91108e73255a3a6544cf930641f06aaf0febee95b5285166f2b4`.
Input, every selected position/version, publication/receipt identity, visible
geometry, two RAF plus recheck, screenshot-enabled traces, denominator and
200 ms threshold remain unchanged. Command from the private checkout:

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh --latency /absolute/fresh/evidence/directory
```

All 240 scheduled rows completed after 30 warmups on the original 60 s / 250 ms
schedule, with zero missing/error/timeout rows and zero input/socket errors.
The p50 is 151.367 ms; maximum 377.040 ms. All 229 superseded-covered samples
retain their actual timing. Continuous trusted pointer input remained down:
1,697 inputs with the original requested 16 ms sleep; 1,421 movement publications.
Local render control p95 83.263 ms is **not subtracted**.
[Result](result.json), [full case](case-summary.json.gz) and
[overall result](overall-summary.json.gz) preserve the failed timing assertion.

Overlapping segment p95 values are input→covering publication 129.274 ms,
publication→peer receipt 63.471 ms, first receipt→render condition 44.912 ms,
and two RAF/recheck 76.432 ms. They are not additive or a causal allocation.
The changed host observations do not establish a controlled speedup over earlier
candidates; no new CPU profile was run.

[Actual runtime](runtime.json) binds source, container/image identities,
dependencies, browser and PostgreSQL versions. The visible two-account Chromium
fixture uses 1440×900, DPR 1, CSS zoom 1, existing map Fit zoom .6, reduced motion
and local Docker networking. [Preflight](preflight.json) records the 24 logical
CPU / 66,457,145,344-byte Fedora host and preserved user services. The sole agent
heavy slot belonged to this run. [Midrun](midrun-host.json) observed load 2.785
and Qwen 0% CPU; these are discrete observations, not controlled comparisons.

The unchanged collector correctly refuses the one-case marker as
`closed marker binding invalid`: **INCOMPLETE**, 366 records / 509,263 bytes.
[Collection receipt](collection.json) retains actual planned/finish/inventory
and failed collector metadata. Driver, collector and runner exit 1. No complete
nine-cohort seal, terminal drain/resource acceptance or clean producer inspection
is claimed. [Runner log](runner.log.gz) retains build/type/lint and exits.

[Raw manifest](raw-manifest.json) hashes every retained row, publication, coverage,
trace, screenshot and log under
`/home/hubert/flux-evidence/228-subscription-map200-1c121270-latency`.
[Cleanup](cleanup.json) verifies zero owned containers, volumes, networks and
per-run tags. User demo and Qwen services were not changed or stopped. Subsequent
work is a bounded real product correction followed by focused timing, then the
original full gates and consolidated independent acceptance; this result cannot
close #228 or promote production.
