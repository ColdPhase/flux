# #593 light motion: review recordings (PR #608)

Recorded on application head `1a0ea759037c893c9cfabe1fee34f5eed39e2a7e` (branch `claude-maurycy/593-light-motion`). The two commits
after it change documentation only: this folder, then its removal from the tree (committed evidence is downloaded by every clone,
[#319](https://github.com/ColdPhase/flux/issues/319); [evaluation.md "Evidence size"](../../../agents/evaluation.md#evidence-size)). The
recordings stay reachable through this commit; the PR links the files at it.

There is no "before" recording: on `main` the interface has no motion at all (the inventory in #593).

## How to look

Each `.webp` is an animated WebP of one motion, cropped to where it happens (open it in a browser; GitHub shows it inline). The
motion starts about 0.3 s in. They were recorded by `app/tests/ui/motion_evidence.py` (`test_clips_for_the_review`,
`test_clip_for_reduced_motion`) in the pinned Docker UI stack, once per engine, as Playwright videos of a real session, and cut
down by `scripts/pack_motion_evidence.py` (a crop, a lower frame rate, lossy WebP, each under the 300 KB limit).

- **Chromium**: Playwright 1.63 Chromium 151, 1440 x 900, light and dark.
- **WebKit**: the same pinned Playwright container's WebKit (Linux, no GPU), 1440 x 900, light and dark. Its recordings are coarser
  (fewer frames; a page that is busy loading the new view's code for a moment shows as a held frame). They show what is drawn, not
  timing: the durations are in the animation logs below.

## Clips

`<engine>-<scheme>-<clip>.webp` in [`clips/`](clips). Dark is recorded for every clip except the reduced-motion one (light only).

| Clip | Review finding / criterion | What to watch |
| --- | --- | --- |
| `ac1-composer-menu` | finding 1, AC-1 | Typing `/` brings the actions menu up over the composer (a fade and four pixels of travel, no scale). Escape: the menu stays on screen and fades out for 120 ms; the field keeps focus the whole time. |
| `ac1-message-menu` | finding 1, AC-1 | The message ⋯ menu and its scrim fade in and, on Escape, fade out together. |
| `ac1-more-menu` | finding 1, AC-1 (#606's surface) | The project header's More menu fades in and out over the header; the controls beside it do not move. |
| `ac1-dialog` | AC-1 | ⌘K and its scrim come in (180 ms) and leave (120 ms). |
| `ac2-panel` | finding 2, AC-2 | A task's content is replaced by its thread: the old content stays as a picture, fades out and travels left while the thread slides in from the right; "‹ Task" reverses it. The panel's shell, head and close control do not move. |
| `ac3-views` | finding 2, AC-3 | Conversation to Tasks and back: the old view stays as a picture over the new one, fades out and travels left (forward) or right (back); the new view and its composer are in place from the first frame; header, sidebar and tab bar do not move. |
| `ac4-state` | AC-4 | A task's state glyph morphs and its row slides to its new group. |
| `ac5-press` | AC-5 | A pressed row scales to .97 and springs back. |
| `ac6-reduced` (`*-light-reduced-*`) | AC-6 | The same view switch, panel replacement and ⌘K with reduced motion: every surface is in its end state at once. |

Finding 3 (the hidden-page guard) is not something a recording shows; it is the regression test
`test_20_animations_stop_while_the_page_is_hidden_and_land_on_their_end_state` and `test_20b_...` in
`app/tests/ui/test_light_motion.py`.

## Numbers

- [`chromium-frame-times.json`](chromium-frame-times.json): `motion_light_performance` on this head (30 samples per flow, the #151
  budgets). Desktop 1440 x 900: first frame p95 13.3 to 15.6 ms (budget 150); largest frame gap p95 16.8 ms in every flow except the
  press flow at 33.3 ms (budget 50); reduced motion 16.8 ms. Phone 390 x 844 at 4x CPU: first frame p95 28.9 ms (budget 300), largest gap
  p95 16.8 ms (budget 100). Outcome `within-budgets`.
- `animation-log-chromium.json.gz` and `animation-log-webkit.json.gz`: every animation the page started during each clip (what it
  animates, how long, how it eases), the measurement a video cannot give. `zcat animation-log-chromium.json.gz | python3 -m json.tool`.
