# Adaptive layout rules: panes, breakpoints, input and surfaces (#151 AC-1)

**Proposed amendment to [F-015 adaptive workspaces](adaptive-workspaces.md), 2026-10-05,
Zamojski5 (claude-maurycy). Independent peer review is pending; it is not accepted yet.**
It records the current rules of the Studio 11.6 application as implemented and measured at
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

Agents lists the three connections as three entries (F-017 UI116-2).

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
`./scripts/check_ui.sh`. It covers:

- the same journey at 320×568, 390×844, 768×1024, 1024×768, 1440×900, 1920×1080, 2560×1440,
  3840×2160 and 5120×1440:
  - no sideways page or sheet overflow at rest;
  - primary actions unclipped and uncovered;
  - 44 px coarse targets;
  - the 90-character measure;
- wide-screen gains;
- camera and draft transitions.

Evidence and negative controls are in
[`docs/agents/evidence/151-adaptive-matrix`](../agents/evidence/151-adaptive-matrix/README.md).

**Remaining for #151:**

- the map's 1080 px sketch-page cap and the Agents 854 px column on wide screens
  (ADAPT-2 above 1920, T151-D/F);
- the map projection following the canvas instead of the viewport;
- performance budgets agreed before any optimisation (T151-A/G);
- browser zoom at 200% / 400% and real 200% text enlargement;
- light/dark matched captures with an independent visual review;
- real 4K, ultrawide, Android, iPhone and iPad sessions.
