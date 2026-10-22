# Thread reading position: one scroll owner (#540)

Accepted 2026-10-16 in [independent review](https://github.com/ColdPhase/flux/issues/540#issuecomment-6206706524), before the product repair.
Scope: the existing `.thread__feed` and its `useMessageReadingPosition` owner;
retain the [native message-work contract](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/155-message-work-pages/README.md)
and [adaptive reading-position guarantees](../design/adaptive-workspaces.md).
This clarifies the implementation boundary, not a new interaction or design.

## Observed failure and decision

On WebKit 26.5, retiring the old association batch removes 76 pixels above the
viewport. During a genuine wheel or single PageDown, the browser's automatic
scroll anchoring changes the offset and cancels the remaining native animation.
A test-only scrollTop setter trace records no application write during either
failure. A neutral native scroll container reproduces the cancellation when the
same 76 pixels are removed; `overflow-anchor: none` allows the same gesture to
finish. Stable-content controls finish with either setting. This is separate
from Chromium's intercepted shell-loader request loss in #540.

The thread's existing reading-position hook remains the sole explicit owner of
settled reading anchors, reader intent, following the end, and the pointed
message. Disable automatic browser scroll anchoring on `.thread__feed` so it
cannot counteract an active native gesture when association content retires.
Do not add another scroll writer or preserve stale associations/placeholders to
keep their geometry. Scope/identity retirement, bounded reads and permission
failure behavior stay unchanged. Native keyboard/wheel motion remains enabled;
reduced-motion preferences are not overridden.

## Required verification

- Keep the original single native wheel/PageDown gestures and movement thresholds
  in work-association tests06/08 in both engines. No repeated-key substitute,
  sleep, extra timeout or programmatic offset during the tested gesture.
- Preserve test06's paused revalidation, A→B→A retirement, loading assertions and
  fresh first-message work after release. Preserve test08's movement while held
  and newest reading anchor after the real response is delivered.
- Add a settled-reader control: after genuine reader input has ended, retire an
  association batch under a real held read and require the same visible anchor
  both while loading and after delivery. Also verify following the end through
  a native viewport change, then leaving the end and retaining the new anchor
  through another viewport change. The sole owner must cover these boundaries;
  disabling native anchoring alone is insufficient if these controls fail.
- Pass the complete association module in Chromium and WebKit, including held
  page focus/selection, anchor, private reply, account switch and failure/retry.
  Run the existing reduced-motion message-alignment coverage and ordinary
  conversation coverage relevant to the same thread geometry.
- The phone screenshot-positioning step in test01 may use the native last-chip
  scroll-into-view API: mobile WebKit's automation does not expose a mouse wheel.
  This positioning is outside the tested held-gesture path; all existing phone
  content, count, draft, paging and anchor assertions remain.

Raw actual-app and neutral controls are preserved under
`/home/hubert/flux-evidence/540/scroll*` and `native-scroll*`. Pinned evidence and
independent acceptance of this clarification belong in #540 / PR #528. Passing
these checks does not replace the cluster's outstanding full UI/application gates.
