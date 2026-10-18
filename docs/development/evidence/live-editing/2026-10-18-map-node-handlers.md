# Stable thought input handlers — 2026-10-18

Author implementation plan for existing #228 / Draft #613, agreed before code
at composed source `7cbdd7fd9d1007db65ea76144b4fcb1f71693481`.
The preceding selected 500/200 diagnostic at `1c121270` FAILS p95 208.803 ms;
240 rows have zero input/socket/sample errors. This does not accept Gate 4.

Every moved ThoughtNode currently creates seven fresh host callback identities
on each render. At 200 moved thoughts that repeats 1,400 callback allocations and
host-prop comparisons per render. Retained profiling identifies substantial React
reconciliation/host-update work, but does not isolate a causal saving for these
callbacks. No latency improvement is promised before the unchanged measurement.

Memoize those callbacks by stable thought ID and the existing stable events ref.
Each invocation reads `events.current`. Keyboard and resize events pass an ID;
the latest committed root closure resolves it from the current shown `byId`,
refusing an absent thought. Do not retain a captured old Thought or mutate a
render-time ref with uncommitted data. Keep native versions, selection, permission
checks, resize/keyboard semantics, DOM, styles, original minimap, dots, geometry,
cadence, transport and measurement unchanged. Use ordinary memoization, without
a custom comparator that could hide changed data.

Reuse existing successive-preview/native-update, 50/200 selection and private
cancel/own-Undo journeys in Chromium and WebKit. Extend the first journey with
actual persisted keyboard and pointer resize after a native body/height/version
change, plus Enter opening current text and Escape leaving it unchanged. This
tests stale-data behavior rather than mirroring callback identities. Run only
these affected journeys and required build/type/lint checks in Docker; no new
profile or unchanged full-nine-cohort run. Root owns the next focused timing
measurement and eventual integrated acceptance. This is author work, not an
independent review round, partial delivery or production promotion.

## Observed resize correction agreed before code

The real four-step pointer control at author `81e351fe` FAILS: native keyboard
width 224 / height 244 and actual pre-pointer height 244 pass, but total pointer
dy 24 persists height 280 rather than 268 (width 272 is correct). The renderer
reads its changing ResizeObserver height on every move and adds the total gesture
delta again. That expression also exists before the callback change at `7cbdd7fd`.
The earlier `d3a581d2` failure cannot be classified solely as an intrinsic-height
fixture error; both actual failures must be retained without that attribution.

Within this same #228 PR, capture the measured/native minimum resize height once
at pointer-down and use that fixed baseline plus total dy for every preview.
Preserve width calculation, native versions, bounds, permissions, cancellation,
commit/Undo, both live and explicit-off paths, and every other gesture. Keep the
exact fresh-dimension test19 assertion; do not loosen it. Reuse test19 plus the
existing 50/200 selection and private-cancel/own-Undo controls in WebKit; rerun
test19 alone in Chromium. Extend the existing explicit-off map/Undo journey with
the same real multistep persisted resize and run only its three-method fixture
in both engines, preserving the already passing ordinary Docs results. All
application tooling stays in isolated serial Docker stacks. The coordinator
accepts this bounded product correction before its implementation; it does not
waive the 200 ms timing gate or count as independent evaluation.
