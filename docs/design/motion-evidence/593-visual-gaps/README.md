# #593 light motion: the two evidence gaps of the neutral visual review (PR #608)

Recorded on application head `67b77c6e94bc803415de137e97616404c0e91001` (branch `claude-maurycy/593-light-motion`; the commits after the
application changes are tests and documentation). This commit adds the recordings and the next one removes them from the tree again
([#319](https://github.com/ColdPhase/flux/issues/319)); the PR links the files at this commit. It answers
[the visual review](https://github.com/ColdPhase/flux/pull/608#issuecomment-6351782059); the first set of recordings is at
`8905d4d15290f314bd5ce034191eed94cb36fe8c`.

Animated WebP, cropped (open in a browser), cut by `scripts/pack_motion_evidence.py` from Playwright videos made by
`motion_evidence.py` (`test_clips_for_the_visual_review_gaps`) in the pinned Docker UI stack, Chromium and WebKit, light and dark. WebKit runs
without a GPU: its recordings are coarser and show what is drawn, not timing (the durations are in the animation logs).

## 1. AC-1: the message ⋯ menu opening and closing

| Clip (`clips/`) | What to watch |
| --- | --- |
| `<engine>-<light\|dark>-ac1-message-menu.webp` | The crop is measured on the menu (it opens under the ⋯ button) and includes the button and the corner of the message. Escape or a click opens, then closes, it: a fade in with four pixels of travel (180 ms), then a fade out over the same place (120 ms), no scale, the ⋯ button back in focus at once. On a computer its scrim is the transparent catcher over the page, so there is nothing to see of it here. |
| `<engine>-phone-<light\|dark>-ac1-message-press-menu.webp` | The scrim you can see: on a phone a long press opens the menu over a shaded, blurred scrim (390 x 844 at 0.6) that fades in with it and, on Escape, out with it. |

## 2. AC-4: the state change, at a rate that shows the travel

| Clip | What to watch |
| --- | --- |
| `ac4-state` | Real time at 25 frames per second, the crop on every row of the list. A task goes from open to in progress: its glyph and word morph (180 ms), the row slides to its group (260 ms, 45 px) and the rows it moved past slide by their own 57 px, all in the first six frames. Both themes start from the same states (the other clips used to leave the fixture changed for the next one, so light and dark showed different motions). |
| `ac4-state-slow` | The same, with the page's animations slowed 10x for the recording, so the slide and the morph can be followed frame by frame. The durations in the log are the real ones. |
| `ac4-state-far`, `ac4-state-far-slow` | The case the review read in the log (one row translating 320 px while three others moved 57 to 114 px): an in-progress task marked done, with four open tasks between it and the finished group. The row is no longer carried across the list (275 px here): it comes in at its new place, fading in with a 12 px slide from the side it came from (180 ms), while the rows it moved past slide their own 57 to 102 px. |

`ac4-row-frames-<engine>.json.gz` holds the same two real-time runs (the default state change and the far one, both themes) frame by frame at the
display's rate (`t` in ms after the click, then per row: id, state, top, `transform` matrix, opacity). The moved row of the far run, in
Chromium light: opacity 0, 0.37, 0.64, 0.81, 0.90, 0.95 ... 1 over 180 ms with a travel of -12, -7.5, -4.3, -2.3 ... 0 px; the row below it
slides 102, 86, 64, 38, 21 ... 0 px over 260 ms. `animation-log-<engine>.json.gz` has what each clip's page asked the browser to run.

## The cap (what changed in the application)

A row that moves further than `--row-travel-max` (160 px) is not translated that far (final design §2: calm, short motion): `rowMotion.ts` fades it in
with a `--shift-row` (12 px) slide instead, and a row the reader is on (the list is scrolled, the browser's scroll anchoring holds it) does not move at
all. `test_13b_a_row_that_moves_across_the_list_comes_in_with_a_short_slide_not_a_long_flight` holds it with the review's own case.
