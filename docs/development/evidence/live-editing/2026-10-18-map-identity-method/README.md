# Map identity observer calibration, 2026-10-18

This is author verification of the bounded
[candidate method record](../../../live-editing-verification.md#candidate-identity-read-method-change-2026-10-18-228--613).
That record was committed at `3bf87cdfdfd78077c6935b0d9bfcacf25faffa05`
before implementation. The tested implementation/test source is
`dfe3d7f78514466a86ce164e98a15f293b7b0c1c`.

Only the repeated post-trusted-pointer identity read changes: a fresh
`page.evaluate` query requires exactly one connected current canvas, then returns
the same gesture ID, generation, numeric sequence and document visibility.
The existing invalid-identity refusal remains in the producer. A source AST
comparison confirmed that restoring that one expression makes `map_drag`
identical; every other driver function is unchanged. No peer observer, application
code, cadence, selected geometry, trace flag, count, deadline, threshold, collector
or acceptance rule changed.

## Actual checks

| Execution | Outcome | Test time |
| --- | --- | ---: |
| Chromium, four selected browser controls | PASS, 4/4, no errors/failures/skips | 49.432s |
| WebKit, same four controls | PASS, 4/4, no errors/failures/skips | 62.817s |
| Existing stdlib driver/queue/default-off checks | PASS, 7/7 | 0.033s |

The maintained Docker image build includes application build, typecheck and lint;
they passed. Python compilation, driver AST comparison, `git diff --check` and
agent foundation/link/evidence-size checks passed.

The new browser control compares old/new identities four times across two actual
authorized map instances, using trusted pointer input and real peer delivery.
Each next pointer input advances the observed sequence. Actual navigation to the
replacement map yields its new generation and gesture, rather than cached fields.
Both strict methods reject a duplicate canvas shell; this explicit invalid-DOM
calibration clones only the real shell, creates no editor and injects no transport.
Actual navigation away removes the map and the new read refuses it immediately.
The other selected controls retain natural lease-expiry/private recovery,
50/200-item trusted drag and native commit, and 201-item refusal.

Exact commands/selectors are in [commands.json](commands.json). Each engine ran:

```sh
FLUX_UI_BROWSER=chromium FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh \
  test_live_editing.LiveEditingJourney.test_20_map_input_identity_matches_locator_and_refuses_invalid_canvas \
  test_live_map_lease_expiry test_live_map_selection
```

The second run uses `FLUX_UI_BROWSER=webkit`. Logs:
[Chromium](chromium.log.gz), [WebKit](webkit.log.gz).
[Source/check hashes](source-and-checks.json), [results](results.json), actual
[Chromium](chromium-runtime.json)/[WebKit](webkit-runtime.json) container/image
inventories and [manifest](manifest.json) retain their tested source pin.
Original logs remain at `/home/hubert/flux-evidence/228-identity-dfe3d7f7-{chromium,webkit}.log`.

## Diagnostic evidence retained separately

The [diagnosis](diagnostic/diagnosis.json),
[timed CPU partition](diagnostic/timed-profile-analysis.json),
[source mapping and timed trace counts](diagnostic/timed-source-mapping.json),
[whole-window metrics](diagnostic/whole-window-metrics.json),
[source equivalence/command](diagnostic/source.json) and
[private instrumentation patch](diagnostic/instrumentation.patch.gz) preserve the
one non-acceptance diagnostic at `28ad6b43e91cea907b1bf22c0de343265c91387f`.
Its application source matches `8ba5f87a`; the private instrumentation is absent
from the canonical driver. Diagnostic metadata/patches total 55,610 bytes.

That profile starts after all 200 selection clicks. Local controls are separate
from the exact scheduled 60 seconds. The owner has 1,279 repeated attached-canvas
waits in that window, p95 17.654ms, with 7.862s sampled in Playwright `computeBox`.
These protocol/sample times overlap application work and cannot be subtracted
from latency. The diagnostic's unchanged collector rejects the one-case marker:
runner/driver/collector exit 1, no complete acceptance seal. Its 240 rows and
profiles are diagnostic only. Large raw profiles/traces/public assets remain
outside Git at `/home/hubert/flux-evidence/228-map-body-profile-28ad6b43`;
[raw hashes](diagnostic/raw-manifest.json) include both trace/profile pairs.
No public artifact upload is claimed.

## Subsequent full canonical run: FAIL

The changed canonical driver ran once from clean frozen
`dfe3d7f78514466a86ce164e98a15f293b7b0c1c`, the same source as the observer
controls above. The driver SHA-256 is
`f331c1af49c8df43df6b257bc7c16795fedb5c3b102cfc11249282ef858df3ee`;
the identity helper is separately pinned in [case results](latency/case-results.json).
The [preflight](latency/preflight.json) confirms unchanged application, Docker,
runner and lockfile inputs since `8ba5f87a`, and identical `LiveFixture` AST.
No private profiling instrumentation is in this canonical driver.

All nine cohorts finished, retaining **2160 scheduled rows**, with the original
30 warmups and 240 rows per cohort. There were no input/socket errors, missing
rows, timeouts or unexecuted cohorts. Eight cohorts meet the unchanged 200ms
nearest-rank p95 gate; moving 200 of 500 Thoughts still fails it.

| Cohort | p95, ms | Gate |
| --- | ---: | --- |
| Map 50, move 1 | 132.091 | PASS |
| Map 50, move 50 | 155.908 | PASS |
| Map 500, move 1 | 131.097 | PASS |
| Map 500, move 50 | 160.806 | PASS |
| Map 500, move 200 | **220.806** | **FAIL** |
| Wiki 10k, editor | 162.127 | PASS |
| Wiki 10k, reader | 153.168 | PASS |
| Wiki 100k, editor | 183.454 | PASS |
| Wiki 100k, reader | 172.364 | PASS |

The [case results](latency/case-results.json) include every planned cohort,
including the [failed cohort's full summary](latency/map-500-drag-200-summary.json.gz).
The [original overall summary](latency/summary.json.gz) and
[runner log](latency/runner.log.gz) preserve driver exit 1 and collector exit 0.
Every original per-case summary is also retained compressed in `latency/`.

Actual queue capture is **COMPLETE, 3231 records**, with no drops, backpressure or
resource-budget violations. All 26 terminal resource gauges are zero; the producer
exited normally (exit 0, no OOM). Completion is established by the
[seal](latency/queue-seal.json), [collector result](latency/collector-result.json),
[finish marker](latency/measurement-finished.json) and
[producer shutdown](latency/producer-shutdown.json). The runtime descriptor's
provisional `complete: false` does not override that final seal.
[Runtime identity](latency/runtime.json), [raw/retained hashes](latency/manifest.json)
and [cleanup](latency/cleanup.json) retain the exact candidate and actual project.
Original rows, traces and queue remain outside Git at
`/home/hubert/flux-evidence/228-identity-dfe3d7f7-latency`.

The actual map200 owner traces also show the intended observer change:
[1706 attached-canvas waits in the original-method run, zero in this run, and
2072 strict direct identity evaluations](latency/trace-identity-read-comparison.json).
These are whole-cohort counts, including controls/warmups, not timed CPU samples
or a latency improvement estimate. The original 230.479ms failure is unchanged.
This run used a different method and a shared host: preflight observed load 1.824
and Qwen at 0% CPU; a [single snapshot after eight cohorts](latency/midrun-host.json)
observed load 5.600 and Qwen at 193.24%. These are not a continuous series or a
causal attribution. No controlled application-only timing comparison is claimed.

## Remaining acceptance and cleanup

The previous [body-render checks and canonical failure](../2026-10-18-map-body-performance/README.md)
retain their original `8ba5f87a` pin: 10/10 browser checks in each engine, then
the unchanged-method full canonical run failed map500/drag200 at 230.479ms.
The observer controls did not repeat those body checks. The subsequent full run
above still fails the original gate. The bounded content and observer changes
need independent source/method evaluation; they do not complete #228. Its final
integrated AC-1–AC-5/Gate-1–Gate-4 and neutral visual/functional acceptance remain
required. The feature stays default-off. No further unchanged full rerun or
speculative application change is justified by this report alone.

[Cleanup](cleanup.json) confirms no containers, volumes or networks remain for
either owned project, and ports 18685/18686 are free. Each runner removed its two
images. The separate canonical project is also [cleaned](latency/cleanup.json).
User demo/Qwen services and shared build cache were preserved. Later
evidence-only commits do not change the tested application, helper or driver.
