# Adaptive matrix, touch targets, map camera and measure — #151 (slice)

2026-10-05, Zamojski5 (claude-maurycy), branch `claude-maurycy/151-adaptive-matrix` from
main `fdb70955`. Refs #151 and #264 (founder: the phone UI looks poor). This slice covers
AC-1, a fixture matrix and the AC-3 transitions. It does not complete #151.

**Emulation only.** These are CSS viewports at 100% zoom in headless Chromium 151 in Docker,
with a synthetic fixture: Hubert has two agent connections, Marek has one
([fixture](../../../../app/tests/ui/adaptive_fixture.py)). They are not evidence for a physical
4K or ultrawide display, OS scaling, a real phone keyboard, or real Android, iPhone or iPad
devices. Those sessions stay open (needs Maurycy, #20).

## What the matrix checks

[`test_adaptive_matrix.py`](../../../../app/tests/ui/test_adaptive_matrix.py) follows one journey
at 320, 390, 768, 1024, 1440, 1920, 2560, 3840 and 5120 px:

1. Conversation, then a thread;
2. Map, then List;
3. Tasks, then a task in Details;
4. Wiki;
5. Agents;
6. back to Conversation.

At every width it checks:

- no sideways scroll of the page or the work sheet, measured once animations finish;
- every primary action fully on screen and actually hit;
- a 44 px coarse-pointer target, at 320–1024 px;
- prose lines of at most 90 characters.

It also checks the wide-screen gains:

- the thread docks beside the stream;
- Details docks beside the board, and the map canvas keeps its width beside Details;
- the stream, thread and Details sit side by side at 1920 px and wider;
- the Open column's three cards take one row at 3840 px and three rows at 1440 px;
- all three connections share one row.

The transition tests resize, rotate (width/height swap) and emulate a keyboard as a shorter
viewport. They check the map camera, zoom and selection; a private thought draft; the
conversation draft, reading place and reply draft; wiki unsaved text; and the task in Details.
The API counts show that nothing is saved or sent.

## Fixes and their negative controls

Every control below was observed with the new tests against unchanged main `fdb70955`. The
stack was built from that commit.

| Fix | Commit | On main | Now |
| --- | --- | --- | --- |
| 44 px coarse targets: the message and reply fields keep a 36 px line with a 44 px hit area; Reply, zoom Fit and wiki Edit have a 44 px minimum width | `1b42463f` | Fields 36.5 px tall, Reply 43, Fit 36, Edit 40.5, at every coarse width | Pass |
| Work pane tappable after Details closes (phone sheet, tablet overlay) | `1b42463f` | Wiki Edit, page index, Agents task selector, message field and Send to task were hit-tested as `div.app__main`. The pane's computed `interactivity` stayed `inert` with `#root.inert === false`, from the next view slide on. Reproduced 3/3 by trace | Pass. A changed inherited custom property on `#root` makes every element below it compute its style again (3/3) |
| Map camera across the phone projection and rotation (T151-E) | `2ea0a66c` | `test_10`: `{'left': 0, 'top': 96} != {'left': 64, 'top': 96}`; `test_11`: `{'left': 0, 'top': 140} != {'left': 120, 'top': 60}` | Pass |
| Readable measure | `deb3d45d` | Wiki prose 118–130 characters from 1440 px; map hint 111–224 | Wiki 45–83, map hint 68–87, conversation 39–87, replies 44–77 |
| Sideways overflow of 1–12 px | test only | The sheet and the view were measured while sliding in (offset 2–12 px). At rest there was no overflow on main either | Measured at rest; 0 px at every width |

**Root cause of the camera reset.** At ≤ 640 px the map switches to the phone's two-column
projection, whose plane is only as wide as the canvas: 584 px against 1924 px for the fixture.
The browser clamps `scrollLeft` to 0 when the scrollable area shrinks and never restores it,
and `SketchMap` kept no camera of its own. The probe at 1366 → 641 → 640 → 1366 read
`scrollLeft` 64 → 64 → 0 → 0, while `scrollWidth` returned to 1924.

## Targeted runs

Each run used `./scripts/check_ui.sh <modules>` in Docker through the shared slot lock.

| Head | Modules | Result |
| --- | --- | --- |
| `1b42463f` | adaptive matrix, one conversation, shared composer, wiki panes, map layout, tasks board | 66 tests; only the 9 expected matrix failures (measure; camera fix not yet in) |
| `2ea0a66c` | adaptive matrix, map layout, map outline, map task count, sketches, thought drafts, DM sketches | 67 tests; only the 7 expected measure subtests failed; camera and transitions pass |
| `deb3d45d` | adaptive matrix, wiki panes, docs, map layout | 34 tests OK |

## Screenshots (emulated)

- [320×568 Conversation](320x568-conversation.png)
- [390×844 Tasks status overview](390x844-tasks.png)
- [390×844 Map, phone projection](390x844-map.png)
- [768×1024 Wiki](768x1024-wiki.png)
- [1440×900 thread beside the stream](1440x900-thread.png)
- [1920×1080 stream, thread and Details](1920x1080-thread-and-details-scaled.png), scaled to 1440
- [3840×2160 board](3840x2160-tasks-scaled.png), scaled to 1600

Screenshots do not prove interaction or accessibility. No independent visual review has been
done for this slice.

## Remaining for #151

- Wide-screen use of the map, which is capped by the 1080 px sketch page, and of Agents, which
  is capped at an 854 px column (T151-D/F).
- The phone projection follows the viewport, not the canvas.
- Performance budgets (T151-A/G).
- 200% / 400% zoom and real 200% text.
- Matched light/dark captures and an independent visual and functional review (AC-5).
- Real 4K, ultrawide, Android, iPhone and iPad sessions.
- The founder's concrete phone list (#264).

Smaller coarse targets that are not primary actions are recorded for #136:

- card source links (32 px tall);
- message author links;
- the header audience and state links (22–33 px);
- the map task-count pill (21–28 px, with a pseudo-element extension).
