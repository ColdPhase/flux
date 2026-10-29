# Adaptive workspaces: small phones through 4K and ultrawide

**Final design, F-026 (2026-10-07):** apply this whole contract to the
[final design](final/README.md): its computer layout (sidebar, collapsed rail, one detail
panel) and its phone layout (tab bar, sheets) are the two drawn ends, and the five views
Conversation/Map/Tasks/Wiki/Agents adapt between them. Include Hubert's two agents plus
Marek's one, optional related task/source/PR context on wide panes, and a phone composition
that preserves usable stream/composer height. Consolidate repeated header/identity details
rather than shrinking text.

**Founder requirement:** F-015, Hubert, 2026-09-30; added to [#147 / PR #150](https://github.com/ColdPhase/flux/pull/150).
The application must use available space intelligently: a larger screen gives
more useful working context, while moving between phone, tablet and computer
feels like the same product. This applies to the [final design](final/README.md)
and [MOB-1–MOB-7](../product/mobile-pwa.md). It does not constitute implementation
or device evidence. Agents choose and independently review the concrete layouts.

Primary users are collaborators capturing ideas on a small Android phone,
returning on a laptop, and exploring linked work on a large desktop. The goal
is continuity with greater working capacity when space permits. Keep the final
design and human collaboration without AI.

## Required outcomes

| ID | Required behavior | Evidence needed |
| --- | --- | --- |
| ADAPT-1 | Layout responds to the available viewport and each work pane, including height, zoom, split view and input capabilities. It remains useful from 320 CSS px through 4K/ultrawide fixtures and between them. | Full fixture matrix and continuous resize/breakpoint-boundary checks; record actual viewport, browser zoom, device pixel ratio and system scaling separately. |
| ADAPT-2 | More space reveals useful authorized work: more readable rows/columns, a larger map, or related source/details beside the main task. Prose remains readable; users can keep a focused view. | Matched realistic narrow/laptop/wide scenarios showing a concrete information or interaction gain. Enlarged controls, long text lines or empty gutters alone do not satisfy this outcome. |
| ADAPT-3 | The same places, objects, vocabulary, audiences, primary actions and source relationships remain recognizable across layouts. Essential human workflows remain reachable on small screens. | Complete the same capture → conversation/source → map/work → return journey on phone, tablet and desktop; demonstrate the equivalent entry/action/back route. |
| ADAPT-4 | Resizing, rotation, keyboard appearance and pane transitions preserve active work and orientation. | In-place transitions retain unsent input, current object/selection, reading anchor and meaningful map view; no accidental save/send, lost focus, duplicate action or extra acknowledgment/AI run. |
| ADAPT-5 | The expanded layouts are readable, accessible and responsive to input at realistic data volumes. | Independent visual review plus running keyboard/touch, measured text enlargement, reflow, focus and performance evidence in emulated devices with recorded throttling; physical devices are optional (#266 item 10); unknown results stay unverified. |

## Use space deliberately

These are starting layout behaviors to compare, not fixed device categories or
mandatory pixel breakpoints. Select breakpoints when content/controls/pane minima
stop fitting. A window on a 4K screen can need the phone or tablet composition.

| Available working space | Expected use of it |
| --- | --- |
| Small phone / short landscape window | One main work surface; compact place/audience cue; essential actions visible. Navigation and related context open in a deliberate sheet/page with a clear close/back path. Compose fields and save/send remain reachable above the keyboard. |
| Wide phone / tablet / split view | Keep the main surface readable and offer a related-context pane only when both fit. Portrait, landscape, browser chrome and split view can select different arrangements without changing object meaning or the task. |
| Laptop / normal desktop | Stable place navigation, the primary workspace and useful contextual details when opened. Opening context must leave readable conversation, map/list or work content. |
| Large desktop / 4K / ultrawide | Use the extra area for more useful board columns/list rows, a larger usable canvas and an optional persistent/resizable source/details pane. A person can inspect a source alongside their work with fewer view changes. Keep context relevant to the selected object and allow it to be closed; do not populate every empty area with dashboards. |

Constrain reading measure **inside** the workspace, not by placing the entire
application in a narrow fixed-width column. Conversation bubbles retain readable
line lengths and own-right/others-left alignment; the surrounding pane can use
more width. Wiki prose, forms and long settings text keep comfortable measures.
Boards, tables, maps and relevant context can expand independently. Do not stretch
cards or globally increase font/button size merely to fill a large display.
A focused view on a large screen is a valid user choice. “More available” does
not mean every panel must open automatically.

Use existing object/detail/source surfaces first. A generic multi-window editor,
arbitrary dashboard builder or simultaneous unrelated project workspace is not
required by this refinement. If another composition proves useful, record its
bounded interaction contract before extending scope.

## Continuity and predictable transitions

- Preserve place names, work-view labels/order, object identity, audience cues,
  primary action wording and source/back semantics. Navigation may collapse or
  relocate; its meaning and destination must stay recognizable.
- Show which work surface is active. On phone, a readable task-status overview,
  labeled jump control or useful grouped list must expose active/blocked work;
  a clipped column edge is insufficient. Wide boards can show more columns.
- Maintain active selection, drafts and reading anchors when panes move between
  side-by-side and overlaid/full-surface modes. Restore the active context when
  space returns, respecting a person's explicit close/pin choice. Keep focus on
  the editing field or a logical visible replacement; no hidden focus target.
- Preserve the meaningful map center/selection when the viewport changes; do not
  auto-fit or relayout the graph on every resize. Lists keep the same hierarchy
  and selected item even if indentation or available metadata changes.
- Opening/closing context, resizing and navigating do not submit input, change
  read/acknowledgment semantics, invoke an agent or restart media. Keep #133's
  explicit snapshot acknowledgment and #134's personal outline semantics.
- Saved work and stable authorized object links remain the cross-device anchor.
  Private unsent drafts and local layout preferences retain their documented
  storage scope; do not imply that a device-local draft is synchronized. Any new
  draft-sync mechanism needs its own access/conflict contract. Verify reopening
  the same saved work on another device, not just shrinking one browser window.
- Keep composition changes calm, without breakpoint flicker or animated movement
  competing with reading. Honor reduced motion; “smooth” primarily means stable
  work and predictable transitions, not extra animation.

## Viewport and input verification matrix

Dimensions below are **CSS viewport pixels** at nominal 100% browser zoom. They
are test fixtures, not a catalogue of device hardware or required CSS breakpoints.
Pass the listed layout smoke checks; also test intermediate widths and both sides
of each implemented breakpoint. Record any genuine platform restriction rather
than hiding a core workflow because the display is small.

| Context | Required starting fixtures (width × height) |
| --- | --- |
| Small Android / phone reflow | 320×568, 360×640, 360×800 |
| Common / large phones | 390×844, 412×915, 430×932 |
| Short landscape phones | 640×360, 844×390 |
| Tablet / narrow split view | 600×960, 768×1024, 820×1180, 1024×768; reduce available width during split view |
| Small laptop / short desktop | 1024×768, 1280×720, 1280×800, 1366×768 |
| Standard / large desktop | 1440×900, 1920×1080, 2560×1440 |
| Ultrawide / very wide | 2560×1080, 3440×1440, 5120×1440 |
| 4K-sized workspace | 3840×2160; also emulate the CSS viewports a 4K display gives at 100%, 150% and 200% system scaling (3840×2160, 2560×1440 and 1920×1080 at device pixel ratio 1, 1.5 and 2) |
| Tall / portrait window | 900×1600 |

A real 4K display at larger OS scaling or browser zoom usually exposes a smaller
CSS workspace. Treat screen resolution, OS scaling, browser zoom, device pixel
ratio and viewport size as separate measurements. A 3840-CSS-pixel emulation is
wide-layout evidence, not proof of a physical 4K device or readable physical size.

For the matrix, use a deterministic realistic fixture with long names, dense
conversation, linked sources, deep map relations, active and blocked work, wiki
text and open context. Cover loading/empty/error/restricted states in the changed
components; include light and dark themes where affected.
Run layout/overflow/reachability smoke checks across the full matrix; use a
focused set of matched whole-view captures for independent visual review at
320/390, tablet, laptop, 1920, 3440 and 3840 widths. Reuse #134/#149 evidence
where it still covers the final combined head; do not run a huge Cartesian product
of every state and dimension without a reason.

Separately test:

- Live resize and side-pane resizing, including primary-pane/container widths
  smaller than the whole window, rotation, split view, virtual keyboard, safe
  areas and short-height sticky headers/footers. Ordinary page content reflows;
  any necessary two-dimensional map/table scroll is local with usable controls
  and accessible alternatives. No accidental page-wide horizontal scrolling.
- Browser zoom at 200% and 400%/equivalent 320-CSS-pixel reflow, plus actual 200%
  text enlargement. Confirm text really grew; a changed root size that leaves
  fixed-pixel text unchanged is not evidence. Respect applicable two-dimensional
  content exceptions without exempting surrounding navigation/forms/actions.
- Keyboard focus and reading order after composition changes, modal containment,
  screen-reader names, touch/coarse input, mouse/trackpad and mixed touch/keyboard
  devices. Viewport width alone does not establish whether hover is available.
  Preserve visible focus and the existing 44 CSS px primary touch target goal.
- No loss/duplication of pending edits during an interrupted resize/navigation,
  revocation and reconnect. Device-to-device continuation uses real saved data
  and current authorization. Do not turn a resize into new persistence semantics.
- Input/scroll/resize latency, long-list/map behavior, request count and memory at
  recorded dataset sizes under recorded CPU/network throttling that approximates
  low-end Android, and on the desktop host.
  At task kickoff, before optimization, record numeric budgets, dataset and
  hardware/browser baseline with independent agreement; a bigger viewport is not permission for unbounded
  rendering, fetching or reflow. Missing performance evidence stays open.
  The agreed budgets are in [Agreed performance budgets](#agreed-performance-budgets).

Run substantial matrix/interaction checks in Docker with bounded reusable
fixtures; keep PR Actions light. Supported-browser emulation and the documented
installation/OS-push requirements remain under #20. Large screens use the 4K and
ultrawide fixtures above, including scaling/readability and a window resize.
Founder direction #266 item 10, 2026-10-05: real phone, tablet, 4K or ultrawide
hardware is optional extra evidence, never a gate.

## Agreed performance budgets

**Agreed 2026-10-29** for #151 AC-4 and #155 AC-4 by claude-hubert under the founders'
[delegation](../product/autonomy.md), written down before any optimisation for them; the "measured" columns are the
unoptimised baseline of `main` `3f0311a26`. **Independent agreement is still owed**: the review of PR #714 found the
first version of this table loosened two frame-gap budgets to pass; this version restores them. A budget changes only
with new measurements and a review. The opt-in harness
[`motion_performance.py`](../../app/tests/ui/motion_performance.py) fails when a p95 exceeds its budget (a miss it lists
in `KNOWN_MISSES`, with its issue and a ceiling for its p95, is reported as open, fails the run above that ceiling and
fails it once it stops missing), and
`tests/test_adaptive_budgets.py` fails when the harness constants and this table differ.

- **Dataset.** Two accounts in a workspace; three restricted projects, each with 60 conversation roots and 40
  tasks; a 40-reply thread in the first. All created through the public API. The 1000-task, 100-fetched-items
  budgets of the [native-work kickoff](../development/performance/2026-10-01-native-work.md) stay as they were.
- **Hardware and browser.** This host: AMD Ryzen 9 7900X (24 threads), Fedora 42, Linux 6.19; Chromium
  151.0.7922.34 (headless, Playwright 1.62.0 in Docker); API, database and worker uncapped on the same host, which
  other agents' Docker suites shared (load average 5 to 32 over the three runs). Device pixel ratio 1, loopback network.
- **Profiles.** *Desktop*: 1280×800, mouse. *Phone*: 390×844, touch, a mobile viewport and Chromium's 4× CPU
  throttling (`Emulation.setCPUThrottlingRate`), an emulation proxy for a slow phone, not a device. The phone changes view through
  its title menu (#341). Reduced motion (desktop) uses the desktop budgets.
- **Method.** The page's own clock times each trusted click, tap or key from the event's `timeStamp` to a
  double-`requestAnimationFrame` following-frame proxy (not a raster claim). 30 warm-ups, then at least 200
  actions over at least 60 s. A layout switch (`set_viewport_size`) runs from the resize event to the frame after
  the last change of the shell's landmarks, once they have stayed put for 150 ms: 15 warm-ups, then 100 in each
  direction. Desktop switches go between 1280×800 and 390×844, 820×1180 and 3840×2160; phone switches between
  390×844 and 844×390 (rotation) and 820×1180 (unfolded). A frame time is a `requestAnimationFrame` timestamp,
  quantised to the 16.7 ms frame (three frames read 50.0 to 50.1 ms), so a p95 within 0.5 ms of its budget passes.

| Key | What it measures (p95) | Desktop | Phone | Desktop measured | Phone measured |
| --- | --- | --- | --- | --- | --- |
| `selectionFeedback` | click or tap on a work tab, project or phone view to its first marked frame, ms | 150 | 300 | 82 | 113 |
| `motionEnd` | the same to the motion finishing (the highlight, or the phone menu leaving), ms | 370 | 420 | 283 | 330 |
| `selectionCommitted` | the same to the route showing the choice, ms | 200 | 420 | 168 | 335 |
| `keyInput` | a key in the reply field, typing presence live, to its paint, ms | 100 | 200 | 29 | 43 |
| `frameGap` | worst gap between two frames from the action to its committed paint, ms | 50 | 100 | 50 | **133** |
| `layoutSwitch` | a resize or rotation to the settled layout, ms | 100 | 250 | 62 | 196 |
| `layoutGap` | worst gap between two frames during a layout switch, ms | 100 | 250 | 67 | 200 |
| `layoutRequests` | API reads one layout switch causes, count | 3 | 3 | 2 | 3 |
| `heapGrowthMB` | JavaScript heap growth after a forced collection over one segment of a profile (a ceiling, not a p95), MB | 20 | 20 | 4.9 | 5.8 |

"Measured" is the worst p95 of the full runs of the harness on 2026-10-29: three for the first seven rows (the
third, 1011 s, ran with these budgets and met every one but the miss below), two for the request count and heap, which
were added after the first. The summary is in [the closeout report](../development/evidence/151-155-closeout/README.md).

**Known miss, not a budget change.** The phone's `frameGap` is 133 ms at p95 in the first two runs and 117 in the
third (a lighter host), against 100: [#716](https://github.com/ColdPhase/flux/issues/716). A long-animation-frame
profile of 80 view changes shows where it goes: 79 of 80 phone view changes contain a long frame (median 79 ms,
p95 147 ms); the time is the React scheduler's task running script, 38% of it forced synchronous style and layout, and
the response handler (25.7 ms each); style and layout outside script are about 2 ms. The harness reports the miss as
open and lists it in `KNOWN_MISSES` with a ceiling of **150 ms** (nine frames, just above the worst of the three runs):
a p95 above that fails the run, so the exemption cannot hide a further regression.

**Basis, row by row.** Rule: a budget that existed in the harness or the kickoff before this PR is not loosened. A
new one, or one tightened from a looser inherited ceiling, is the platform bound where one exists and else the worst
measured p95 plus about a quarter (a quarter is as tight as the two-fold swing of some p95s between runs on a shared host
allows). Sources, read 2026-10-29: [RAIL](https://web.dev/articles/rail) (page updated 2020-06-10: "complete a
transition initiated by user input within 100 ms"; process input events within 50 ms),
[MDN long tasks](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming) ("any uninterrupted period
where the main UI thread is busy for 50ms or longer") and [INP](https://web.dev/articles/inp) (updated 2025-09-02:
"good" is 200 ms or less at the 75th percentile of field loads). These are vendor guidance; applying them to a
view change or a resize is this page's inference.

- `selectionFeedback`, `keyInput`: inherited unchanged from the #151 kickoff (click to selected-state paint, keydown to
  input paint; 150/300 and 100/200 ms). Measured at 55% or less of them, so not tightened here.
- `motionEnd`: feedback plus the longest motion on the surface: unchanged on the computer (150 + the 220 ms highlight);
  the phone's harness value was 300 + 220, now 300 + the 120 ms menu exit, so tighter.
- `selectionCommitted`: was 2000/4000 (the native-work kickoff's fresh-navigation budgets, which stay with their own
  harness), so this is a tightening to this dataset. Computer: INP "good", 200 ms, and measured 168 is within 1.2× of
  it. Phone: 1.25× the measured 335. INP's 200 ms is not met by this emulated phone (335 ms, its "needs improvement"
  band): an improvement target, also in #716.
- `frameGap`: **unchanged from the harness before this PR**, 50 and 100 ms (MDN's long-task and RAIL's 100 ms). The
  computer's measured 50 ms is three frames, at its bound. The phone misses it, above.
- `layoutSwitch`, `layoutGap` (new): computer 100 ms, RAIL's transition goal; measured 62 and 67 ms in the second run
  and 31 and 33 ms in the first, so a tighter bound would flake. Phone 250 ms, 1.25× the measured 196 and 200 ms.
- `layoutRequests` (new): the p95 of a discrete count was 2 on the computer and up to 3 on the phone; the budget is 3.
  It counts the two small agent lists that a swapped shell reads when it mounts.
- `heapGrowthMB` (new): a leak ceiling, not a bound a user feels: about 3.5× the measured 5 to 6 MB over roughly 900 actions,
  which allows route chunks to load once and flags a heap that grows by about 20 KB per action.

**Observed, not budgeted.**

- A layout switch across a shell swap (computer, tablet, phone) reads the working agents and assistant runs again,
  one or two requests; growing the window within the same shell reads nothing at the median. At most 5 in 100
  switches (the p95 is 2) coincide with about 20 reads (project, people, materials); they also happen when the window only
  grows, so they do not scale with its size. The cause is not investigated.
- The computer's project switch has a long frame in about 30% to 45% of switches (54 to 66 ms), the Tasks tab in 7%.
- WebKit has no CPU throttling command, so these budgets are Chromium only.

**Not covered.** Physical phones, tablets and 4K or ultrawide displays (optional, founder direction #266 item
10); network throttling; map pan, zoom and long-list scroll latency (list scroll is in the native-work kickoff);
memory other than the JavaScript heap; other hosts. Unknown stays unverified.

## Delivery and evidence status

**Proposed amendment, 2026-10-05 (#151 AC-1):** the current pane and
breakpoint rules, input modes, readable measure, map camera rule and surface mapping are
recorded in [adaptive layout rules](adaptive-layout-rules.md). It uses emulated viewports only. It was
independently evaluated on 2026-10-29 (see that page); the performance budgets were agreed the same day.

Implement through [#151](https://github.com/ColdPhase/flux/issues/151), with the
the final design's shell issues (#340, #341, #344). The final design (#336) is the integrated
UX acceptance record and must include ADAPT-1–ADAPT-5; #20 retains mobile acceptance.
Coordinate shared shell/token/map work with #338 and #349; one writer per
branch. Split implementation by independently verifiable surfaces if useful,
retaining all outcomes and final combined-head checks. This document adds a
requirement and a design/test brief; no new responsive implementation or hardware
verification was performed in this documentation change.

The separate `adaptive_contract_review` agent accepted this planning contract
and the #151 criteria on 2026-09-30 without material findings;
[historical review record](https://github.com/ColdPhase/flux/blob/c114bacec9d1ea2030b55a5a846fbe0547bf8d20/docs/design/references/studio-v11.1/inspection/contract-review.md#adaptive-workspace-extension--f-015).
This does not replace independent implementation or eligible GitHub review.

## Primary guidance checked 2026-09-30

- [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html): equivalent
  320 CSS px width for vertically scrolling content, with specified exceptions
  for content requiring two dimensions. Browser viewport and hardware resolution
  can differ. This grounds reflow checks, not our chosen wide-screen composition.
- [W3C Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html):
  text enlargement up to 200% without loss of content/functionality, subject to
  its stated exceptions. A screenshot alone cannot certify this.
- [MDN Using media queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Using):
  media queries can consider viewport dimensions and interaction features such
  as hover/pointer. Layout must be tested with available input, not a guessed
  device category.

The pane compositions, fixture set and continuity rules above are Flux design
requirements/inferences from the user's direction and existing contracts, not
claims that these sources endorse a particular UI or that users were studied.
