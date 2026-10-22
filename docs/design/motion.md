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
| `--shift-row` / `--row-travel-max` | 12 / 160 px | How far a row that moved across the list comes in from, and the longest distance a row is carried (see below). |

Under `prefers-reduced-motion: reduce` and Settings → Appearance → Reduce motion every duration is `0ms` and `--press` is
`1`, and script motion (`play`, `settle`, the press, row motion) does not run: the end state is there at once.

## Rules

- Only `opacity` and `transform` animate. A row's height animates only to grow it in or collapse it (`rowMotion.ts`).
- Motion is short and calm. A row that moved a few rows slides there (260 ms); a row that moved more than `--row-travel-max` (a state
  change that sends it to another group far down or up the list, a card to another column) is not carried across the list: it
  fades in at its new place with a `--shift-row` slide from the side it came from (180 ms). The rows it moved past slide by their
  own, short, displacement. `test_13b_...` holds the cap.
- A control never changes place (Spokój rule 7). A switch of view or place and a change of a panel's content are old-to-new
  crossfades (`ui/Dissolve.tsx`): the new content is put in one commit, live and in place from the first frame; the outgoing content
  is kept as an inert picture of itself over it for `--dur-out` (a panel) or `--dur-view` (a view), fades out and travels a few
  pixels in the direction of travel (a view to the right of the last is forward, so Back out of it reverses; a panel's history
  depth says the same for "‹ back"). The header, sidebar and tab bar (and a panel's shell, head and controls) are not in it and
  never move; the route-progress line lies over the work (it takes no room), so nothing is pushed down while the next view loads.
  The picture is a deep copy without ids, `inert` and `aria-hidden`, taking no pointer input, so the new content works from the
  first frame. It is not part of the page's own tree: it is a layer of its own at the end of `body`, inside a closed shadow root
  that wears the page's style sheets, dressed in empty, box-less copies of the host's ancestors so the same selectors style it.
  No query of the page (a class, a text, a role, `#details .wd-eyebrow`) can find a second copy of what is on show. Its one
  difference from the original: the page's `:root[...]` rules do not reach into it (a few shadows and fills for the length of a
  fade). Scroll positions in it are copied, so the old content does not jump. This is the CSS path the issue allows
  ("the View Transitions API where supported, otherwise CSS"); the browser's API was tried and not kept: it holds rendering and hit
  testing while it takes its picture, defers the DOM update by a frame or two (so a navigation or click right after another lands on
  the stale page), and its skipped-transition rejections surfaced as uncaught page errors in WebKit and Chromium alike.
- Nothing moves on its own on first load (`markMotionReady`, a quarter of a second after the shell has committed and
  painted; motion that answers the person's own input still runs), while the page is hidden or under reduced motion.
  `installMotionGuards` lands every transient animation on its end state when the page is hidden (the helpers' own, which
  include the pictures' fade, and a menu's `ui-pop-*` entry or exit), lets go of a press in flight (the press's own animation, `PRESS_ID`) and pauses loops.
- Exit never delays focus or the next action: focus returns in the same task as the close, the leaving surface is `inert`.
- Closing while opening, or opening while closing, continues from where the surface is (`settle`), so it settles on the
  latest state and never snaps.
- Menus and popovers enter and leave through `usePop` and `[data-pop]`: the composer's `@` and `/` menu, a message's ⋯ menu and
  its scrim, the project header's More menu, the Status and other property menus, the board's Move menu, the model picker, the
  user menu and the assistant, wiki and live popovers. The menu stays mounted and `inert` for `--dur-out` while focus has
  already returned (the field keeps it, or the button gets it back in the same task). The More menu is a popover over the header
  ([#606](https://github.com/ColdPhase/flux/issues/606)), so the controls beside it never move while it fades. Disclosure rows that are part of the
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
| The outgoing content of a panel or a view | `ui/Dissolve.tsx` (around the panel's body in `ui/SidePanel.tsx` and around the routes in `app/AppLayout.tsx`) |
| The detail panel and what it shows; direction of travel from the history depth | `ui/SidePanel.tsx` (`usePanelSwap`, `contentKey`, `depth`) |
| Menus and popovers | `ui/pop.ts` (`usePop`) and `[data-pop]` in `ui/ui.css`; the composer's menu (`app/ComposerMenu.tsx`) and a message's (`work/messageActions.tsx`) keep their last content while they leave |
| Toasts | `ui/Toast.tsx` |
| View and place switches | `Dissolve` around the routes in `app/AppLayout.tsx`; `routeView`, `viewRank` and `viewDirection` in `ui/motion-rules.ts` |
| State changes | `ui/StatusGlyph.tsx`, `ui/Morph.tsx` (`useMorph`) |
| Rows that come, go and move | `ui/rowMotion.ts` (`useRowMotion`) |
| The press | `ui/press.ts` (`installPress`) |
| A control that appears on hover (the message toolbar) | `.ui-reveal` and `.is-shown` in `ui/ui.css` |

## Verifying

`app/tests/ui/test_light_motion.py` reads what the page asked the browser to run (durations, easing, animated properties) and
samples boxes frame by frame; `motion_evidence.py` films the journeys and `motion_light_performance.py` measures frame
times (opt-in, like #155's `motion_performance.py`).

Review recordings (Chromium and WebKit, light and dark, one short animated WebP per motion), animation logs and Chromium frame times
for PR #608 are kept in the immutable commit
[`8905d4d15`](https://github.com/ColdPhase/flux/tree/8905d4d15290f314bd5ce034191eed94cb36fe8c/docs/design/motion-evidence/593), not in the
current tree, because committed evidence is downloaded by every clone ([#319](https://github.com/ColdPhase/flux/issues/319)). Cut
a new set with `motion_evidence.py` (`test_clips_for_the_review`) and `scripts/pack_motion_evidence.py`.
