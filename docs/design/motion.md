# Motion in the application

How the final design's motion rules ([guide §2](final/README.md): pressing scales to 0.97 and springs back in about
250 ms, status changes morph, reduced motion shows the static frame, nothing moves for its own sake) are built, so a new
surface takes the same motion from the same places. Founder direction and acceptance criteria:
[#593](https://github.com/ColdPhase/flux/issues/593). This page records the implementation; it does not change the design.

## Tokens (`app/apps/web/src/ui/tokens.css`)

| Token | Value | Meaning |
| --- | --- | --- |
| `--dur-in` | 180 ms | Something enters: dialogs, ⌘K, the detail panel, menus, popovers, toasts, a panel's new content, a row growing in. |
| `--dur-out` | 120 ms | Something leaves. It is never held: focus has already returned and the next action is possible. |
| `--dur-view` | 150 ms | The content area crossfades on a view or place switch. |
| `--dur-press` | 250 ms | A pressed control springs back (`--ease-spring`); the press itself takes `--dur-1`. |
| `--press` | .97 | The one press scale. |
| `--shift-panel` / `--shift-pop` / `--shift-toolbar` | 16 / 4 / 6 px | How far content, a menu and the message toolbar travel. |

Under `prefers-reduced-motion: reduce` and Settings → Appearance → Reduce motion every duration is `0ms` and `--press` is
`1`, and script motion (`play`, `settle`, the press, row motion) does not run: the end state is there at once.

## Rules

- Only `opacity` and `transform` animate. A row's height animates only to grow it in or collapse it (`rowMotion.ts`).
- A control never changes place (Spokój rule 7): a view switch fades the content area (opacity only), a panel's content
  change moves the body's content, never the shell, its head or its controls.
- Nothing moves on its own on first load (`markMotionReady`, a quarter of a second after the shell has committed and
  painted; motion that answers the person's own input still runs), while the page is hidden (`installMotionGuards` ends
  transient motion and pauses loops) or under reduced motion.
- Exit never delays focus or the next action: focus returns in the same task as the close, the leaving surface is `inert`.
- Closing while opening, or opening while closing, continues from where the surface is (`settle`), so it settles on the
  latest state and never snaps.
- Menus and popovers leave through `usePop`. The project header's More menu comes in with the same motion but leaves at
  once until [#606](https://github.com/ColdPhase/flux/issues/606) gives it popover styles: it is an in-flow row of the
  header today, and a menu that lingered would move the controls beside it.
- Nothing loops or pulses for attention here. Kreska's moments (#352) and the traveling highlight (#155) have their own rules.

## Where it lives

| What | Where |
| --- | --- |
| Dialogs, ⌘K, the drawer, sheets and their scrim | `ui/Overlay.tsx` (`settle`) |
| The detail panel and what it shows; direction of travel from the history depth | `ui/SidePanel.tsx` (`usePanelSwap`, `contentKey`, `depth`) |
| Menus and popovers | `ui/pop.ts` (`usePop`) and `[data-pop]` in `ui/ui.css` |
| Toasts | `ui/Toast.tsx` |
| View and place switches | the content-area effect in `app/AppLayout.tsx` and `routeView` in `ui/motion-rules.ts` |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx` (`useMorph`) |
| Rows that come, go and move | `ui/rowMotion.ts` (`useRowMotion`) |
| The press | `ui/press.ts` (`installPress`) |
| A control that appears on hover (the message toolbar) | `.ui-reveal` and `.is-shown` in `ui/ui.css` |

## Verifying

`app/tests/ui/test_light_motion.py` reads what the page asked the browser to run (durations, easing, animated properties) and
samples boxes frame by frame; `motion_evidence.py` films the journeys and `motion_light_performance.py` measures frame
times (opt-in, like #155's `motion_performance.py`).
