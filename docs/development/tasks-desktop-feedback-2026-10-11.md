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

## Actual fixed verification

Final tested application/test source:
**c5e28aec440a649201ab58ee09814fbe603f1500**. Trusted Docker source/UI driver
`/tmp/flux375-feedback/verify.sh`, handle40273, finished **exit0** with the
checkout clean and production/tests immutable during the run:

| Current scoped phase | Actual result |
| --- | --- |
| Docker build/type check/lint | Pass; three existing warnings, no errors |
| Chromium original23 + two new methods | 25/25,113.050s |
| WebKit original23 + two new methods | 25/25,130.350s |
| Desktop title observations per engine | Twelve visible/uncovered/hit-readable states: eight end-list Undo/aftermath normal/short themes, four middle/resize states |
| Original phone geometry per engine | Fourteen states,12px footer gap and ≥44px hit targets unchanged |
| Agent setup/repository/diff checks | Pass;102 repository tests |

The shared provider measures its existing toast stack. The desktop list reserves
the occupied area in its own scrollport and keeps a focused or previously visible
final title exposed. Middle reading uses the visual anchor through a real stored
task reorder, not a raw scroll-offset comparison. Actual delayed response, focus,
600/900px resize, Board/phone breakpoint retirement and natural feedback expiry
pass. The original API/version/Undo/blocker/session/offline/pageerror controls
remain. No toast duration, row spacing, phone placement, navigation or other-screen
layout was changed; helper/PWA/API client remain exact main6e. The old broader
WebKit53+six scenario failures were not rerun or relabelled as this pass.

All five owned baseline/verification projects, containers, volumes, networks and
run-tagged images are gone. Final raw driver SHA-256:
`b298df75e79e66c2215cbd7f5f476071c7ef5ad3a3470bf1de4efb02fc3d77b4`.
`/tmp/flux375-feedback/verification-proof.json` records distinct results,
cleanup and hashes; `geometry.json` retains observed rectangles. All committed
application/test/config input hashes were recorded while this pin ran. Images
were removed before an additional baked-source probe; no new baked-hash claim
is made.

Fresh42 unedited native PNGs are in `neutral-manifest.json` / `neutral-brief.md`:
the original26 Tasks/phone/feedback states plus16 first-change Undo/aftermath
frames at1440×900 and1440×600, both themes and engines. Hashes/dimensions match
configured viewport, scale and normal text/zoom. Fresh independent appearance
and eligible code evaluation remain required. The desktop list baseline remains
light-only; missing states and the separately owned phone shell are not certified.
Full #346 and the blocked integration/adaptive/PWA/release gates stay open.
