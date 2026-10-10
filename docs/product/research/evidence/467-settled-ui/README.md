# Settled Connect setup evidence — 2026-10-11

This is a bounded capture correction following the independent visual report for
production source `a9046f12e58f98de0ec86493dfba12d082d3afae`. Application source is
unchanged. The browser fixture now waits for fonts, flushes style/media changes
through animation frames, and waits for finite animations to finish naturally;
it does not cancel motion, change opacity, or override the theme.

Actual rendered diagnostics found the inherited `rise` animation running on
`.auth__col` before Chromium light captures: ancestor opacity was 0.658145 at
390 CSS px and 0.657608 at 1440 CSS px. WebKit light was also still animating
(0.986394 / 0.984251). Settled ancestor opacity was 1 for every captured setup.
The heading and explanation then matched the current `--t1` / `--t3` colors.
The dark Reload control was enabled with no disabled/busy attribute and normal
`rgb(240, 240, 240)` text in both browsers. Persistent Reload dimming was not
reproduced. The exact cause of the older dark WebKit raster is unproved; source
color transitions make capture timing plausible, not established for that frame.

The focused setup recovery test ran in isolated Docker on ports 19820/19821 and
networks 10.198.100/101/102, with Chromium and WebKit at 1440×900 / scale 1 and
390×844 / scale 3. Result: 1/1 pass, exit 0; Docker build, type check and lint
passed (three existing warnings). The first diagnostic attempt failed because
serialized evaluation referred to a transpiler helper; it was corrected before
the passing rerun, and is not counted as a pass. No native client probe ran.

The retained test still checks pending status, lost-authorization refresh,
permissions Off, revoke/history persistence, keyboard/touch, 200% text and
horizontal overflow. Extra full-flow and initial viewport frames supply the
connection/agent identity omitted from focused slices. These checks and rasters
do not complete PC4, native activation, public managed-binding acceptance,
installer/platform or full #460/#152/#160 outcomes. Fresh independent visual
review remains required. PR #467 remains draft.

Run only the focused case with the checked-in Docker E2E configuration:
`tsx --test --test-name-pattern='actual owner setup stays pending' tests/app/e2e/mcp-permission-controls.e2e.ts`
inside the E2E container, with `FLUX_E2E_EVIDENCE_DIR` set to a retained volume
path. Review screenshots are published in an immutable directory named for the
pushed checkpoint; its neutral manifest contains source pins, hashes, dimensions,
viewport, scale and frame purpose only. Diagnostic states and behavioral verdicts
are separate from the neutral brief. All containers, volumes, networks, tagged
images and temporary keys belonging to this run were removed.
