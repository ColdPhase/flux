# Spokój: calm and consistent polish of Prostota

**Status.** Founder direction by Hubert ([@PelikanFix16](https://github.com/PelikanFix16)) on
2026-10-15. It refines the final design [Prostota](../final/README.md) (F-026). Prostota stays
the only direction; this page adds rules and drawings where the shipped application
overwhelms people or where the same function moves between views. Where this page and an
older Prostota drawing differ, this page wins.

- **Interactive board.** <https://claude.ai/artifact/3vLEMhiX3zg6b72c45Qhxq> (pages 0–10,
  "teraz" = now, "po poprawce" = after). Renders of every board are in [`boards/`](boards/).
- **Evidence.** Measured in the running application at main `86c43c75` (demo data, dark
  theme, Chromium in Docker) on 390 × 844, 820 × 1180, 1440 × 900, 1920 × 1080 and
  2560 × 1440. Control positions were recorded per accessible name in 24 states per
  viewport and compared between states.

![Overview](boards/Main.webp)

## Rules

1. **Text matters more than buttons.** Buttons are 32 px (44 px on touch) with 13–14 px
   labels. One primary action per surface; the rest is quiet text or lives in "⋯".
2. **At most two content columns.** The conversation plus one panel. Opening another object
   from the panel replaces the panel's content, with "‹ back"; it never adds a third column.
3. **One header row.** Opening a panel never wraps the project header. When room runs out,
   people and "Together" move into "⋯"; the views stay.
4. **Empty sections disappear.** Empty "Decisions", "In docs", single-page pagination and
   zero counters are not shown. Adding lives in "⋯" or "+".
5. **One pattern for one thing.** One message bubble in projects, direct messages and
   threads; one panel shell for tasks, threads and project details; one composer.
6. **Selection is a soft fill.** No white rings or vertical bars. A highlighted source fades
   after 2 s. Message actions appear on hover (computer) or long press / swipe (phone).
7. **A control never changes place.** Switching a view or a state changes the content, never
   the position of a control. The view switcher is always on the left, the primary action
   always on the right, the sidebar toggle always in the top row. Unavailable actions are
   dimmed instead of removed so nothing else shifts.

### Token

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--own` | `#E7E7EA` | `#313134` | The signed-in person's message bubble (replaces `--inv` for own bubbles) |

Other people's and agents' bubbles stay `--el` with a `--line` outline. Own bubbles have no
avatar and no name; time and "Seen by" sit under the last bubble of a run.

### Layout per screen

| Screen | Layout |
| --- | --- |
| Phone 390 | One thing at a time. Task, thread and details are a sheet (half / full). A thread opened from a task replaces the sheet's content. |
| Tablet 820 | Sidebar collapsed to the 64 px rail. The panel (380 px) slides over the conversation, which stays visible. Project title is the view menu. |
| Computer 1440 | Sidebar 248 + conversation + panel 420, one header row above both. |
| Large 1920–2560 | Conversation at most 760 px, panel 480 px; extra width is margin. Never a third column. |

## Boards

| Area | Now | After |
| --- | --- | --- |
| 1 Home | [now](boards/B01-home-teraz.webp) | [after](boards/A01-home-po.webp) |
| 2 Message bubbles | [now](boards/B02-banki-teraz.webp) | [after](boards/A02-banki-po.webp) |
| 3 Map canvas | [now](boards/B03-mapa-teraz.webp) | [after](boards/A03-mapa-po.webp) |
| 4 Map list | [now](boards/B04-lista-teraz.webp) | [after](boards/A04-lista-po.webp) |
| 5 Task panel | [now](boards/B05-task-teraz.webp) | [computer](boards/A05-task-po.webp) · [phone](boards/A05p-task-telefon.webp) |
| 6 Wiki | [now](boards/B06-wiki-teraz.webp) | [history](boards/A06-wiki-historia-po.webp) · [outline](boards/A06n-wiki-spis-po.webp) |
| 7 Project details | [now](boards/B07-details-teraz.webp) | [after](boards/A07-details-po.webp) |
| 8 Thread from a task | [now](boards/B08-watek-teraz.webp) | [after](boards/A08-watek-po.webp) · [layout per screen](boards/A08s-ekrany.webp) |
| Phone conversation | [now](boards/B09-telefon-teraz.webp) | [after](boards/A09-telefon-po.webp) |
| 9 Consistency | [audit](boards/C01-spojnosc-audyt.webp) | [anchors](boards/C02-kotwice-po.webp) |
| 10 Rest of the app | [now](boards/D01-reszta-teraz.webp) | [hand-off](boards/E01-handoff-po.webp) · [Create and ⌘K](boards/E02-create-palette-po.webp) · [Sketchbook](boards/E03-sketchbook-po.webp) · [Settings](boards/E04-settings-po.webp) · [Settings phone](boards/E04p-settings-telefon.webp) · [Search](boards/E05-search-po.webp) · [empty Inbox](boards/E06-inbox-pusty-po.webp) |

Board copy explaining each change is in Polish; the application copy in the drawings is the
English product copy.

## Accepting an implementation

Compare against the "after" boards at 390 × 844, 820 × 1180, 1440 × 900 and 2560 × 1440 in
light and dark, in Chromium and WebKit emulation. For rule 7, record control positions per
accessible name before and after each state change named in the task and show that they do
not move. Screenshots alone do not prove interaction or accessibility.
