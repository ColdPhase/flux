# Desktop Tasks feedback clearance — 2026-10-11

Scoped correction to #346 / PR #375 after independent source-free review of the
26 b803 frames. Desktop Undo aftermath obscured the final task title in all
four engine/theme 1440×900 frames. Phone navigation remains the separate #414
integration; no unmerged #380 or #474 code is imported.

The peer accepted this bounded direction before production edits: preserve the
bottom-centred toast and existing row density. Measure the actual rendered toast
stack in the shared provider and reserve only that occupied area in the desktop
Tasks list's own scrollport. Keep a visible final title and focused task exposed;
retain middle reading anchors, retire the reservation with feedback/view/session,
and leave phone/footer and other screen layout unchanged. Fresh live and neutral
visual verification are required; this document is not acceptance evidence.

The original new-control attempt at tests-only af825 (product-equivalent to clean
1b2f) reproduced title/feedback overlap in both engines, including normal window
first-change Undo and aftermath, with title lines around836–854 and toast836–880.
It also contained an inappropriate after-Dismiss focus assertion. Corrected
controls use actual natural expiry and preserve focus through keyboard Undo.
Frozen corrected f4d1 again reproduced the overlap/short-window visibility
failures. A new middle-reading fixture initially raced its held-response capture;
then a raw-scroll-offset assertion wrongly treated the58px compensation for a
real task reorder as loss of the visual reading anchor. Those failed logs are
retained and are not product findings. The corrected middle replay at017b used
the real stored response and visual anchor: WebKit passed; Chromium caught a
transient resize measurement across separate RPCs. Final controls use a bounded
single-frame layout observation without changing any original assertion/timeout.

Evidence remains under `/tmp/flux375-feedback/`: original `control-*`,
`corrected-control-*`, `middle-control-*`, and `anchor-control-*` logs and native
frames preserve distinct source/results. The prior b803 broader WebKit53+six
scenario failures remain blocked as recorded in
[tasks-main-composition-2026-10-11.md](tasks-main-composition-2026-10-11.md).
No passing targeted feedback check replaces that integration gate, full #346,
independent current-head review, #414 or release acceptance.
