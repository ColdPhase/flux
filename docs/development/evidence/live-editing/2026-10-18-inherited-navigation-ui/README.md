# Inherited navigation: selected author UI checks — 2026-10-18

Both approved production-on lanes pass at application
`7af776c7dfd4403e3937c8ccd4b9723c7808d587`. This is bounded author verification
for existing #228 / Draft #613 after protected-main #603 and the sketch-access
correction, not independent review, full-application acceptance or latency proof.
No product or maintained test source changed during this batch.

| Actual lane | Maintained functional methods | Separate capture helper | Actual result |
| --- | --- | --- | --- |
| Chromium | 6/6; Origin12 internally also exercises WebKit | 1/1 | exit 0; 7 invocations, 72.399 s |
| WebKit | 5/5; Origin12 not repeated | 1/1 | exit 0; 6 invocations, 47.272 s |

Zero failures, errors or skips. Counts are invocations, not unique regressions:
the first five selectors run per engine; the sixth method internally launches
both engines and runs once. Docs setup01 precedes write02 in the same process.
The capture helper is excluded from functional counts. Build, type checking and
lint pass (lint retains nine existing warnings, zero errors).

The selected existing methods cover doc creation/preview/save and reference
Details, live text/own Undo/immutable Save/history, map route departure and
private recovery/own Undo, canonical map routes and native work Details on
computer/phone, and phone wiki/thread origin restoration with the draft and
reading position retained. Exact selectors and counts are in
[manifest.json](manifest.json). This does not rerun every #603 criterion or the
previous full 32 live methods, ordinary Docs suite, API suite or explicit-off
fixtures. Earlier results remain at their original source pins.

## Source and actual environment

The clean private checkout is
`21bbb7469132f2240f16fc346be1639b05a85813`, at
`.worktrees/228-inherited-ui-7af776c7`. Its only added file is the private capture
helper. That helper is byte-identical to original `bb80320e` except its
`APPLICATION_SOURCE` pin. It is not part of the product PR. Product, Docker,
scripts and dependency files match `7af776c7`; the latter's entire `app`, `docker`
and `scripts` trees match the API owner's `aade67ef` source. The manifest records
these exact comparisons. Prior API results were not executed again here.

Both runs use the unchanged normal `check_ui.sh` wrapper with live editing on,
not the diagnostic live overlay. The actual running
[Chromium inventory](chromium-runtime.json) and [WebKit inventory](webkit-runtime.json)
each record seven container IDs and immutable image IDs: UI, API, worker, DB,
Mailpit and the two local provider mocks. Each API has `NODE_ENV=production`,
`FLUX_LIVE_EDITING=on`, with development, telemetry and diagnostic-instance
selectors absent. The normal wrapper sets `FLUX_LIVE_EDITING_TEST=1`, so selected
live fixtures run rather than skip. No external model is used by these methods.

Docs and live fixtures assert/report their actual selected browser. The native
work-details fixture launches `getattr(playwright, FLUX_UI_BROWSER)`; Origin12
explicitly launches and iterates Chromium and WebKit regardless of that variable.
Capture metadata also records actual engine and browser version. No earlier
Chromium run is relabeled WebKit.

## Commands, renders and cleanup

The guarded external runner invoked the maintained wrapper serially:

```sh
python3 /home/hubert/flux-evidence/228-inherited-7af776c7/run.py chromium --execute
python3 /home/hubert/flux-evidence/228-inherited-7af776c7/run.py webkit --execute
```

It verifies the clean private source before execution. Both lanes call
`./scripts/check_ui.sh` with the exact listed selectors, `FLUX_LIVE_EDITING=on`,
`FLUX_UI_PORT=18685`, `FLUX_UI_MAILPIT_PORT=18686`, their selected browser and
separate absolute `FLUX_UI_SCREENSHOT_DIR` paths. The manifest preserves the full
argv/env and hashes of the external runner and plan. No source or wrapper was
modified while running; no failed or interrupted attempt occurred in this batch.
Compressed [Chromium log](chromium.log.gz) and [WebKit log](webkit.log.gz)
preserve original tooling and actual test output; full original log hashes and
external paths are recorded separately.

The same real map movement and shared unsaved wiki writing produce sixteen
helper screenshots per engine: 1440×900, 390×844, 820×1180 and 2560×1440, each
light/dark, both map/wiki. [Chromium metadata](chromium-capture-metadata.json)
and [WebKit metadata](webkit-capture-metadata.json) retain viewport, DPR, scale,
CSS zoom, palette, actual engine/version and application source. The manifest
retains all 32 original PNG hashes and external paths under
`/home/hubert/flux-evidence/228-inherited-7af776c7/`. These are author renders with
CSS viewport emulation, not a physical-device, accessibility, behavioral or
independent visual verdict. The coordinator owns the neutral visual brief and
later evaluation.

[Cleanup](cleanup.json), inspected at 14:15:24 UTC, verifies both owned Compose
projects have zero containers, volumes, networks and per-run image tags. The
heavy slot was released immediately afterwards; this receipt was completed
without Docker. User demo and Qwen services were preserved. Timing and eligible
independent functional/visual acceptance remain separate required work; this
receipt grants no approval or merge.
