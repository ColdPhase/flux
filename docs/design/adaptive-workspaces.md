# Adaptive workspaces: small phones through 4K and ultrawide

**Later F-017 extension:** apply this whole contract to Studio 11.6 and its
Agents tab as well as Conversation/Map/Tasks/Wiki. Include Hubert's two agents
plus Marek's one, optional related task/source/PR context on wide panes, and a
phone composition that preserves usable stream/composer height. Consolidate
repeated header/identity details rather than shrinking text. See
[UI116-1–UI116-5](studio-v11.6.md) and the
[11.6 visual findings](references/studio-v11.6/inspection/visual-review.md).

**Founder requirement:** F-015, Hubert, 2026-09-30; added to [#147 / PR #150](https://github.com/ColdPhase/flux/pull/150).
The application must use available space intelligently: a larger screen gives
more useful working context, while moving between phone, tablet and computer
feels like the same product. This applies to the current [Studio 11.6](studio-v11.6.md)
and [MOB-1–MOB-7](../product/mobile-pwa.md). It does not constitute implementation
or device evidence. Agents choose and independently review the concrete layouts.

Primary users are collaborators capturing ideas on a small Android phone,
returning on a laptop, and exploring linked work on a large desktop. The goal
is continuity with greater working capacity when space permits. Keep the calm
Studio direction and human collaboration without AI.

## Required outcomes

| ID | Required behavior | Evidence needed |
| --- | --- | --- |
| ADAPT-1 | Layout responds to the available viewport and each work pane, including height, zoom, split view and input capabilities. It remains useful from 320 CSS px through 4K/ultrawide fixtures and between them. | Full fixture matrix and continuous resize/breakpoint-boundary checks; record actual viewport, browser zoom, device pixel ratio and system scaling separately. |
| ADAPT-2 | More space reveals useful authorized work: more readable rows/columns, a larger map, or related source/details beside the main task. Prose remains readable; users can keep a focused view. | Matched realistic narrow/laptop/wide scenarios showing a concrete information or interaction gain. Enlarged controls, long text lines or empty gutters alone do not satisfy this outcome. |
| ADAPT-3 | The same places, objects, vocabulary, audiences, primary actions and source relationships remain recognizable across layouts. Essential human workflows remain reachable on small screens. | Complete the same capture → conversation/source → map/work → return journey on phone, tablet and desktop; demonstrate the equivalent entry/action/back route. |
| ADAPT-4 | Resizing, rotation, keyboard appearance and pane transitions preserve active work and orientation. | In-place transitions retain unsent input, current object/selection, reading anchor and meaningful map view; no accidental save/send, lost focus, duplicate action or extra acknowledgment/AI run. |
| ADAPT-5 | The expanded layouts are readable, accessible and responsive to input at realistic data volumes. | Independent visual review plus running keyboard/touch, measured text enlargement, reflow, focus, performance and real-device evidence; unknown results stay unverified. |

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
| 4K-sized workspace | 3840×2160; also test a real 4K display at available 100%, 150% and 200% system scaling, recording its actual CSS viewport |
| Tall / portrait window | 900×1600 |

A real 4K display at larger OS scaling or browser zoom usually exposes a smaller
CSS workspace. Treat screen resolution, OS scaling, browser zoom, device pixel
ratio and viewport size as separate measurements. A 3840-CSS-pixel emulation is
wide-layout evidence, not proof of a physical 4K device or readable physical size.

For the matrix, use a deterministic realistic fixture with long names, dense
conversation, linked sources, deep map relations, active and blocked work, wiki
text and open context. Cover loading/empty/error/restricted states in the changed
components; include both themes and the final #148 accent states where affected.
Run layout/overflow/reachability smoke checks across the full matrix; use a
focused set of matched whole-view captures for independent visual review at
320/390, tablet, laptop, 1920, 3440 and 3840 widths. Reuse #134/#148/#149 evidence
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
  recorded dataset sizes on representative low-end Android and desktop hardware.
  At task kickoff, before optimization, record numeric budgets, dataset and
  hardware/browser baseline with independent agreement; a bigger viewport is not permission for unbounded
  rendering, fetching or reflow. Missing hardware/performance evidence stays open.

Run substantial matrix/interaction checks in Docker with bounded reusable
fixtures; keep PR Actions light. Actual supported browser/OS/device evidence and
installation/OS-push requirements remain under #20. For large screens, record at
least one real 4K and one ultrawide session, including scaling/readability and a
window resize; emulation complements those checks. A hardware blocker is recorded
with its missing evidence and unblock condition, while independent work continues.

## Delivery and evidence status

**Proposed amendment, 2026-10-05 (#151 AC-1, pending peer review):** the current pane and
breakpoint rules, input modes, readable measure, map camera rule and surface mapping are
recorded in [adaptive layout rules](adaptive-layout-rules.md). It uses emulated viewports only.

Implement through [#151](https://github.com/ColdPhase/flux/issues/151), with the
same shell owner (@Zamojski5) as #136 and independent evaluator @PelikanFix16. #136 remains the integrated UX acceptance
record and must include ADAPT-1–ADAPT-5; #20 retains mobile/device acceptance.
Coordinate shared shell/token/map work with #134/#135/#148/#149; one writer per
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
