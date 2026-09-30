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

Integration with #134 is recorded separately below when verified. The #136
Agents/Studio shell is still absent: those continuity checks remain unverified.
Screenshots and browser emulation do not establish real Android/iPhone/iPad PWA,
OS notification, screen-reader or complete accessibility acceptance.
