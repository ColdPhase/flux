# Mint, Sky and Copper successor evidence (#148)

Production source `f9db781dc9e7410651355e3f475cfd33d0574bae`, stacked on the
unchanged #135 source `3f02e8668a5f636a02188b1ced9438cfea0bd8d6`.
The [metadata](metadata.json) pins maintained source hashes and actual test scope.
The original Mint/Iris/Sky archive is preserved separately.

- [Current Docker browser check](current-focused-ui.txt): seven tests, including
  keyboard/focus, both theme slots and OS switching, reload, legacy migration,
  precedence of valid slots, invalid/refused storage, preservation of other
  preferences, and real same-tab sign-out/account switching.
- [Initial full Docker UI regression](initial-full-ui.txt): 114 passed, four
  optional live-media skips at earlier implementation `3935722`. The final compact
  hint and preference/account regression additions were verified by the current
  focused run; the earlier full result is not attributed to a later head.
- [Shared token contrast](token-contrast.txt): all 258 pairs pass.
- [Composited browser contrast](browser-contrast.json): 145 actual measurements
  over all six theme/accent combinations and relevant interaction states.
- [Independent visual review](visual-review.md): fresh image-only evaluation,
  visual pass for its supplied scope. It is separate from interaction tests and
  eligible protected GitHub approval.

The PNG corpus includes all six desktop settings, conversation, recap, return,
work, map/list, error and button states, plus representative phone/tablet and
125% text states. The tablet is 820×1180; phone is 390×844; desktop is 1440×900,
with additional 1280×800 and short 390×500 captures. Browser zoom is 100%.
The fixture has two signed-in people and persisted, restricted project work.

The supplied final dark Copper soft surface `#42342D` failed production metadata
at 4.35:1. The earlier supplied `#3B2E25` candidate passes at 4.78:1 and is used
consistently in production. Status colors retain their existing semantic roles.

The [integrated #134 check](integrated-outline/docker-ui-check.txt) at
`03f0f8d6b417cc3fc7bcaa3d0f48accf7332cb48` passes fourteen appearance/outline
tests. [Metadata](integrated-outline/metadata.json) and
[thirty composited text measurements](integrated-outline/browser-contrast.json)
cover deep hierarchy, selected path, cross-links and provenance in all six
palettes. The first full integration attempt exposed an obsolete Iris test
selector; that failure and the corrected affected-suite pass are distinguished.
The successor now stacks on #134, with its old accepted scope left intact. The #136
Agents/Studio shell is still absent: those continuity checks remain unverified.
Screenshots and browser emulation do not establish real Android/iPhone/iPad PWA,
OS notification, screen-reader or complete accessibility acceptance.

The [phone landing correction check](integrated-outline/landing-fix/docker-ui-check.txt)
at `10ae58a08a6c1b11a6e3d8412d232d24b5ab65ca` passes the same fourteen tests
after the independent visual finding. Its [metadata](integrated-outline/landing-fix/metadata.json),
matched screenshots and thirty contrast measurements pin the corrected combined source.
The earlier integrated archive remains intact as the record before that fix.

The [fresh corrected combined visual report](integrated-outline/landing-fix/independent-visual.md)
accepts the 13 supplied captures and the focused phone correction. This is separate from
eligible GitHub review, live interaction and unavailable accent landing/Agents states.
