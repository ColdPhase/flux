# Motion in Flux

**Status.** Founder direction by Hubert ([@PelikanFix16](https://github.com/PelikanFix16)) on 2026-11-03, given after
the motion audit of [#863](https://github.com/ColdPhase/flux/issues/863) (main `a82ee012d`) and recorded in
[F-038](../product/decisions.md#f-038--a-simpler-flux). It is one rule set for all of Flux, on the computer and the phone.

It supersedes two earlier rules:

- the old-to-new crossfade of view switches, with the old view held as a picture
  ([#593](https://github.com/ColdPhase/flux/issues/593), [#719](https://github.com/ColdPhase/flux/issues/719));
- the press of the [final design](final/README.md) §2 before 2026-11-03: a scale to 0.97 that springs back in about 250 ms.

The application follows these rules since #863 ([what changed](#what-863-changed)); the few places that
still differ are listed there.

Values marked **proposed** (a dialog's 8 px travel and the 64 px bound for a scaling control) come from the
motion audit and the coordinator's reading, not from Hubert's decision on #863. #863 settled them as written below
(the highlight token is `--dur-highlight`); the rule that uses them stays as written.

## Rules

1. **Feedback within 100 ms.** A press, tap or key shows a visible change within 100 ms, as a change of colour or fill.
2. **A view switch shows the new screen at once.** Switching a space's view or going to another place (Home, Inbox,
   a space, Settings) puts the new screen in place at once. It may fade in over at most 120 ms on `--ease-out`. The
   old view is never held and never crossfades with the new one. A screen whose content is still loading shows its
   own calm loading state, in its final layout. The content of a panel that is replaced (a task by a thread) follows
   the same rule.
3. **Surfaces share one vocabulary.** Panels, dialogs, menus, popovers, sheets and the drawer all move the same way.
   - They enter in 180 ms on `--ease-out` and leave in 120 ms on `--ease-in`.
   - The motion is a fade plus a short travel from their edge or anchor: 16 px for a panel (`--shift-panel`), 4 px
     for a menu or popover (`--shift-pop`), 8 px for a dialog and from the screen edge for a sheet or drawer.
   - There is no scale and no overshoot.
   - Leaving never delays focus or the next action. Closing while a surface opens, or the reverse, continues from
     where it is.
4. **One motion per action.** An action makes one motion. The work area beside a panel or a sheet reflows without
   animation. The sidebar's fold is the one exception (rule 8). Indicators (the view switch's pill, a segmented
   control, the phone tab bar) move with `transform` in `--dur-1` on `--ease-out`, or at once, and never animate
   `width`.
5. **Nothing animates without a change by the person.** Nothing moves when it first appears (a view, its tabs, the
   cards on a map), on a refetch or live update, or on the server's echo of your own change. A state glyph morphs
   only from a known previous state. A highlight, such as a dropped card or a message you jumped to, lasts at most
   600 ms and takes its duration from one token.
6. **A surface opens with its content.** Preload what a surface shows, when the browser is idle or on pointer down.
   Never show a fallback that animates out, or a surface that opens empty and fills in afterwards. When a skeleton is
   needed, it has the final layout's heights, so nothing jumps when the content arrives.
7. **Press is colour only.** A pressed control changes its fill or colour. Small controls (a button or icon button up
   to 64 px on its longest side) may also scale to .98 and back over `--dur-1` on `--ease-out`, with no spring. Rows,
   cards, list items, links and sidebar items never scale.
8. **Only opacity and transform, from tokens.** Width, height and layout never animate, with one named exception:
   **the sidebar's fold to the rail and its unfold** ([#720](https://github.com/ColdPhase/flux/issues/720)) keeps its
   smooth width animation, and the content beside it adapts during the fold (Hubert, 2026-11-03, on
   [#863](https://github.com/ColdPhase/flux/issues/863)). CSS and script take every duration and easing from the
   tokens below, the sidebar's width animation included; no literal values such as `ease`, `.2s` or 900 ms.
   `--ease-spring`, `--ease-glide` and `--ease-sheet` are retired.
9. **Reduced motion sets every duration and delay to zero.** This applies to the system setting and to Settings →
   Appearance → Reduce motion alike, including animation delays, so the end state is there at once. A loop runs only
   while real work is in progress, and Kreska's expressions keep a static frame ([final design §3](final/README.md#3-kreska-logo-agent-icon-and-mascot)).

### How the rules apply to existing motion

These follow from the rules above. The sidebar is a founder decision; the others are the coordinator's reading, not
separate founder decisions.

- **The sidebar** ([#720](https://github.com/ColdPhase/flux/issues/720)) keeps its smooth width animation when it folds
  to the rail and unfolds (Hubert, 2026-11-03). Its width goes to the new one over `--dur-in` on `--ease-out`, and the
  work area beside it adapts while the width changes, so its top, bottom and far edge do not move. It is the one
  named exception to rule 8, and it is unchanged from `ui/SizeSwap.tsx`. A change of window between the full sidebar and
  the tablet's rail is not a fold and does not animate; reduced motion changes the width at once (rule 9).
- **Rows** that move because of your own action (a state change in a list or on the board) may slide to their new
  place as that action's one motion, with `transform` (`ui/rowMotion.ts`). A row that moves far fades in at its new
  place instead. A row appears or goes without a height animation, and the server's answer never replays the motion.
- **The two-height phone sheet** moves between its half and full heights with `transform`, not `height`.
- **Toasts** follow the surface vocabulary of rule 3.

## Tokens (`app/apps/web/src/ui/tokens.css`)

The values after #863:

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 120 ms | Press, fills, a view's fade-in, indicators, switches |
| `--dur-in` | 180 ms | A surface enters |
| `--dur-out` | 120 ms | A surface leaves |
| `--dur-highlight` | 600 ms | A highlight (rule 5): the most it lasts |
| `--dur-spin` / `--dur-loop` | 800 ms / 1600 ms | A spinner turns; a calm pulse, wave or blink loops (while real work is in progress) |
| `--delay-wait` / `--delay-tip` | 350 ms / 450 ms | The wait before a loading skeleton or a tooltip shows, so a quick change never flashes it |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | Entering, a view's fade-in, indicators, the release of a press |
| `--ease-in` | `cubic-bezier(.4, 0, 1, 1)` | Leaving |
| `--ease-loop` / `--ease-linear` | `ease-in-out` / `linear` | A loop; a rotation |
| `--press` | .98 | Small controls only |
| `--shift-panel` / `--shift-pop` / `--shift-toolbar` / `--shift-row` | 16 / 4 / 6 / 12 px | How far a panel, a menu, the message toolbar and a row travel |

- `--tr-fill` uses `--ease-out` instead of `ease`, and `--tr` moves `transform` in `--dur-1` on `--ease-out`.
- **Retired:** `--ease-spring`, `--ease-glide`, `--ease-sheet`, `--dur-2`, `--dur-3`, `--dur-4`, `--dur-press` and
  `--dur-view`, and `--shift-view` with the picture of the old view.
- **Reduced motion** (either setting) sets every duration and wait token to `0ms`, every animation and transition delay
  to `0s` and `--press` to `1`. Script motion (the press, row motion, morphs) does not run.

## Where it lives

| What | Where |
| --- | --- |
| Dialogs, ⌘K, the drawer, sheets and their scrim | `ui/Overlay.tsx` (`settle`) |
| The detail panel | `ui/SidePanel.tsx` |
| Menus and popovers | `ui/pop.ts` (`usePop`) and `[data-pop]` in `ui/ui.css` |
| Toasts | `ui/Toast.tsx` |
| View and place switches | `ui/ViewFade.tsx` around the routes in `app/AppLayout.tsx`; `ui/motion-rules.ts` |
| Surfaces that load their code | `app/DeferredSurfaces.tsx` (preloaded when idle and on the first press) |
| The sidebar's fold and unfold | `ui/SizeSwap.tsx` in the `aside` of `app/AppLayout.tsx` |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx`, `ui/motion.ts` |
| Rows that come, go and move | `ui/rowMotion.ts` (one motion per input, `claimInput` in `ui/motion.ts`) |
| The press | `ui/press.ts` |
| The tokens and reduced motion | `ui/tokens.css`, `ui/ui.css`, `ui/moments.css` |

## What #863 changed

The motion audit of main `a82ee012d` (2026-11-03, Chromium at 1440 and 390 px) found the gaps below. #863 closed them.
Paths are under `app/apps/web/src/`.

| Rule | What it was | Now |
| --- | --- | --- |
| 2 | The old view was held as a picture until the new one was ready (up to 500 ms), then faded 150 ms on `--ease-in` (`ui/Dissolve.tsx`) | `ui/ViewFade.tsx`: the new screen is in place at once and fades in over `--dur-1` on `--ease-out`; the picture, `--dur-view` and `--shift-view` are gone. A replaced panel content does the same (`ui/SidePanel.tsx`) |
| 6 | The first ⌘K dimmed, undimmed and dimmed again; the first task panel opened empty, then "Loading…", then content | `app/DeferredSurfaces.tsx` loads Jump to… inside its one dialog and preloads it and Details; `work/WorkDetails.tsx` shows a skeleton at the task panel's heights |
| 4, 7 | A tab tap ran five motions on four easings (the press spring, the pill glide on `width`, …); a panel and the work area moved on two curves | Indicators move with `transform` over `--dur-1` on `--ease-out` and never animate `width`; the work area reflows without animation (no FLIP) |
| 5 | A task notice's status icon flipped on every visit; a dropped board card restarted on the server's echo; tab pills and map cards animated on first appearance | A state glyph morphs only from a known value; a list's rows move only as the answer to the person's own input, once (`claimInput`); the tab indicator and the map's cards do not animate when they first appear; highlights use `--dur-highlight` |
| 7 | Rows, cards and sidebar items scaled to 0.97 with a 250 ms spring (`ui/press.ts`) | A press is colour; a small button scales to .98 and back over `--dur-1`, no spring |
| 3 | Dialogs and toasts scaled; panels, sheets, dialogs, menus and toasts each entered differently; three switches used three timings | 180 ms in on `--ease-out`, 120 ms out on `--ease-in`, a fade plus a short travel, no scale; one switch rule (`--dur-1`) |
| 6 | Phone Home shifted 0.50–0.62 when Continue arrived | `app/Home.tsx` keeps the card's space while it is read |
| 8 | Literal durations and easings | Every duration and easing comes from a token; the two-height phone sheet moves with `transform` (`ui/DetentSheet.tsx`) |
| 9 | The in-app Reduce motion kept animation delays; two rules checked only the system setting | Both settings zero durations and delays |

Still open: the Wiki text that moves 72 px and the thread's layout shift of 0.089 (rule 6) were not part of #863's
first batch.

## Verifying

- **Frame capture.** Record each common action as the audit did: open a space, a panel and a thread; switch views;
  send a message; open the phone sheet; Kreska's moments. Use Chromium and WebKit at 1440 and 390 px, read
  `document.getAnimations()` on every frame, and repeat with system reduced motion, the in-app setting, 4× CPU and a
  90 ms click. Each action shows its first change within 100 ms, runs one animation on the tokens, replays nothing on
  a refetch or the server's echo, and shifts no layout after its content arrives.
- **Existing tests.** `app/tests/ui/test_view_switch.py` and `test_light_motion.py` assert these rules (no held
  picture, a fade-in of at most 120 ms, the press, the tokens). `test_sidebar_motion.py` keeps asserting the sidebar's
  width animation, which stays.
