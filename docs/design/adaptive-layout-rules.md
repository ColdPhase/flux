# Adaptive layout rules: panes, breakpoints, input and surfaces (#151 AC-1)

**Appearance target since 2026-10-07: the [final design](final/README.md) (F-026); the measured
rules below describe the application before it.**

**Proposed amendment to [F-015 adaptive workspaces](adaptive-workspaces.md), 2026-10-05,
Zamojski5 (claude-maurycy). Independent peer review is pending; it is not accepted yet.**
It records the current rules of the application as implemented and measured at
branch `claude-maurycy/151-adaptive-matrix`, the three rules this slice adds (readable
measure, coarse-pointer targets, map camera), and the gaps that remain. Pixel values are CSS
pixels at 100% browser zoom. A rule chosen by the space a pane actually has is marked
*container*. A rule chosen by the whole window is marked *viewport*.

All measurements here come from emulated viewports in headless Chromium 151 in Docker. They
are not evidence for a physical 4K or ultrawide display, OS scaling, a real phone keyboard, or
an Android, iPhone or iPad. Those sessions remain open under #151 AC-5 and #20 (needs Maurycy).

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

Agents lists the three connections as three entries under the
[CO-1 connection model](../product/mcp-cowork.md#connections-and-owner-authorized-autonomy--co-1).

## Pane and breakpoint rules

| Space | Rule | Kind | Source |
| --- | --- | --- | --- |
| ≤ 640 px | Phone composition: 56 px header; the state line and "What matters" in one row under it; Details is a full-screen sheet; the map shows two card columns | viewport | `ui/motion.ts` `MEDIA.phone`, `app/app.css`, `ui/SidePanel.tsx` |
| ≤ 680 px | The sidebar becomes a 260 px drawer; the work sheet fills the screen | viewport | `MEDIA.navDrawer`, `app/app.css` |
| 641–1000 px | Details overlays the work from the right (≤ 420 px) | viewport | `MEDIA.panelOverlay` |
| > 1000 px | Details docks beside the work: 375 px (≤ 1200), 408 px, 430 px (≥ 1600) | viewport | `ui/tokens.css` `--panel-w` |
| Conversation split ≥ 760 px | A thread docks beside the stream at `clamp(320px, 40%, --panel-w)`; narrower, it is a sheet over the stream | container | `app/OneConversation.tsx` |
| Board ≤ 699 px | Tasks shows a status overview with counts, blocked included, and one column at a time; wider, three columns, with cards in auto-fill 260 px tracks inside each column | container | `work/board.css` `@container tasks` |
| Wiki 1300 / 1000 / 860 / 720 / 519 / 379 px | Document column 890 / 820 px; the index narrows; history stacks; ≤ 519 one column with a page strip; ≤ 379 icon-only actions | container | `docs/docs.css` `@container wiki`, `wikimain` |
| Agents | One 854 px column; connections wrap in one row when they fit | per surface | `agents/agents.css` |

No rule caps the whole application. Reading measures are set per surface.

**Gap.** The map's phone projection follows the viewport (≤ 640 px), not the space the
canvas actually has. A narrowed desktop canvas, for example with Details docked, keeps the plane.

## Input modes

- **`pointer: coarse`**: every primary action offers a 44 × 44 px target of its own. A target
  is measured from its centre until another element or nothing is hit, so a stretched card link
  counts and an adjacent control does not. The primary actions per surface:
  - shell: view tabs, Open navigation, Details, Close details;
  - Conversation: the message field, Send message, Reply, the reply field, Send reply and Close
    replies;
  - Map: the Sketch tools, Map / List and the zoom controls, plus the list rows;
  - Tasks: New Task, Kanban / List, the phone status buttons and task cards;
  - Wiki: Edit and the page index;
  - Agents: the task selector, the task message field and Send to task.

  The message and reply fields keep their 36 px line, and their own hit area reaches 44 px into
  the card padding. Inline links in cards and messages are not primary targets. Neither are
  compact header state links or the map's task-count pill, which already has a pseudo-element
  extension. Those links are listed with their measured sizes in the
  [slice evidence](../agents/evidence/151-adaptive-matrix/README.md#remaining-for-151) and left for
  #136 design review.
- **`hover: none`** (or ≤ 680 px): Enter adds a line and the send button sends (#189).
- **`hover: hover`**: the Reply action under a message appears on hover or focus.
  Without hover it is always visible.
- Viewport width alone never implies touch. The matrix uses a coarse pointer for 320–1024 px and
  a fine pointer above. One fixture per width cannot cover a touch laptop or a mouse on a tablet.

## Readable measure

On any rendered line of running prose, at most **90 characters**, spaces included, counted
from rendered line boxes. WCAG 1.4.8 (AAA) names 80. 90 is the ceiling chosen here for the
compact 14 px type. Measured longest lines, 320–5120 px:

| Surface | Longest line | Rule |
| --- | --- | --- |
| Conversation messages | 39–87 | bubbles `min(600px, 87%)` |
| Replies | 44–77 | thread width |
| Wiki prose | 45–83 | `66ch` for paragraphs, lists and quotes inside the unchanged 820/890 px column. Tables, code and images keep the column width. Before: 118–130 from 1440 px |
| Map hint | 68–87 | `66ch`. Before: 111–224 |

## Surface mapping

| Surface | Phone ≤ 640 | Tablet / split 641–1000 | Laptop 1001–1599 | Wide ≥ 1600 |
| --- | --- | --- | --- | --- |
| Conversation | One stream, avatars hidden; the thread is a full sheet with Close replies | Stream beside the sidebar; the thread is a sheet over the stream while the split is < 760 px | Thread docked beside the stream (from 1024 px without Details) | Stream (≥ 600 px), docked thread and docked Details side by side from 1920 px |
| Map / list | Two card columns at full size; tools in a grid; its own camera and zoom | Plane with Fit; Details overlays | Plane; Details docks without moving the camera | Plane, capped at the 1080 px sketch page (gap below) |
| Tasks | Status overview with blocked count and one column | Overview while the board is < 700 px wide | Three columns; Details docks beside the board, which shows the overview while it is under 700 px | Three columns beside docked Details; more cards per row (the Open column's three cards on one row at 3840 px) |
| Wiki | One column, page strip above the document | Index beside the document | Index, 820 px document, 66ch prose | Index, 890 px document, 66ch prose |
| Agents | One column; composer below the thread | Same column | 854 px column, the three connections in one row, Details docks | Same; no wide-screen context column yet (gap below) |

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
- Drafts, selection, the reading anchor, an open thread and the object in Details survive resize,
  rotation and a keyboard emulated as a shorter viewport. No transition saves or sends anything.
  The tests check this against the API.
- Unsent drafts keep their documented device-local scope. This record adds no draft sync.

## Verification

[`app/tests/ui/test_adaptive_matrix.py`](../../app/tests/ui/test_adaptive_matrix.py) runs in
`./scripts/check_ui.sh` on the shared fixture. Its record for the current head is
[`docs/agents/evidence/151-adaptive-rest`](../agents/evidence/151-adaptive-rest/README.md). It covers:

- the same journey (Conversation, its thread, Map, List, Tasks, a task in Details, Wiki, Agents,
  back) at all 23 starting fixtures of
  [adaptive workspaces](adaptive-workspaces.md#viewport-and-input-verification-matrix), from 320×568
  to 5120×1440 and 3840×2160, including the tall 900×1600. At each: no sideways scroll, reachable
  and unclipped primary actions, 44 px coarse targets, and the 90-character measure;
- system scaling: 3840×2160 at ratio 1, 2560×1440 at ratio 1.5 and 1920×1080 at ratio 2 give the same
  CSS boxes as ratio 1 for the pane, feed, map canvas, task board and Details, in four views;
- the dark theme for the same journey at 390×844 and 3440×1440;
- wide caps, measured at 1920, 2560 and 3840 px (below);
- transitions: the map camera, drafts, reading place, wiki text and Details survive resize, rotation
  and a shorter viewport, with nothing saved or sent.

**Known gaps.** `KNOWN_GAPS` in the test names what the current head does not meet. Each gap is still
measured and reported as open, never as passing, and the matrix fails when one stops showing, so a
closed gap must be removed from the list.

| Fixture | Gap | Owner that closes it |
| --- | --- | --- |
| 640×360, 844×390 | The sticky tab bar and the composer leave less than 44 px of stream between them, so a Reply target is covered | Phone shell PR [#414](https://github.com/ColdPhase/flux/pull/414) |
| 844×390 | The sticky status overview covers a task card, so a pointer cannot open it at this height. The journey opens it through the element's own click and measures the rest | Tasks layout PR [#375](https://github.com/ColdPhase/flux/pull/375) |

**Wide caps.** `WIDE_CAPS` in the test names two ADAPT-2 caps. Both are measured by `test_07`, which
fails once a cap disappears. Measured in CSS px at 1920, 2560 and 3840: the map plane is 1032, 1032
and 1032; the Agents column is 854, 854 and 854. The plane's cap is in `sketch/sketch.css`, owned by
the map work in PR [#380](https://github.com/ColdPhase/flux/pull/380). The column's cap is in
`agents/agents.css`, owned by the Agents work in PR [#376](https://github.com/ColdPhase/flux/pull/376)
and PR [#417](https://github.com/ColdPhase/flux/pull/417).

**Remaining for #151** (open; this record does not deliver them):

- the two wide caps (ADAPT-2), waiting for PRs #380, #376 and #417;
- the short-landscape gaps, waiting for PRs #414 and #375;
- the map projection still follows the viewport, not the canvas;
- performance budgets, agreed at kickoff before any optimisation (T151-A/G);
- browser zoom at 200% and 400%, and a measured 200% text enlargement (not run here);
- the independent visual review and running functional review of the combined head (AC-5);
- real 4K, ultrawide, Android, iPhone and iPad sessions (optional under #266 item 10).
