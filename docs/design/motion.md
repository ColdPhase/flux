# Motion in Flux

**Status.** Founder direction by Hubert ([@PelikanFix16](https://github.com/PelikanFix16)) on 2026-11-03, given after
the motion audit of [#863](https://github.com/ColdPhase/flux/issues/863) (main `a82ee012d`) and recorded in
[F-038](../product/decisions.md#f-038--a-simpler-flux). It is one rule set for all of Flux, on the computer and the phone.

It supersedes two earlier rules:

- the old-to-new crossfade of view switches, with the old view held as a picture
  ([#593](https://github.com/ColdPhase/flux/issues/593), [#719](https://github.com/ColdPhase/flux/issues/719));
- the press of the [final design](final/README.md) §2 before 2026-11-03: a scale to 0.97 that springs back in about 250 ms.

The application follows these rules since #863 ([what changed](#what-863-changed)); the few places that
still differ are listed there under [Still open](#still-open).

Values marked **proposed** (a dialog's 8 px travel and the 64 px bound for a scaling control) come from the
motion audit and the coordinator's reading, not from Hubert's decision on #863. #863 settled them as written below
(the highlight token is `--dur-highlight`); the rule that uses them stays as written.

## Rules

1. **Feedback within 100 ms.** A press, tap or key shows a visible change within 100 ms, as a change of colour or fill.
2. **A view switch shows the new screen at once.** Switching a space's view or going to another place (Home, Inbox,
   a space, Settings) puts the new screen in place at once. It may fade in over at most 120 ms on `--ease-out`. The
   old view is never held and never crossfades with the new one. A screen whose content is still loading shows its own
   calm loading state, in its final layout. The content of a panel that is replaced (a task by a thread) follows the
   same rule, and a thread opens its panel on the frame of the press, with its loading rows, though the conversation's
   reads are still out. The router still waits for a view's code and reads before it commits the route (the old view
   stays mounted underneath, hidden, so a cancelled switch finds it as it was, and its keys do not act while it is
   hidden: unmodified keys other than Tab and Escape stop at the window, unless typed into a field, a menu or a
   dialog); committing the new view before its reads are here, and the loading states that are not yet in the final
   layout, are [Still open](#still-open).
3. **Surfaces share one vocabulary.** Panels, dialogs, menus, popovers, sheets and the drawer all move the same way.
   - They enter in 180 ms on `--ease-out` and leave in 120 ms on `--ease-in`.
   - The motion is a fade plus a short travel from their edge or anchor: 16 px for a panel (`--shift-panel`), 4 px
     for a menu or popover (`--shift-pop`), 8 px for a dialog and from the screen edge for a sheet or drawer.
   - There is no scale and no overshoot.
   - Leaving never delays focus or the next action. Closing while a surface opens, or the reverse, continues from
     where it is.
4. **One motion per action.** An action makes one motion. The work area beside a panel or a sheet reflows without
   animation. The sidebar's fold is the one exception (rule 8). Indicators (the view switch's underline, a segmented
   control, the phone tab bar) move with `transform` in `--dur-1` on `--ease-out`, or at once, and never animate
   `width`.
5. **Nothing animates without a change by the person.** Nothing moves when it first appears (a view, its tabs, the
   notes and cards on a screen), on a refetch, on a live update of what is on screen, or on the server's echo of your
   own change. The one arrival that animates is a new message at the end of the conversation you are reading (a short
   fade, #155). A state glyph morphs only from a known previous state. A highlight, such as a message you jumped to,
   lasts at most 600 ms and takes its duration from one token. A label that has to be read (the "Source of #1" tag, 2 s)
   is text, not a highlight, and has no motion. Kreska's expression is the other exception: its one-shot motion plays
   once when the face appears or its expression changes ([final design §3](final/README.md#3-kreska-logo-agent-icon-and-mascot),
   [#1342](https://github.com/ColdPhase/flux/issues/1342)).
6. **A surface opens with its content.** Preload what a surface shows, when the browser is idle or on pointer down.
   Never show a fallback that animates out, or a surface that opens empty and fills in afterwards. When a skeleton is
   needed, it has the final layout's heights, so nothing jumps when the content arrives. A skeleton draws only layout
   it knows: a task opened from its row shows its own title in the title's box, and the rows below it (fixed heights)
   follow at their places; ⌘K lists as many recent places as it will. Where the layout depends on text not yet read (a
   decision's lead, a task's title when the opener does not have it) the skeleton is a title bar and some quiet lines,
   with no rows or sections at guessed places. Content that may not come (Home's Continue card) is last on its page, so
   nothing sits under it and no space is kept for it.
7. **Press is colour only.** A pressed control changes its fill or colour. Small controls (a button or icon button up
   to 64 px on its longest side) may also scale to .98 and back over `--dur-1` on `--ease-out`, with no spring. Rows,
   cards, list items, links and sidebar items never scale.
8. **Only opacity and transform, from tokens.** Width, height and layout never animate, with one named exception:
   **the sidebar's fold to the rail and its unfold** ([#720](https://github.com/ColdPhase/flux/issues/720)) keeps its
   smooth width animation, and the content beside it adapts during the fold (Hubert, 2026-11-03, on
   [#863](https://github.com/ColdPhase/flux/issues/863)). CSS and script take every duration and easing from the
   tokens below, the sidebar's width animation included; no literal values such as `ease`, `.2s` or 900 ms.
   `--ease-spring`, `--ease-glide` and `--ease-sheet` are retired.
9. **Reduced motion sets every duration and delay to zero.** This follows the system's reduced-motion setting alone
   (Settings has no switch for it, [#1419](https://github.com/ColdPhase/flux/issues/1419) item 17), including animation delays, so the end state is there at once. A loop runs only
   while real work is in progress or, for Kreska, while its ongoing state lasts; under reduced motion, and with Kreska's
   small moments off, Kreska's expressions show their static frame ([final design §3](final/README.md#3-kreska-logo-agent-icon-and-mascot)).

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
  place instead. A row that is added fades in where it stands, a row that goes is gone, and the rows around it slide to
  close or open the gap; no row animates its height, and the server's answer never replays the motion. A card dropped on
  the board has this motion only: the card slides to its column at the drop, with no tint at the answer.
- **The two-height phone sheet** moves between its half and full heights with `transform`, not `height`. Going up it
  takes the full height at once and its top edge rises from where it was. Going down it keeps the full height while it
  travels, so its bottom edge stays on the screen's edge, and takes the half height when it arrives.
- **Toasts** follow the surface vocabulary of rule 3.
- **Notices** ([#1243](https://github.com/ColdPhase/flux/issues/1243), [final design](final/README.md#notices)) are
  surfaces too, and the one arrival that someone else causes which moves: the card enters in `--dur-in` on `--ease-out`
  with an 8 px travel from its edge (`translateY(8px)` at the bottom right of the computer, `translateY(-8px)` at the
  top of the phone) and leaves in `--dur-out` on `--ease-in`. A newer notice that replaces or joins the one shown
  changes its text in place with no motion, so a burst of messages moves the card once. Reduced motion shows and
  removes it at once.

### Reordering spaces

Founder direction by Hubert on 2026-11-10, on [#1250](https://github.com/ColdPhase/flux/issues/1250): the person's own reordering of
the Spaces list is animated, within these rules (only `opacity` and `transform`, every duration and easing from the tokens, no
spring, no scale of a sidebar item, instant with reduced motion). It is the person's own input, so it is the action's one motion.

- **Pick up.** On the start of a drag (a mouse) or after the long press (touch) the dragged row lifts: the `--el` fill and the
  `--sh-pop` shadow. The slot it will land in is a quiet `--sub` mark at slight opacity (it is where the gap is). There is no scale.
- **While dragging.** The row follows the pointer on `transform: translateY` only, clamped to the Spaces list (Everyone stays fixed
  at the top and is never passed). The other rows **slide out of the way** with `transform` over `--dur-1` on `--ease-out` as the
  dragged row crosses each one's midpoint, so the gap always shows where it will land.
- **Drop.** The row settles into the gap over `--dur-1` on `--ease-out`; the others are already in place, so nothing jumps. A
  cancelled drag (Esc, or released outside the list) glides back to its original slot the same way.
- **The selected space.** While a row is dragged the open space's highlight is part of its row, so it goes with that row as it
  is dragged or slides out of the way, and it lands with it: the sidebar's traveling highlight takes its place without motion when the
  drop ends, so there is no second motion after the drop. The highlight travels only when the selection changes, never because
  its row moved.
- **Edge scroll.** Near the list's top or bottom edge a long list scrolls itself while the pointer is held there.
- **Keyboard and screen readers.** ⋯ › Move up / Move down moves the row one step with the same slide over `--dur-1` and keeps focus
  on it; a polite live region says "Release check, moved to position 3 of 8".
- **Other tabs.** They receive the new order without animation: rows move only in answer to the person's own input (rule 5).
- **Phone and touch.** A long press starts the drag, with a light haptic where available. Scrolling the list never starts one.
- **Reduced motion** (either setting) puts every row at its place at once: the drag follows the pointer and the drop is instant.

## Tokens (`app/apps/web/src/ui/tokens.css`)

The values after #863:

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 120 ms | Press, fills, a view's fade-in, indicators, switches |
| `--dur-in` | 180 ms | A surface enters |
| `--dur-out` | 120 ms | A surface leaves |
| `--dur-highlight` | 600 ms | A highlight (rule 5): the most it lasts; Kreska's one-shot expression (once or twice it) |
| `--dur-spin` / `--dur-loop` | 800 ms / 1600 ms | A spinner turns; a calm pulse, wave or blink loops (while real work is in progress, or Kreska's ongoing state lasts) |
| `--delay-wait` / `--delay-tip` | 350 ms / 450 ms | The wait before a loading skeleton or a tooltip shows, so a quick change never flashes it |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | Entering, a view's fade-in, indicators, the release of a press |
| `--ease-in` | `cubic-bezier(.4, 0, 1, 1)` | Leaving |
| `--ease-loop` / `--ease-linear` | `ease-in-out` / `linear` | A loop; a rotation |
| `--press` | .98 | Small controls only |
| `--act` / `--inv-act` | `#d2d2d6` / `#47474d` (light), `#383838` / `#c2c2c2` (dark) | The fill of a pressed control, one notch deeper than `--hov` / `--inv-hov`; while a control is pressed its `--hov` is `--act` |
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
| Notices | `notifications/Notices.tsx` (its code comes through `DeferredNotices` in `app/DeferredSurfaces.tsx`, #1428) |
| View and place switches | `ui/ViewFade.tsx` around the routes in `app/AppLayout.tsx`; `ui/motion-rules.ts` |
| Surfaces that load their code (Details, Jump to…, the live strip, the Create window, the notice card) | `app/DeferredSurfaces.tsx` (preloaded when the browser is idle soon after the shell is up, and on the first pointer-down or ⌘/Ctrl); their skeletons in `app/SurfaceSkeletons.tsx` |
| The loading state of a screen a switch goes to | `app/PendingView.tsx` (the loading state, the thread's panel and the hidden view's keys) over the old view, in `app/AppLayout.tsx`; the code of a project's other views is fetched when idle in `app/viewChunks.ts` |
| The sidebar's fold and unfold | `ui/SizeSwap.tsx` in the `aside` of `app/AppLayout.tsx` |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx`, `ui/motion.ts` |
| Kreska's expressions (one-shots and loops, #1342) | `ui/Kreska.tsx` and the Kreska rules in `ui/ui.css`; the marks' gap through the motion in `tests/app/kreska-marks.test.ts` |
| Rows that come, go and move | `ui/rowMotion.ts` (one motion per input, `claimInput` in `ui/motion.ts`) |
| The press | `ui/press.ts` |
| Reordering the Spaces list (drag, long press, ⋯ › Move up and Move down) | `ui/reorder.ts` (`useReorder`), used by `app/SpaceOrder.tsx` |
| The tokens and reduced motion | `ui/tokens.css`, `ui/ui.css`, `ui/moments.css` |

## What #863 changed

The motion audit of main `a82ee012d` (2026-11-03, Chromium at 1440 and 390 px) found the gaps below. #863 closed them.
Paths are under `app/apps/web/src/`.

| Rule | What it was | Now |
| --- | --- | --- |
| 2 | The old view was held as a picture until the new one was ready (up to 500 ms), then faded 150 ms on `--ease-in` (`ui/Dissolve.tsx`) | `ui/ViewFade.tsx`: the new screen is in place at once and fades in over `--dur-1` on `--ease-out`; the picture, `--dur-view` and `--shift-view` are gone. While the router waits for the new route's code and reads, `app/PendingView.tsx` stands in the content area from the first frame (the old view stays mounted, hidden), and the stream's loading rows show at once, not after `--delay-wait`. A replaced panel content does the same (`ui/SidePanel.tsx`) |
| 6 | The first ⌘K dimmed, undimmed and dimmed again; the first task panel opened empty, then "Loading…", then content; the thread panel opened empty | `app/DeferredSurfaces.tsx` loads Jump to… inside its one dialog and fetches it and Details when the browser is idle soon after the shell is up and on the first pointer-down or ⌘/Ctrl; their fallbacks are skeletons, not a spinner (`app/SurfaceSkeletons.tsx`): a task's own title and fixed rows, quiet lines where the layout is not known, and ⌘K in its own markup with as many rows as it will have, the close control in its field row; ⌘K leaves at its size, its content kept through the 120 ms exit; the thread's panel is up on the frame of the press (`ThreadOpening`) and shows the same loading rows as the thread (`conversations/ThreadFeed.tsx`) |
| 4, 7 | A tab tap ran five motions on four easings (the press spring, the pill glide on `width`, …); a panel and the work area moved on two curves | Indicators move with `transform` over `--dur-1` on `--ease-out` and never animate `width`; the work area reflows without animation (no FLIP) |
| 5 | A task notice's status icon flipped on every visit; a dropped board card restarted on the server's echo; tab pills and map cards animated on first appearance; notes rose on every visit | A state glyph morphs only from a known value; a list's rows move only as the answer to the person's own input, once (`claimInput`); the board has no tint at the server's answer; the tab indicator, the map's cards and the notes already on screen do not animate when they first appear (only the note just saved rises); highlights use `--dur-highlight` |
| 7 | Rows, cards and sidebar items scaled to 0.97 with a 250 ms spring (`ui/press.ts`) | A press is colour (`--act`, `--inv-act`, in `ui/ui.css`), so it shows with a mouse as well as a touch; a small button also scales to .98 and back over `--dur-1`, no spring |
| 3 | Dialogs and toasts scaled; panels, sheets, dialogs, menus and toasts each entered differently; three switches used three timings | 180 ms in on `--ease-out`, 120 ms out on `--ease-in`, a fade plus a short travel (the drawer and the phone sheet fade as well), no scale; one switch rule (`--dur-1`) |
| 2 | A hidden view's key handlers (the Inbox's `e` and `a`) still acted while a switch waited | `useQuietViewKeys` in `app/PendingView.tsx` |
| 6 | Phone Home shifted 0.50–0.62 when Continue arrived | `app/Home.tsx` puts Continue last, so nothing sits under it and no space is kept for it while it is read (`test_light_motion` `test_25`) |
| 8 | Literal durations and easings; rows grew and collapsed on `height` | Every duration and easing comes from a token; rows never animate `height` (`ui/rowMotion.ts`); the two-height phone sheet moves with `transform` in both directions (`ui/DetentSheet.tsx`) |
| 9 | The in-app Reduce motion kept animation delays; two rules checked only the system setting | The system setting zeroes durations and delays (the in-app switch went, #1419 item 17) |
| 3 | A thread's panel left empty: its text was gone on the first frame and it faded as a blank box on a computer, and the phone's sheet went at once with no fade (#901). The thread is the view's own and goes with its route | `OwnedPanelContent` (`app/ownedPanel.tsx`) leaves an inert copy of what it showed in the panel's slot as the view unmounts, so the 120 ms exit of the panel (docked, overlay or the phone's sheet) carries its content. New content in the slot removes the copy at once, and so does the panel's end. `SidePanel` (`ui/SidePanel.tsx`) also keeps what its head says and which kind of sheet it is from the last time it was open, for the length of the exit: on the phone the sheet of a task, decision or thread used to be swapped for the plain sheet the moment the object closed, which removed the leaving one with no fade (`test_light_motion` `test_10k`, computer and phone) |

## Still open

What #863 does not close, and where it goes:

- **Committing a view before its reads are here.** The router still runs a route's loader (the conversation, Tasks, the Wiki, and a thread's
  conversation) before it commits the route, so for the length of the reads the new screen, or the thread's panel, is its loading
  state (`app/PendingView.tsx`), not the view itself, and the old view is not usable meanwhile. Making the loaders non-blocking (the view commits at once and fills in, with the last
  answer shown while it is read again) is the client data layer, live push and instant actions of the next wave
  ([#862](https://github.com/ColdPhase/flux/issues/862)). Until then rule 2's "the new screen in place at once" is met by the loading state.
- **Loading states that are not yet in the final layout (rule 2).** `app/PendingView.tsx` draws a shape by destination (a feed, a list, the
  Tasks board, cards, a page), not each destination's exact layout. The Tasks board's shape is its control row and four columns, or a list for a
  person who shows Tasks as a list (#902); the Map's and the Wiki's are approximations. Drawing each view's own layout there, or committing the
  view itself once the loaders no longer block, closes it.
- **A skeleton draws only the layout it knows (rule 6).** A decision's or a result's panel, and a task opened from a link, show a title bar and
  quiet lines, not the rows of the layout they will have, because its heights depend on text that is not read yet.
- The Wiki text that moves 72 px, and the layout shift of phone Home when the Needs you rows arrive (0.17) (rule 6).
- A single input answered by one motion is judged by `claimInput`, which accepts the first change within 2 s of any input, not the
  input that caused it; an unrelated click could let a live update animate once.

## Verifying

- **Frame capture.** Record each common action as the audit did: open a space, a panel and a thread; switch views;
  send a message; open the phone sheet; Kreska's moments. Use Chromium and WebKit at 1440 and 390 px, read
  `document.getAnimations()` on every frame, and repeat with system reduced motion, the in-app setting, 4× CPU and a
  90 ms click. Each action shows its first change within 100 ms, runs one animation on the tokens, replays nothing on
  a refetch or the server's echo, and shifts no layout after its content arrives.
- **Reordering.** `app/tests/ui/test_space_order.py` samples every frame of a drag, a drop, a cancel and a keyboard move in both
  engines, with a mouse and with touch: only `transform` and `opacity` change, the other rows slide over `--dur-1`, Everyone never
  moves, and with reduced motion every move is instant.
- **Existing tests.** `app/tests/ui/test_view_switch.py` and `test_light_motion.py` assert these rules (no held
  picture, a fade-in of at most 120 ms, the press, the tokens). `test_sidebar_motion.py` keeps asserting the sidebar's
  width animation, which stays.
