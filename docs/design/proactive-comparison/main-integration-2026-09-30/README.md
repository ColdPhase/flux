# Main integration, quiet outcomes and owner history

This is a partial, controlled #58 checkpoint with an unresolved material visual
finding. Actual protected main `3cd91d798a8767ba8a87ceecde98b49f76aed15a` is
integrated, including the map/DM changes, task views and personal-assistant UI.
Production comparison scheduling, recovery and provider registration remain off;
rule enabling remains unavailable.

The [manifest](manifest.json) preserves 21 unmodified original PNGs from the
running Docker application: outcome summaries, checked details and insufficient
footers at desktop 1440×900, independent touch phone 390×844 and touch tablet
1024×768; desktop dark and 125% enlarged text; owner usage summary/history in
those contexts and another participant's empty phone history. DPR is 1 and browser
zoom is 100%. Enlarged text is not browser zoom or physical-device evidence.
Captures were made at `1ea1c6c121c66eb30149404b3ab916d9eb378686` plus the history
UI working tree; those exact production UI sources are committed in
`19d233bc41d784f19d2f01391fb65fc9a8dc72c7`. Later changes affect tests/docs only.

The [fresh independent visual report](visual-review.md) inspected all 21 originals
and the three Studio v11 references. It finds one material problem: opaque request
IDs and generic Completed rows still lack recognizable triggering-work titles.
It preserves the compact structure, explicit source distinctions and honest
usage uncertainty. The [earlier independent report](earlier-review-8d5dc14.md)
records the same recognition problem before request references and result links;
its separate original image hashes and local capture scope remain in that report.
Only the later image set is archived here. These reports do not certify behavior,
permissions, accounting, accessibility or devices.

The [additive current-access context proposal](https://github.com/ColdPhase/flux/issues/58#issuecomment-5905429595)
is awaiting peer agreement before implementation. It would provide human-readable
project/result metadata only after current owner access checks, with null context
after access loss or source removal. This finding is not waived, and #124 remains
draft rather than claiming current visual acceptance.

Separate Docker verification:

- Clean integrated `c991068ca20d7925dff909e4bcaa1fb7796094fd` passed the full
  application check: build/type/lint/architecture, 369 application tests, 3 PWA
  checks, access-stream, 6 setup/proposal/outcome browser journeys, restart
  persistence and unavailable push/email checks.
- Recovery sources committed in `44b9cd774bafb12cc2963cc8db87ae9d7cfdc3b4`
  passed build/type/lint and 56 focused core/API/DB/local-provider-fixture tests.
  They cover stale pre/post-intent recovery, active locks/fresh exclusion,
  concurrent/paged sweeps, retained uncertainty and late responses unable to
  publish or release it. These are controlled persisted fixtures, not a killed
  production worker or real provider invoice.
- Current UI sources passed build/type/lint and 3 outcome/owner browser journeys.
  Result links open the exact persisted triggering result using keyboard and
  phone/tablet touch. The test-only grant fixture correction at `02c909d` then
  passed those 3 journeys again, including owner denial: usage remains private
  and unchanged, while the source route returns 404 without its title/body.
  The earlier invalid grant-principal fixture failure is retained locally; the
  application's access policy was not altered. Settled light/dark search contrast
  and enlarged-text light contrast meet the measured 4.5:1 threshold.
- Actual main schema 25 → candidate schema 32 on the same original volume passed
  at `44b9cd7`: all 16 full-row snapshots matched, the original session and
  historical references remained usable, new paused setup/manual work worked
  without a provider call, and repeated migration/start retained the exact ledger.
  All 25 baseline SQL files remain byte-identical. Later UI/test edits do not
  change the migration sources. This is local evidence, not independent release
  or #118 acceptance.

Reproducible application and upgrade commands are documented in
[the development contract](../../../development/proactive-comparison.md).
The separate local check logs retain their tested revision and working-tree
scope. Scoped Docker resources were removed after the checks.

Remaining requirements include the material history finding, agreed partial
review boundary and independent current-head functional evaluation, authorized
real-provider quality/structured-output/billing/cancellation, production runtime
registration/activation, and integrated release plus Android/iPhone/iPad evidence.
