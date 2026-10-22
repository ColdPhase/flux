# Stable node inputs and fixed resize baseline — 2026-10-18

Author verification for existing #228 / Draft #613 passes on corrected source
`d919fa566e0639139c93aa3fffc8d71cabe37c92`. This receipt preserves both earlier
FAILs and the cancelled build. It is not independent review, a timing pass, or
whole-issue acceptance. The coordinator owns the next timing measurement.
The [contract](../2026-10-18-map-node-handlers.md) records both bounded changes
before their implementation.

## Source and observable correction

`d3a581d2` stabilizes ThoughtNode's seven host callbacks by ID and the existing
stable events ref. They invoke the latest committed root closure; keyboard and
resize resolve the current shown thought by ID. No render-time mutable thought
ref or custom comparator is used. Geometry, native versions, live attributes,
markup, CSS, minimap, wire, cadence and canonical measurement remain unchanged.
This removes repeated callback identities; no per-function timing saving was
established by the retained profile or these behavioral checks.

The new actual pointer control exposed a pre-existing product bug. Pointer resize
read `max(base.height, heights.get(id)) + totalDy` on every move. ResizeObserver
can measure the previous enlarged preview, causing total movement to be added
again. The expression is identical before callback stabilization at `7cbdd7fd`.
At controlled source `81e351fe`, native width 224 / height 232 / version 2 became
224 / 244 / version 3 by actual keyboard input. Public pre-pointer offsetHeight
was exactly 244, yet a real four-step 24-unit vertical drag persisted height 280
instead of 268 (width 272 was correct). This is a product FAIL, not a relaxed
geometry tolerance or an instrumentation-only problem.

`d919fa56` captures the native/measured minimum height once at pointer-down and
uses that fixed baseline plus total dy. Width, limits, leases, versions and other
gestures keep their existing calculation and authority. The identical final
live control now persists 272 × 268 / version 4. Enter opens the current native
text; typing then Escape leaves the exact native thought and version 4 unchanged.
The same correction applies to ordinary explicit-off maps.

The first `d3a581d2` FAIL saved 232 × 160 while its test expected 232 × 148.
The fixture's height was below intrinsic text height and the product also had
the dynamic-measurement feedback path. The initial report calling this solely
an intrinsic-height fixture defect was premature and is withdrawn. It remains a
FAIL without a fully isolated attribution. The final fixture independently
changes native width by 40 and height by 160, asserts current rendered height
before pointer input, preserves the changed width through keyboard resize, and
keeps exact pointer-size expectations. No product assertion threshold changed.

## Actual invocations

Counts are separate invocations, not unique regressions. A screenshot helper is
listed separately from maintained functional coverage.

| Actual source | Selection | Result |
| --- | --- | --- |
| `d3a581d2` | Chromium: test19 + selection50/200 + private cancel/own Undo | exit 1; 2 PASS, test19 FAIL; 3 invoked, 29.609 s |
| `2735c4f5` | Superseded WebKit three-method build | exit 143; cancelled during image export, before application runtime; zero tests invoked |
| `81e351fe` | Chromium test19, fresh-width/tall-height fixture | exit 1; product FAIL 1/1, 3.078 s |
| `d919fa56` | Chromium corrected test19 | exit 0; PASS 1/1, 3.413 s |
| `bb80320e` | WebKit maintained 32 + private screenshot helper 1 | exit 0; PASS 32/32 functional + 1/1 capture; 33 invoked, 177.577 s |
| `bb80320e` | Chromium remaining maintained 31 + screenshot helper 1 | exit 0; PASS 31/31 functional + 1/1 capture; 32 invoked, 134.187 s |
| `d919fa56` | Chromium explicit-off fixture | exit 0; PASS 3/3, 3.372 s |
| `d919fa56` | WebKit explicit-off fixture | exit 0; PASS 3/3, 6.986 s |

All completed final invocations have zero skips. Chromium's separate corrected
19 plus remaining 31 cover the same maintained 32 selected for WebKit; 19 was
not repeated in the composed Chromium run. Initial passes are not added again
as distinct final regressions. The cancelled intermediate WebKit build supplied
no passing or failing functional result.

The composed maintained journeys exercise real transport, trusted pointer and
touch, native IME, full 100k clipboard/caret editing, reconnect/reload, private
recovery, immutable Save/history, own Undo, authorization/conflicts, 50/200-item
movement, 201-item refusal, signed geometry, native edits during previews,
presence lifetime and actual server expiry. Native engine markers are retained
in the excerpts. These are bounded existing #228 journeys, not a full application
suite. Build/type checking and lint pass; lint reports nine existing warnings,
zero errors.

