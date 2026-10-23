# Adaptive layout rules: panes, breakpoints, input and surfaces (#151 AC-1)

**Appearance target since 2026-10-07: the [final design](final/README.md) (F-026), refined by
[Spokój](spokoj/README.md) (2026-10-15).** This page records the layout rules of the application as shipped
and measured, not a new design.

**Proposed amendment to [F-015 adaptive workspaces](adaptive-workspaces.md), first written 2026-10-05 by
Zamojski5 (claude-maurycy) and re-recorded 2026-10-23 at `main` `e4b4fab7` for the Prostota and Spokój
shell by PelikanFix16 (claude-hubert). Independent peer review is pending; it is not accepted yet.**
It records the rules of the application as implemented and measured, the three rules that #265 added
(readable measure, coarse-pointer targets, map camera), and the gaps that remain. Pixel values are CSS
pixels at 100% browser zoom. A rule chosen by the space a pane actually has is marked *container*. A rule
chosen by the whole window is marked *viewport*.

All measurements here come from emulated viewports in headless Chromium and WebKit in Docker. They are
not evidence for a physical 4K or ultrawide display, OS scaling, a real phone keyboard, or an Android,
iPhone or iPad. Real hardware is optional (founder direction #266 item 10).

## Fixture

[`app/tests/ui/adaptive_fixture.py`](../../app/tests/ui/adaptive_fixture.py) creates one
restricted project, *Quiet gesture lamp for the bedside, sensor comparison*, through the
public API. Two owners share it:

- **Hubert Kowalczyk-Nowakowski** (long name), project owner. His agent has **two personal
  connections**: Codex on "Desk laptop" and Claude Code on "Travel laptop".
- **Marek Lis**, contributor. His agent has **one connection**: Claude Code on "Workshop PC".

Content:

- ten conversation roots from both people, one of them with a two-reply thread;
- a ten-thought linked map spread over 1500 × 1100 plane units;
- six tasks: open, in progress, blocked with its blocker, and done, each linked to thoughts;
- a published wiki page with long prose, a list and code.

Agents is one list with a row for each of Hubert's two agents' connections and Marek's one, under the
[CO-1 connection model](../product/mcp-cowork.md#connections-and-owner-authorized-autonomy--co-1).

## Pane and breakpoint rules

| Space | Rule | Kind | Source |
| --- | --- | --- | --- |
| ≤ 640 px | Phone composition ([#341](https://github.com/ColdPhase/flux/issues/341)): a 56 px header (Back, the title that opens the view menu, Together, Search), the same in every view; Home, Projects and Inbox in a capsule outside a conversation and none inside one; Details and threads are sheets; the map shows two card columns | viewport | `ui/motion.ts` `MEDIA.phone`, `app/app.css`, `app/PhoneChrome.tsx`, `ui/DetentSheet.tsx` |
| 641–680 px | The work area runs edge to edge; Open navigation opens the 260 px drawer | viewport | `MEDIA.navDrawer`, `app/app.css` |
| ≤ 900 px | The sidebar is the 64 px rail and its expand control opens the drawer. The project title is the view menu, so the views leave the header | viewport | `MEDIA.tablet`, `app/app.css`, `docs/design/spokoj` "Layout per screen" |
| ≤ 1000 px | The one panel (Details, a thread) overlays the work from the right: 380 px at 820 | viewport | `MEDIA.panelOverlay`, `ui/ui.css` |
| > 1000 px | The panel docks beside the work and replaces its content for the next object, never a third column: 380 px up to 1200, 420 px, 480 px from 1920. The conversation is at most 760 px from 1920 | viewport | `ui/tokens.css` `--panel-w`, `app/project-conversation.css` `.project-convo__in` |
| Board < 700 px | Tasks shows a status overview with counts, blocked included, and one column at a time; wider, three columns, with cards in auto-fill tracks inside each column | container | `work/board.css` `@container tasks` |
| Wiki 1000 / 860 / 720 / 499 px | The index narrows to 196 then 180 px; the outline goes below 860; history stacks below 720; below 499 one column with a page strip | container | `docs/docs.css` `@container wiki`, `wikimain` |
| Thread feed < 400 px | A docked panel on a small laptop has no room beside a bubble: the three message actions sit in the bubble's corner | container | `work/message-actions.css` `@container thread-feed` |
| Map pane ≤ 680 px, canvas ≤ 1080 px wide or ≤ 560 px tall | "Select several" is its icon alone; the zoom controls rise above the tools; the minimap goes | container | `sketch/sketch.css` `@container` |
| Agents | One list in an 854 px column; the three connections are three rows | per surface | `agents/agents.css` |

No rule caps the whole application. Reading measures are set per surface.

**Gap.** The map's phone projection follows the viewport (≤ 640 px), not the space the
canvas actually has. A narrowed desktop canvas, for example with Details docked, keeps the plane.

## Input modes

- **`pointer: coarse`**: every primary action offers a 44 × 44 px target of its own. A target
  is measured from its centre until another element or nothing is hit, so a stretched card link
  counts and an adjacent control does not. The primary actions per surface:
  - shell: the views (tabs, or the title's menu up to 900 px), Open navigation, Details, Close details;
  - Conversation: the message field, Send message, Reply, the reply field, Send reply and Close
    replies;
  - Map: the Sketch tools, Map / List and the zoom controls, plus the list rows;
  - Tasks: New Task, Board / List, the status overview buttons and task cards; on the phone Create, Mine / All,
    a task's state glyph and its row;
  - Wiki: Edit and the page index;
  - Agents: Hand off a task.

  The message and reply fields keep their 36 px line, and their own hit area reaches 44 px into
  the card padding. Inline links in cards and messages are not primary targets. Neither are
  compact header state links or the map's task-count pill, which already has a pseudo-element
  extension. Those links are listed with their measured sizes in the
  [slice evidence](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/151-adaptive-matrix/README.md) and left for
  #136 design review.
- **`hover: none`**: Enter adds a line and the send button sends (#189).
- **`hover: hover`**: the Reply action under a message appears on hover or focus.
  Without hover it is always visible.
- Viewport width alone never implies touch. The matrix uses a coarse pointer for 320–1024 px and
  a fine pointer above. One fixture per width cannot cover a touch laptop or a mouse on a tablet.

## Readable measure

On any rendered line of running prose, at most **90 characters**, spaces included, counted
from rendered line boxes. WCAG 1.4.8 (AAA) names 80. 90 is the ceiling chosen here for the
compact 14 px type. Measured longest lines, 320–5120 px (re-measured 2026-10-23 in Chromium and WebKit):

| Surface | Longest line | Rule |
| --- | --- | --- |
| Conversation messages | 37–89 | the stream's column, at most 760 px |
| Replies | 37–82 | the panel's width |
| Wiki prose | 37–89 | `62ch` for paragraphs, lists and quotes inside the 820 px page (850 in focus mode). Tables, code and images keep the page width |
| Map hint | 33–72 | `min(640px, 100%)` |

## Surface mapping

| Surface | Phone ≤ 640 | Tablet / split 641–1000 | Laptop 1001–1599 | Wide ≥ 1600 |
| --- | --- | --- | --- | --- |
| Conversation | One stream; no tab bar; the thread is a sheet (Replies) with Close replies | The stream beside the rail; the thread overlays as the 380 px panel | The thread docks beside the stream as the one panel; Details takes the same panel and a Thread button returns to it | The stream (≥ 600 px, at most 760 px from 1920) and one docked 480 px panel; extra width is margin, never a third column |
| Map / list | Two card columns at full size; the tools in a grid; its own camera and zoom | The plane fills the pane with Fit; Details overlays | The plane; Details docks and narrows the pane | The plane fills its pane and grows with the screen: 1664, 2304 and 3584 px at 1920, 2560 and 3840 |
| Tasks | The drawn Mine \| All list with state glyphs; no board | A board that shows the status overview (blocked count, one column) while it is under 700 px wide | Three columns; Details docks beside the board | Three columns beside docked Details; more cards per row (the Open column's three cards on one row at 3840 px, three rows at 1440) |
| Wiki | One column, a page strip above the document | The index beside the document from 768 px | The index (180–196 px) and the 820 px page, 62ch prose | The same: extra width is margin |
| Agents | One list; the composer below the thread | The same list | One 854 px column, the three connections as three rows, Details docks | The same column (WIDE_CAPS in the matrix; see Remaining) |

The same five tabs keep their names and order at every width. The same primary actions
remain reachable. Own messages stay on the right and other people's on the left.

## Transitions

- **Map camera** (T151-E): each projection keeps its own camera and zoom.
  - The plane keeps its scroll position. On the phone, the thought at the top keeps its offset
    (a thought that was wholly in view stays wholly in view when a narrower phone makes it
    taller), and a zoomed-in phone map also keeps its sideways scroll.
  - When a layout change clamps the scroll position, the camera is put back. Only a scroll the
    layout did not cause moves it: a person, a pan, or a moved thought scrolled into view.
  - While a person drags or resizes a thought, the view stays still.
  - On a first visit to a projection, the selected thought, or else the first one in view, stays
    where the person saw it.
  - Nothing auto-fits on a resize.
- **Short feeds** (ADAPT-2, tall screens): when the project stream, a thread or a direct message does not fill its feed,
  the spare height goes above it (`ui/spareHeight.ts`, an empty `lift` element before the column), so the newest message
  sits 23–27 px above its field from 390×844 to 3840×2160 instead of up to 1800 px away. The spare height is taken when
  the entries or the feed's size change. A row that changes height in place (a queued message becoming the stored one)
  only gives height back, so it never moves. A feed that fills its box has no spare height and scrolls as before.
  **Not covered:** Agents' task thread (a page scroll with its own sticky composer) and a direct message's thread panel
  still leave their spare height where it falls.
- **Half sheet** (phone): 56% of the screen, but at least 300 px (`.ui-detent-sheet`), so on a short landscape phone the
  composer does not leave a task's fields less than a row of room; every field row can be scrolled clear of the composer.
- Drafts, selection, the reading anchor, an open thread and the object in Details survive resize,
  rotation and a keyboard emulated as a shorter viewport. No transition saves or sends anything.
  The tests check this against the API.
- Unsent drafts keep their documented device-local scope. This record adds no draft sync.

## Verification

[`app/tests/ui/test_adaptive_matrix.py`](../../app/tests/ui/test_adaptive_matrix.py) runs in
`./scripts/check_ui.sh` on the shared fixture, in Chromium by default and in WebKit with
`FLUX_UI_BROWSER=webkit ./scripts/check_ui.sh test_adaptive_matrix`. The record of the first slice is
[`docs/agents/evidence/151-adaptive-rest`](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/151-adaptive-rest/README.md); the counts of the current head are in
its pull request. The test covers:

- the same journey (Conversation, its thread, Map, List, Tasks, a task in Details, Wiki, Agents,
  back) at all 23 starting fixtures of
  [adaptive workspaces](adaptive-workspaces.md#viewport-and-input-verification-matrix), from 320×568
  to 5120×1440 and 3840×2160, including the tall 900×1600. At each: no sideways scroll, reachable
  and unclipped primary actions, 44 px coarse targets, and the 90-character measure;
- system scaling: 3840×2160 at ratio 1, 2560×1440 at ratio 1.5 and 1920×1080 at ratio 2 give the same
  CSS boxes as ratio 1 for the pane, feed, map canvas, task board and Details, in four views;
- the dark theme for the same journey at 390×844 and 3440×1440;
- wide caps, measured at 1920, 2560 and 3840 px (below);
- a short stream, thread and direct message on a tall screen: with two messages each, the newest message and its field
  are at most `MAX_STREAM_GAP` apart from 390×844 to 3840×2160 (test_08, test_09);
- the task in Details: every field row (Status, Owner, Came from, Due) shows its own line above the composer on opening
  on the common phones, and lies wholly above it, hit-testable, once scrolled into view, at every fixture;
- browser zoom and text enlargement (ADAPT-5): all five views at 1280×1024 at 400% (a 320×256 CSS viewport) and
  1280×720 at 200% (640×360), emulated as the window divided by the zoom with the pixel ratio multiplied by it, and
  at 390×844, 820×1180 and 1440×900 with the root text size at 200%, where the test first measures that a message's
  text really doubled. Each view has no sideways page scroll and its primary actions are reachable by scrolling;
- transitions: the map camera, drafts, reading place, wiki text (the shared working copy when live editing is on) and
  Details survive resize, rotation and a shorter viewport, with nothing saved or sent; a saved task opens for the same
  account on another device, for a colleague with access, and for nobody else, while an unsent draft stays on the
  device it was written on.

**Known gaps.** `KNOWN_GAPS` in the test names what the current head does not meet. Each gap is still
measured and reported as open, never as passing, and the matrix fails when one stops showing, so a
closed gap must be removed from the list.

No gaps are open: `KNOWN_GAPS` is empty.

**Wide caps.** `WIDE_CAPS` in the test names one ADAPT-2 cap, measured by `test_07`, which fails once the cap
disappears. Measured in CSS px at 1920, 2560 and 3840: the map plane is 1664, 2304 and 3584 (it fills its pane); the
Agents column is 854, 854 and 854 (`agents/agents.css`). [Spokój](spokoj/README.md) draws large screens as
"conversation at most 760 px, panel 480 px; extra width is margin, never a third column". Whether the Agents list
should use more of a wide screen is therefore a design decision for the founders, not something this record changes.

**Remaining for #151** (open; this record does not deliver them):

- the Agents column's cap (ADAPT-2), pending that design decision;
- the map projection still follows the viewport, not the canvas;
- performance budgets for the adaptive layouts, agreed at kickoff before any optimisation (T151-A/G); the bounded
  native-work budgets and the opt-in `motion_performance` harness exist, but no independent agreement covers the
  adaptive matrix;
- safe areas on real devices, real browser zoom and an operating system's own text-size setting (the emulations above
  stand in for them);
- the independent visual review and running functional review of the combined head (AC-5);
- real 4K, ultrawide, Android, iPhone and iPad sessions (optional under #266 item 10).
