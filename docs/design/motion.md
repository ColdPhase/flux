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
- A control never changes place (Spokój rule 7). A switch of view or place and a change of a panel's content are old-to-new
  crossfades: the outgoing content is kept, fades out over the new content and travels a few pixels in the direction of travel
  (a view to the right of the last is forward, so Back out of it reverses; a panel's history depth says the same for "‹ back").
  The new content is in place from the first frame and never moves, and the header, sidebar and tab bar (and a panel's shell,
  head and controls) never move. The route-progress line lies over the work (it takes no room), so nothing is pushed down
  while the next view loads. Nothing in the outgoing content can be reached, focused or heard, and it takes no pointer input,
  so the new content works from the first frame.
  - **Views and places** use the View Transitions API (`ui/viewTransition.ts`, asked for in `router.tsx`, drawn by `:root[data-vt]`
    rules in `ui/ui.css`): the browser holds a picture of the old content area in its own layer, outside the document, so nothing
    answers a selector twice. The page outside the content area is not in the transition. The browser holds rendering and hit
    testing for the frame or two in which it takes its picture of the old page; from then on the live page answers. Two
    dissolves never overlap (a second switch swaps), and a skipped transition is quiet (`installViewTransitionGuard`). Where the API is missing (an engine the application does not support yet) the new content fades
    in instead; under reduced motion the view just swaps.
  - **A panel's content** uses `ui/Dissolve.tsx`: a deep copy of the outgoing content, without ids, `inert` and `aria-hidden`, lies
    over the panel's body for `--dur-out` while the new content slides in (`usePanelSwap`). The copy is a layer of its own on the page
    (dressed in empty, box-less copies of the panel's ancestors so the same selectors style it), not a child of the panel: a
    query scoped to the panel (`#details .wd-eyebrow`) finds the new content only, never two of it.
- Nothing moves on its own on first load (`markMotionReady`, a quarter of a second after the shell has committed and
  painted; motion that answers the person's own input still runs), while the page is hidden or under reduced motion.
  `installMotionGuards` lands every transient animation on its end state when the page is hidden (the helpers' own, a menu's
  `ui-pop-*` entry or exit, a view's `flux-vt-*` dissolve), lets go of a press in flight (the press's own animation, `PRESS_ID`) and pauses loops.
- Exit never delays focus or the next action: focus returns in the same task as the close, the leaving surface is `inert`.
- Closing while opening, or opening while closing, continues from where the surface is (`settle`), so it settles on the
  latest state and never snaps.
- Menus and popovers enter and leave through `usePop` and `[data-pop]`: the composer's `@` and `/` menu, a message's ⋯ menu and
  its scrim, the project header's More menu, the Status and other property menus, the board's Move menu, the model picker, the
  user menu and the assistant, wiki and live popovers. The menu stays mounted and `inert` for `--dur-out` while focus has
  already returned (the field keeps it, or the button gets it back in the same task). Until
  [#606](https://github.com/ColdPhase/flux/issues/606) gives the More menu popover styles it is an in-flow row beside its button;
  while it leaves it lies over the header, so the controls beside it are in place at once. Disclosure rows that are part of the
  page's flow (the sketch outline's "More actions" row, the "Together" note) are not menus: they take room, so they open and
  close without a fade rather than move what is beside them.
- The drawer and the phone sheet take the same 180 ms in and 120 ms out as the dialog; they travel from their edge on `--ease-sheet`.
  The two-height sheet's half and full heights (`ui.css`, `.ui-detent-sheet`, from #344) and the grabber's width on hover are the
  application's existing layout transitions; they are not part of this work and are not opacity or transform.
- Nothing loops or pulses for attention here. Kreska's moments (#352) and the traveling highlight (#155) have their own rules.

## Where it lives

| What | Where |
| --- | --- |
| Dialogs, ⌘K, the drawer, sheets and their scrim | `ui/Overlay.tsx` (`settle`) |
| The outgoing content of a panel | `ui/Dissolve.tsx` (used by `ui/SidePanel.tsx`) |
| The detail panel and what it shows; direction of travel from the history depth | `ui/SidePanel.tsx` (`usePanelSwap`, `contentKey`, `depth`) |
| Menus and popovers | `ui/pop.ts` (`usePop`) and `[data-pop]` in `ui/ui.css`; the composer's menu (`app/ComposerMenu.tsx`) and a message's (`work/messageActions.tsx`) keep their last content while they leave |
| Toasts | `ui/Toast.tsx` |
| View and place switches | `router.tsx` (asks for the transition), `ui/viewTransition.ts`, `:root[data-vt]` in `ui/ui.css`, `routeView` and `viewRank` in `ui/motion-rules.ts` (the fade-in fallback is in `app/AppLayout.tsx`) |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx` (`useMorph`) |
| Rows that come, go and move | `ui/rowMotion.ts` (`useRowMotion`) |
| The press | `ui/press.ts` (`installPress`) |
| A control that appears on hover (the message toolbar) | `.ui-reveal` and `.is-shown` in `ui/ui.css` |

## Verifying

`app/tests/ui/test_light_motion.py` reads what the page asked the browser to run (durations, easing, animated properties) and
samples boxes frame by frame; `motion_evidence.py` films the journeys and `motion_light_performance.py` measures frame
times (opt-in, like #155's `motion_performance.py`).

Review recordings (Chromium and WebKit, light and dark, one per motion), per-frame samples and how they were made are in
[`motion-evidence/593/`](motion-evidence/593/README.md): small cropped WebP, because committed evidence is downloaded by every
clone ([#319](https://github.com/ColdPhase/flux/issues/319)).
