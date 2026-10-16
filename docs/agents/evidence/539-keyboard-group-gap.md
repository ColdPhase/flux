# Tasks keyboard focus during independently arriving group reads (#539)

Observed 2026-10-16 on the existing #528 branch; original relevant product is
`16f7866770c8d33a9baebc87e6f944b8182b7ce2` (same Board/state/toast code as
main25e). Original `TaskBoard.tsx` SHA256:
`93ef90260b4e53b3ce7744af155fa130fff23334d804c90067d64b8eeb70b7b3`.

The main25e full-suite failure was the first `2` after Board Done → Z Undo:
storage remained Open. Five instrumented original journeys passed; those passes
were not evidence of repair. The controlled witness then used only real bounded
work-view responses and the real keyboard, command, session and Undo paths:

1. Done version2 was observed in Finished and absence observed in Open.
2. Z committed Open version3. Its real Open read was held, retaining the older
   Finished snapshot as the row from which the acknowledged Open card rendered.
3. After focusing that Open card, the real empty Finished read was delivered.
4. The focused node disconnected; zero supplier cards remained. Trusted key2
   targeted BODY, and no In-progress PATCH was sent. Storage remained Open.

This is a product gap: confirmed saves previously overlaid only identities still
present in one of the independent group snapshots. It is not an assertion that
all historical intermittent failures have independently captured network proof.
It does provide the same user flow and final failure with a controlled actual
read ordering. No route handler is removed during delivery; no fixture response
body, application handler or keyboard event is replaced.

Old witness: `/home/hubert/flux-evidence/539/control2.log` and numeric `.exit=1`,
2 tests/11.105s. Temporary diagnostic source is `control2-source.patch` there.
Captured PATCHes were Done If-Match1 and Undo Open If-Match2 only. The same
causal control with the repair passed (`control-fixed2.log`, `.exit=0`,
2 tests/2.884s): node connected, one card, trusted key2 on its button, real
In-progress PATCH If-Match3 and stored version4. The post-success focus assertion
was corrected to name the destination In-progress column; the old failure occurs
before that assertion and the failing key/status conditions were unchanged.

The repair retains the complete acknowledged row through the group gap, bounded
by account/project/Mine/query scope. Newer native rows win. Scope or unavailable
reads retire confirmations immediately. Equal/newer observed versions or all
four groups finishing a later read generation retire them permanently; a settled
absence cannot be revived by another refresh. The existing five-second focus
policy, command identities, conflicts, API and session semantics are unchanged.

Permanent regressions keep original test05 unchanged. Test05c controls the gap
and verifies the persisted next status and destination focus. Test05d uses actual
Mine queries and a real peer owner change: all current pages omit the task while
its older successful projection remains withheld, so absence itself must retire
it. Search changes and returning to All cannot revive the old owner; the shared
fixture owner is restored afterward. Existing old/fixed snapshots and invalid
probe/build attempts remain separate under the home evidence directory.

Complete affected-module Chromium/WebKit checks and independent review are still
required on the pushed repair head. #540 remains independently unresolved; no
route-lifetime fix is inferred from its successful diagnostics. All existing
#518/#523/#526 acceptance, final full UI and application gates remain required.
