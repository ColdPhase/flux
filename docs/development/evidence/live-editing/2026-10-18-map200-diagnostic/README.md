# Single map 500 / drag 200 diagnostic — 2026-10-18

**FAIL: p95 215.768 ms exceeds the unchanged 200 ms target.** This is one
private diagnostic cohort, not the canonical nine-cohort Gate 4. The minimap
candidate was subsequently reverted from the same whole-issue PR #613; #228
remains open. No independent review was submitted for this author experiment.

Clean diagnostic source: `251d9d5e6b2772ef719a63c75e40da60337127d3`, based on
application `3bedcfd399aab85076b7f006adde9480288222cd`. Native SVG grouped marks
were the application candidate; this was not the earlier unrun Canvas diagnostic.
[Method](method.json) and [exact selection diff](diagnostic-selection.patch) show
that only `main` changes the planned/executed cohort selection. All other driver
functions remain AST-identical to the canonical driver. No timing, input,
observer, frame, trace, cadence, threshold or coverage change is made.

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh --latency /absolute/fresh/evidence/directory
```

The command ran from `.worktrees/228-svg-map200-diagnostic`. Original driver
SHA-256: `f331c1af49c8df43df6b257bc7c16795fedb5c3b102cfc11249282ef858df3ee`;
private selection-only driver:
`854ebf24f86d91108e73255a3a6544cf930641f06aaf0febee95b5285166f2b4`.

All 240 scheduled samples were captured over the original 60-second/250 ms
schedule after 30 warmups, with zero missing/error/timeout samples and no input
or socket errors. Pointer input remained continuous at the original requested
16 ms sleep and stayed down throughout. p50 was 175.825 ms; maximum 253.269 ms;
223 rows were superseded-covered with their actual measured latency retained.
The 30-sample local control p95 was 84.235 ms, **not subtracted**.
[Compact result](result.json), [full case](case-summary.json.gz) and
[overall summary](overall-summary.json.gz) retain the failed result; the latter's
successful summaries list is empty because the case failed its timing assertion.

| Included segment | p95 ms |
| --- | ---: |
| Input to covering publication | 122.973 |
| Publication to peer receipt | 76.246 |
| First peer receipt to render condition | 47.824 |
| Two RAF and recheck | 71.015 |

These overlapping distributions are not additive or a causal hotspot proof.
No whole-process CPU profile was added. Existing trace/publication evidence and
source inspection inform the next bounded product change; this failure does not
justify another unchanged full nine-cohort rerun.

[Actual runtime](runtime.json) records Chromium 151.0.7922.34, PostgreSQL 18.6,
Yjs 13.6.33, CodeMirror view 6.43.13 and exact images/dependencies. Host: Fedora,
Ryzen 9 7900X, 24 logical CPUs and 66,457,145,344 bytes memory. Both contexts were
visible/focused at 1440×900, DPR 1, CSS zoom 1, existing map Fit zoom .6, reduced
motion, healthy local Docker bridge. API/DB CPU, memory and PID limits were unset.
The sole agent heavy workload was this run. [Preflight](preflight.json) observed
host load 1.507 and Qwen 0% CPU; the single [midrun snapshot](midrun-host.json)
observed load 4.301 and Qwen 0%. They are not continuous or controlled comparisons;
no speedup over an earlier source is attributed to this change or host load.

The unchanged canonical collector correctly rejected the one-case finish marker:
`closed marker binding invalid`, **INCOMPLETE**, 371 records / 516,222 bytes.
[Collector result](collector-result.json), [planned cohort](planned.json),
[finish marker](measurement-finished.json) and [inventory](queue-inventory.json)
retain that outcome. Driver, collector and overall runner exited 1. There is no
complete nine-cohort seal, terminal resource/drain acceptance or clean producer
inspection claim for this diagnostic. [Runner log](runner.log.gz) retains the
Docker build/type/lint, invocation progress and actual exit report.

Full rows, publications, coverage, PNGs and screenshot-enabled owner/peer traces
remain outside Git at
`/home/hubert/flux-evidence/228-svg-map200-251d9d5e-latency`.
[Raw hashes](raw-manifest.json) identify every retained file. [Cleanup](cleanup.json)
confirms zero containers, volumes, networks and per-run image tags for the owned
project. User demo/Qwen services were preserved. The unused Canvas selection
branch was never executed. Product commit
`6ac818c6082ca7b035f07373bafb749f993ca19e` restores the exact original minimap
source/CSS from `dfe3d7f7`; the separate failed native raster observations stay
historical and are not waived. The next candidate still needs a real product fix,
focused timing evidence, then all original gates and consolidated independent
functional/visual acceptance before #228 can close.
