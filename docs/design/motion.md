# Motion in the application

How the final design's motion rules ([guide §2](final/README.md): pressing scales to 0.97 and springs back in about
250 ms, status changes morph, reduced motion shows the static frame, nothing moves for its own sake) are built, so a new
surface takes the same motion from the same places. Founder direction and acceptance criteria:
[#593](https://github.com/ColdPhase/flux/issues/593). This page records the implementation; it does not change the design.

## Tokens (`app/apps/web/src/ui/tokens.css`)

| Token | Value | Meaning |
| --- | --- | --- |
| `--dur-in` | 180 ms | Something enters: dialogs, ⌘K, the drawer, the phone sheet, the detail panel, menus, popovers, toasts, a panel's new content, a row growing in. |
| `--dur-out` | 120 ms | Something leaves. It is never held: focus has already returned and the next action is possible. |
| `--dur-view` | 150 ms | The old content of a view or place dissolves over the new. |
| `--dur-press` | 250 ms | A pressed control springs back (`--ease-spring`); the press itself takes `--dur-1`. |
| `--press` | .97 | The one press scale. |
| `--shift-panel` / `--shift-view` / `--shift-pop` / `--shift-toolbar` | 16 / 10 / 4 / 6 px | How far a panel's content, a view's old content, a menu and the message toolbar travel. |

Under `prefers-reduced-motion: reduce` and Settings → Appearance → Reduce motion every duration is `0ms` and `--press` is
`1`, and script motion (`play`, `settle`, the press, row motion) does not run: the end state is there at once.

## Rules

- Only `opacity` and `transform` animate. A row's height animates only to grow it in or collapse it (`rowMotion.ts`).
- A control never changes place (Spokój rule 7). A view switch or a panel's content change is a dissolve (`Dissolve`): the
  outgoing content stays as an inert picture of itself, fades out over the new content and travels a few pixels in the
  direction of travel (a view to the right of the last is forward, so Back out of it reverses; a panel's depth says the same
  for "‹ back"). The new content is in place from the first frame and never moves, and the shell, the head and the
  controls of a panel and the header, sidebar and tab bar never move. The route-progress line lies over the work (it takes
  no room), so nothing is pushed down while the next view loads.
- Nothing moves on its own on first load (`markMotionReady`, a quarter of a second after the shell has committed and
  painted; motion that answers the person's own input still runs), while the page is hidden (`installMotionGuards` ends
  transient motion and pauses loops) or under reduced motion.
- Exit never delays focus or the next action: focus returns in the same task as the close, the leaving surface is `inert`.
- Closing while opening, or opening while closing, continues from where the surface is (`settle`), so it settles on the
  latest state and never snaps.
- Menus and popovers enter and leave through `usePop` and `[data-pop]` (the composer's menu, a message's ⋯ menu and the project
  header's More menu included). Until [#606](https://github.com/ColdPhase/flux/issues/606) gives the More menu popover styles it is an
  in-flow row beside its button; while it leaves it lies over the header, so the controls beside it are in place at once.
- The drawer and the phone sheet take the same 180 ms in and 120 ms out as the dialog; they travel from their edge on `--ease-sheet`.
  The two-height sheet's half and full heights (`ui.css`, `.ui-detent-sheet`, from #344) and the grabber's width on hover are the
  application's existing layout transitions; they are not part of this work and are not opacity or transform.
- Nothing loops or pulses for attention here. Kreska's moments (#352) and the traveling highlight (#155) have their own rules.

## Where it lives

| What | Where |
| --- | --- |
| Dialogs, ⌘K, the drawer, sheets and their scrim | `ui/Overlay.tsx` (`settle`) |
| The outgoing content of a view or a panel | `ui/Dissolve.tsx` (used by `ui/SidePanel.tsx` and the content area in `app/AppLayout.tsx`) |
| The detail panel and what it shows; direction of travel from the history depth | `ui/SidePanel.tsx` (`usePanelSwap`, `contentKey`, `depth`) |
| Menus and popovers | `ui/pop.ts` (`usePop`) and `[data-pop]` in `ui/ui.css`; the composer's menu (`app/ComposerMenu.tsx`) and a message's (`work/messageActions.tsx`) keep their last content while they leave |
| Toasts | `ui/Toast.tsx` |
| View and place switches | `Dissolve` around the content area in `app/AppLayout.tsx` and `routeView` in `ui/motion-rules.ts` |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx` (`useMorph`) |
| Rows that come, go and move | `ui/rowMotion.ts` (`useRowMotion`) |
| The press | `ui/press.ts` (`installPress`) |
| A control that appears on hover (the message toolbar) | `.ui-reveal` and `.is-shown` in `ui/ui.css` |

## Verifying

`app/tests/ui/test_light_motion.py` reads what the page asked the browser to run (durations, easing, animated properties) and
samples boxes frame by frame; `motion_evidence.py` films the journeys and `motion_light_performance.py` measures frame
times (opt-in, like #155's `motion_performance.py`).
