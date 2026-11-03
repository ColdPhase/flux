# Motion in Flux

**Status.** Founder direction by Hubert ([@PelikanFix16](https://github.com/PelikanFix16)) on 2026-11-03, given after
the motion audit of [#863](https://github.com/ColdPhase/flux/issues/863) (main `a82ee012d`) and recorded in
[F-038](../product/decisions.md#f-038--a-simpler-flux). It is one rule set for all of Flux, on the computer and the phone.

It supersedes two earlier rules:

- the old-to-new crossfade of view switches, with the old view held as a picture
  ([#593](https://github.com/ColdPhase/flux/issues/593), [#719](https://github.com/ColdPhase/flux/issues/719));
- the press of the [final design](final/README.md) §2 before 2026-11-03: a scale to 0.97 that springs back in about 250 ms.

Until #863 lands its fixes, the application still differs from these rules in the places listed
[below](#where-main-differs).

## Rules

1. **Feedback within 100 ms.** A press, tap or key shows a visible change within 100 ms, as a change of colour or fill.
2. **A view switch shows the new screen at once.** Switching a space's view or going to another place (Home, Inbox,
   a space, Settings) puts the new screen in place at once. It may fade in over at most 120 ms on `--ease-out`. The
   old view is never held and never crossfades with the new one. A screen whose content is still loading shows its
   own calm loading state, in its final layout.
3. **Surfaces share one vocabulary.** Panels, dialogs, menus, popovers, sheets and the drawer all move the same way.
   - They enter in 180 ms on `--ease-out` and leave in 120 ms on `--ease-in`.
   - The motion is a fade plus a short travel from their edge or anchor: 16 px for a panel (`--shift-panel`), 4 px
     for a menu or popover (`--shift-pop`), at most 8 px for a dialog, and from the screen edge for a sheet or drawer.
   - There is no scale and no overshoot.
   - Leaving never delays focus or the next action. Closing while a surface opens, or the reverse, continues from
     where it is.
4. **One motion per action.** An action makes one motion. The work area beside a panel, a sheet or the sidebar
   reflows without animation. Indicators (the view switch's pill, a segmented control, the phone tab bar) move with
   `transform` in `--dur-1` on `--ease-out`, or at once, and never animate `width`.
5. **Nothing animates without a change by the person.** Nothing moves when it first appears (a view, its tabs, the
   cards on a map), on a refetch or live update, or on the server's echo of your own change. A state glyph morphs
   only from a known previous state. A highlight, such as a dropped card or a message you jumped to, lasts at most
   600 ms and takes its duration from one token.
6. **A surface opens with its content.** Preload what a surface shows, when the browser is idle or on pointer down.
   Never show a fallback that animates out, or a surface that opens empty and fills in afterwards. When a skeleton is
   needed, it has the final layout's heights, so nothing jumps when the content arrives.
7. **Press is colour only.** A pressed control changes its fill or colour. Small controls (buttons and icon buttons
   up to 64 px) may also scale to .98, with no spring. Rows, cards, list items and sidebar items never scale.
8. **Only opacity and transform, from tokens.** Width, height and layout never animate. CSS and script take every
   duration and easing from the tokens below; no literal values such as `ease`, `.2s` or 900 ms.
   `--ease-spring`, `--ease-glide` and `--ease-sheet` are retired.
9. **Reduced motion sets every duration and delay to zero.** This applies to the system setting and to Settings →
   Appearance → Reduce motion alike, including animation delays, so the end state is there at once. A loop runs only
   while real work is in progress, and Kreska's expressions keep a static frame ([final design §3](final/README.md#3-kreska-logo-agent-icon-and-mascot)).

### How the rules apply to existing motion

These follow from the rules above; they are the coordinator's reading, not separate founder decisions.

- **The sidebar** ([#720](https://github.com/ColdPhase/flux/issues/720)) keeps a motion when it folds to the rail or
  unfolds. Its content fades with a short travel from the left edge, as a surface does. Its width and the work area
  change at once (rules 4 and 8), which replaces the width animation of `ui/SizeSwap.tsx`.
- **Rows** that move because of your own action (a state change in a list or on the board) may slide to their new
  place as that action's one motion, with `transform` (`ui/rowMotion.ts`). A row that moves far fades in at its new
  place instead. A row appears or goes without a height animation, and the server's answer never replays the motion.
- **The two-height phone sheet** moves between its half and full heights with `transform`, not `height`.
- **Toasts** follow the surface vocabulary of rule 3.

## Tokens (`app/apps/web/src/ui/tokens.css`)

The values after #863:

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 120 ms | Press, fills, a view's fade-in, indicators |
| `--dur-in` | 180 ms | A surface enters |
| `--dur-out` | 120 ms | A surface leaves |
| One highlight token | at most 600 ms | A highlight (rule 5) |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | Entering, a view's fade-in, indicators, the release of a press |
| `--ease-in` | `cubic-bezier(.4, 0, 1, 1)` | Leaving |
| `--press` | .98 | Small controls only |
| `--shift-panel` / `--shift-pop` / `--shift-toolbar` / `--shift-row` | 16 / 4 / 6 / 12 px | How far a panel, a menu, the message toolbar and a row travel |

- `--tr-fill` uses `--ease-out` instead of `ease`, and `--tr` moves `transform` in `--dur-1` on `--ease-out`.
- **Retired:** `--ease-spring`, `--ease-glide`, `--ease-sheet`, `--dur-press` and `--dur-view`, and
  `--shift-view` with the picture of the old view.
- **Reduced motion** (either setting) sets every duration to `0ms`, every animation delay to `0s` and `--press` to `1`.
  Script motion (the press, row motion, morphs) does not run.

## Where it lives

| What | Where |
| --- | --- |
| Dialogs, ⌘K, the drawer, sheets and their scrim | `ui/Overlay.tsx` (`settle`) |
| The detail panel | `ui/SidePanel.tsx` |
| Menus and popovers | `ui/pop.ts` (`usePop`) and `[data-pop]` in `ui/ui.css` |
| Toasts | `ui/Toast.tsx` |
| View and place switches | the routes in `app/AppLayout.tsx`; `ui/motion-rules.ts` |
| Surfaces that load their code | `app/DeferredSurfaces.tsx` |
| The sidebar's fold and unfold | `ui/SizeSwap.tsx` in the `aside` of `app/AppLayout.tsx` |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx`, `ui/motion.ts` |
| Rows that come, go and move | `ui/rowMotion.ts` |
| The press | `ui/press.ts` |
| The tokens and reduced motion | `ui/tokens.css`, `ui/ui.css`, `ui/moments.css` |

## Where main differs

The motion audit of main `a82ee012d` (2026-11-03, Chromium at 1440 and 390 px) found these gaps. Paths are under
`app/apps/web/src/`, and #863 fixes them in batches.

| Rule | What happens on main | Source |
| --- | --- | --- |
| 2 | The old view is held as a picture until the new one is ready (up to 500 ms), then fades for 150 ms on `--ease-in`, so two views overlap. Content is ready at 50–140 ms but settles at 205–354 ms | `ui/Dissolve.tsx:56,61,258,275`, `app/AppLayout.tsx:868`, `ui/tokens.css:108` |
| 6 | The first ⌘K dims, undims and dims again. The first task panel opens empty, then shows "Loading…", then its content (~400 ms). The thread panel opens empty, then its replies appear | `app/DeferredSurfaces.tsx:44-47,55-58`, `work/WorkDetails.tsx:124` |
| 4, 7 | One tab tap runs five motions on four easings: the press spring, the pill glide on `width`, the text colour, the view fade and a status morph. Opening a panel moves the panel and the work area on two curves | `ui/ui.css:151-166,173-192`, `ui/motion.ts:112`, `app/AppLayout.tsx:178` |
| 5 | A task notice's status icon flips on every visit to a conversation. A dropped board card fades in again on the server's answer and keeps a 900 ms highlight. Tab pills and map cards animate on first appearance | `app/ConversationStream.tsx:792,798`, `ui/motion.ts:300-307`, `work/TaskBoard.tsx:319-320,435-436`, `ui/rowMotion.ts:179-183`, `work/board.css:129`, `ui/ui.css:165`, `sketch/sketch.css:84` |
| 7 | Rows, cards and sidebar items scale to 0.97 with a 250 ms spring | `ui/press.ts:13-14,24-46` |
| 3 | Dialogs and toasts scale to .98; panels, sheets, dialogs, menus and toasts each enter differently; three switches use three timings | `ui/Overlay.tsx:133-136`, `ui/Toast.tsx:99`, `ui/SidePanel.tsx:138`, `create/create.css:66-67`, `app/settings.css:53,57`, `live/live.css:161-162` |
| 6 | Content jumps after it arrives: phone Home layout shift 0.50–0.62, the Wiki text moves 72 px, the thread layout shift is 0.089 | `app/Home.tsx:142-162` |
| 8 | Literal durations and easings | `work/board.css:12,73,88,129`, `app/project-conversation.css:202`, `ui/moments.css:20-21`, `ui/ui.css:39,55,183,237,241,359-363`, `composer/attachments.css:74`, `live/live.css:28`, `live/LiveBar.tsx:220`, `agent-connection/host-actions.css:4`, `agent-connection/connection.css:174,200`, `app/app.css:104,193`, `app/home.css:28,34` |
| 9 | The in-app Reduce motion keeps animation delays, and two rules check only the system setting | `ui/ui.css:358,430,435`, `ui/moments.css:19` |

## Verifying

- **Frame capture.** Record each common action as the audit did: open a space, a panel and a thread; switch views;
  send a message; open the phone sheet; Kreska's moments. Use Chromium and WebKit at 1440 and 390 px, read
  `document.getAnimations()` on every frame, and repeat with system reduced motion, the in-app setting, 4× CPU and a
  90 ms click. Each action shows its first change within 100 ms, runs one animation on the tokens, replays nothing on
  a refetch or the server's echo, and shifts no layout after its content arrives.
- **Existing tests.** `app/tests/ui/test_view_switch.py`, `test_sidebar_motion.py` and `test_light_motion.py` still
  assert the superseded crossfade, the held picture and the sidebar's width animation. #863 changes them together
  with the code.