The explicit-off module retains its original setup, ordinary wiki and immediate
map Undo assertions. The extended map journey performs a real four-step pointer
resize, then reads the durable native graph. Both engines observe width/height
184 × 72 / version 1 → 232 × 96 / version 2 → Undo 184 × 72 / version 3.
Text and x/y remain unchanged. No-live-flash/request and browser-error assertions
still pass before and after the added interaction.

## Source binding and commands

All invocations start from clean commits. The private screenshot checkout is
`bb80320ee5e9d32efdd840b7d764679c357a88e0`, based on coordinator application
`f30c9910a21911a4287833a1c19faa12bb5d2851`. Its only addition is
`app/tests/ui/test_live_author_capture.py`, excluded from the product PR.
Application, dependency/configuration and maintained live/off test files are
byte-identical to `d919fa56`; the source comparisons and helper hash are in
[manifest.json](manifest.json). No source was changed during an active run.

Initial/final live selectors use `./scripts/check_live_editing.sh`,
`FLUX_UI_BROWSER=chromium` or `webkit`, and ports
`FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686`.
The final Chromium-only command selects
`test_live_editing.LiveEditingJourney.test_19_successive_peer_previews_keep_content_but_native_edits_refresh_it`.
[composed-selectors.json](composed-selectors.json) retains the exact 32 WebKit,
31 Chromium and separate author-capture selections, passed unchanged to the
maintained wrapper. Each composed run sets a fresh absolute
`FLUX_LIVE_EDITING_SHOTS` directory recorded in the manifest.

The ordinary commands, from clean `d919fa56`, are:

```sh
FLUX_LIVE_EDITING=off FLUX_UI_BROWSER=chromium FLUX_UI_PORT=18685 FLUX_UI_MAILPIT_PORT=18686 ./scripts/check_ui.sh test_live_editing_off
FLUX_LIVE_EDITING=off FLUX_UI_BROWSER=webkit FLUX_UI_PORT=18685 FLUX_UI_MAILPIT_PORT=18686 ./scripts/check_ui.sh test_live_editing_off
```

Sixteen author map/wiki screenshots per engine cover the helper's four viewports
and light/dark schemes using actual shared activity. They are author renders,
not independent visual acceptance or accessibility proof. Original PNGs and
capture metadata remain in the external directories; the coordinator retains
hashes and representative images separately. This receipt does not own that
visual report.

## Reused evidence and limits

The current change touches only SketchMap and the two UI test files. Server,
packages, Docker configuration and lockfile are unchanged from the owner-tested
`450f2430` producer-memo source. The copied owner [API receipt](compatible-api.exit.json)
and [actual two-API receipt](compatible-two-api.exit.json) retain their original
sources and commands; external log/inventory hashes are in the manifest. Those
checks were executed by the API owner, not rerun or independently reaccepted
here. The older [production promotion receipt](../2026-10-18-production-promotion/README.md)
remains separately pinned and does not pretend its pre-memo source ran current code.

The [presence/store receipt](../2026-10-18-map-presence/README.md) retains its
7/7 selected unit result and actual old-source negative control. Those store and
projection implementations are unchanged here; current composed cursor/lifetime
journeys pass again. The coordinator's [ordinary production Docs receipt](https://github.com/ColdPhase/flux/blob/b0deaa6f82146bdeb6ce4c2b820534f7a3cb2da6/docs/development/evidence/live-editing/2026-10-18-production-docs/README.md)
retains nine Docs methods per mode/engine and the original off fixtures at its
own exact sources. No Docs renderer, shared-text implementation, backend,
dependency or configuration changes were introduced by these node callbacks and
resize correction, so its Docs behavior evidence is reused without another
nine-method pass. The changed ordinary map path is tested here in both engines.

[manifest.json](manifest.json) binds every actual exit/count/source, full external
log hash/size, focused output excerpt, and actual runtime inventory. Seven
inventories capture running UI/API/DB container IDs and immutable image IDs before
cleanup (off runs additionally include the normal worker/mock services). No
credentials or disposable auth state are retained. The cancelled build has its
own explicit [record](cancelled.json); it created no application containers. Its
owned foundation image tag finished exporting after trap cleanup and was removed
explicitly after the exporter ended.

[cleanup.json](cleanup.json) verifies all eight owned Compose projects have zero
containers, volumes, networks and per-run tags. The heavy slot was released at
12:55 UTC before writing this docs-only receipt. User demo and Qwen services were
preserved. No new Docker, profile or latency run was performed after that release.
The unchanged 200 ms latency gate, complete canonical measurement, eligible
independent functional and visual review, and whole-issue acceptance remain the
coordinator's pending work.
