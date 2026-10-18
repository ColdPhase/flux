# Map presence rendering, 2026-10-18

PR #611 addresses redundant rendering within #228. It does **not** complete the
parent's 200ms acceptance gate or enable the default-off live feature.

Own presence echoes now return without a view refresh. Each editor reuses its
current projected graph while confirmed state and immutable preview objects are
unchanged. New movement, native edits/removals and expiry recompute from confirmed
state; pending commands still apply separately. The cache retains one current
projection, with no shared cross-editor state.

## Executed checks

Frozen tested source: `00e383ed64346ff8bcd711459547f5f7ceb7d99f`.

- Docker build/typecheck/lint and projection tests **5/5**, no skips, 177ms
  ([raw log](unit-fixed.log.gz)). An initial f07f0f58 build rejected a non-inline
  useMemo initializer; the tested source uses the required inline initializer.
- Actual Chromium selected browser journeys **6/6**, 64.365s
  ([raw log](chromium.log.gz)); WebKit **6/6**, 85.124s
  ([raw log](webkit.log.gz)). No skips.
- The new browser regression holds a real stationary preview while at least two
  actual presence messages arrive. Its React DevTools/ResizeObserver observation
  stays unchanged: no Thought-body render or node re-observation. Real movement
  still renders. Other selected journeys cover native peer edits/private cancel/
  own undo, signed movement, natural lease expiry, 50/200-item drag and 201-item
  refusal. The pure cases additionally cover current native text/removal, expiry
  and independent editor caches.

Commands used the maintained Docker runners:

```sh
FLUX_TEST_PORT=18685 FLUX_TEST_MAILPIT_PORT=18686 ./scripts/check_application.sh \
  tests/app/live-map-projection.test.ts
```

For each `FLUX_UI_BROWSER=chromium` and `webkit`, with the same isolated ports:

```sh
./scripts/check_live_editing.sh \
  test_live_editing.LiveEditingJourney.test_16_a_peers_live_preview_renders_and_measures_only_the_moved_thought \
  test_live_map_projection.LiveMapProjectionJourney.test_remote_changes_during_drag_private_cancel_and_independent_own_undo \
  test_live_map_projection.LiveMapProjectionJourney.test_signed_positions_preview_and_land_for_the_peer \
  test_live_map_lease_expiry test_live_map_selection
```

## Full latency outcome: FAIL, retained without changing the gate

The unchanged driver ran all nine cohorts, each 30 warmups plus 240 scheduled
samples, with the original 200ms threshold. All **2160** rows are present. There
were no input, socket, timeout or missing-sample failures in this run. Overall
driver exit1, collector exit0: only map500/drag200 failed p95.

| Cohort | p95 ms | Result |
| --- | ---: | --- |
| map-50-drag-1 | 147.345 | PASS |
| map-50-drag-50 | 161.522 | PASS |
| map-500-drag-1 | 147.938 | PASS |
| map-500-drag-50 | 166.496 | PASS |
| map-500-drag-200 | 215.553 | FAIL |
| wiki-10000-editor | 158.865 | PASS |
| wiki-10000-reader | 142.324 | PASS |
| wiki-100000-editor | 185.785 | PASS |
| wiki-100000-reader | 164.081 | PASS |

The queue sealed COMPLETE with 3237 records, no drops/backpressure/budget violations,
zero active final gauges, and actual clean producer exit0 without OOM. This proves
capture completeness; it does not turn the failed timing gate into a pass.
[Full compressed summary](latency/summary.json.gz), [compact cases](latency/case-results.json),
[runtime](latency/runtime.json), [seal](latency/queue-seal.json) and
[actual shutdown](latency/producer-shutdown.json) preserve the observations.
Bulk rows, publications, coverage, screenshots and traces remain outside Git at
`/home/hubert/flux-evidence/228-map-performance-00e383ed-latency`; no public CI
artifact is claimed.

This is not a controlled latency A/B comparison with a24843d7's 208.063ms result.
The [preflight](preflight.json) records host load averages4.56/3.55/3.11 and an
additional unrelated user model server; its observed CPU was0% before the driver
and193.24% after four map cohorts (single Docker-stat observations, not a time
series). That server was preserved. The earlier a24843d7 preflight load was0.73.
All nine current p95 values and the changed environment are retained; no overall
latency improvement or code-only cause of the difference is asserted. The
previous map-lease refusal did not recur; that alone does not prove its root cause
fixed. The unchanged natural-expiry regression passed in both browsers.

#228 remains open for a measured <=200ms result, remaining integrated criteria and
independent acceptance before production enablement. This PR's bounded scope is
removal of demonstrated redundant renders; reviewers must keep the parent timing
failure explicit. No new issue splits or relaxed criteria were introduced.

## Current-head compatibility

After the measured source, branch integration adds protected-main PR #610
(calibration evidence, restart fixture/runner and Compose comment). The map source,
selected map/browser tests, latency driver/runner, lockfile and Dockerfile are
byte-identical to the tested source. The tests retain their original SHA; they are
not relabelled as executions of the later documentation head. The exact measured
commit remains in branch history. Required CI and independent review apply to the
current PR head.

[manifest.json](manifest.json) records original/retained hashes of captured files.
Logs use gzip to preserve exact captured bytes without trailing whitespace in the
text diff. All disposable test stacks were removed; ordinary user services remain.
