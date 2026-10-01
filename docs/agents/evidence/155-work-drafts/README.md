# Native New work draft correction — #155 / #151 / #136

2026-10-01. Immutable tested/source-reviewed application:
5bd354684f4977b324e7eb0d0ae5115017e64d59. This is the private composer correction,
not the complete large-list optimization or whole-task acceptance. The independently
agreed [read contract](../../../development/performance/2026-10-01-native-work-read-contract.md)
at 93fb608 defines future endpoints; none is implemented at this pin.

## Actual checks at this source

- Docker build, TypeScript and lint passed: [build.log](build.log).
- 35 actual browser journeys, no skips, PASS 58.254s:
  [browser.log](browser.log). They include 8 direct-message, 17 project-surface and
  10 personal-assistant cases. The assistant uses the configured synthetic provider;
  this is not real-model evidence. All final test processes returned exit 0.
- Four existing Home registration/session/draft/reading-position browser cases,
  PASS 5.768s: [home.log](home.log).
- 54 native typing/transport/admission/access/architecture tests, no skips,
  PASS 16.121s: [api.log](api.log). This does not claim a fresh full 385-test run.
- Owner foundation/link/whitespace checks passed. Source-only independent draft
  agreement is at 5bd3546 after fixing each reported race; the reviewer did not
  run these checks or provide eligible GitHub/whole-issue approval.

Native public commands create the project fixture, actual linked message/work/
decision/result objects and shared contributors. On desktop and phone emulation,
New work survives native Details→message source→browser Back, Only mine/view
changes, resize with focus/selection and reload. Those private/view actions issue
zero POST/PATCH/DELETE requests. Account/project drafts stay distinct, including
actual A→B→A cookie changes on a mounted Home with same-route loader revalidation.

The additional browser cases prove:

- A newer failed localStorage write wins over older persisted text on SPA remount;
  a failed empty clear remains a visit-local tombstone and does not resurrect there.
- The server really creates work before its response is replaced with an uncertain
  503. A retry after navigation reuses its actual Idempotency-Key, returns the same
  object and increases the exact native work total by one, not two.
- Held actual successful responses cannot clear a remounted A→B→A newer edit.
  An untouched remount DOES observe the confirmed clear through shared subscribers.
- A real second same-origin browser tab synchronously writes B→A; both external
  storage events advance the fence even if both reads see final A. This preserves
  the new text with mounted AND unmounted composers. These are browser storage
  regressions, not trusted-human typing/latency measurements.
- If removal is refused after successful creation, the empty draft still discloses
  its visit-only state. The matching native replay key is retained; after reload
  restores the old submitted text, another click replays that one object. Exact
  counts and the two equal keys verify no duplicate. When ALL storage writes are
  refused, persistence/reload cannot be promised; the visit-only disclosure remains.

The separately mounted account/project composer owns private input and pending
command state. Its edit-revision fence belongs to the existing browser draft
store, not to authorization or server work state. Native commands, permissions,
versions, status/park/history and source links remain unchanged.

## Rendered evidence and independent appearance assessment

[Desktop capture](work-draft-source-back-desktop.png), 1500×900 CSS/DPR1, and
[phone-emulation capture](work-draft-source-back-phone.png), 412×900 CSS/DPR3,
come from the final source/back/reload case. They contain actual fixture records,
not a substituted screenshot. The neutral non-author visual evaluator found no
material visible problem with the composer/status group and neighboring rows.
That assessment does not prove interaction, accessibility, latency, remaining
horizontal content, physical installation or Push. It is bounded to these captures.

## Reproduction, provenance and remaining work

[environment.json](environment.json) records the actual isolated Compose project,
ports and image IDs. [inputs.json](inputs.json) hashes the immutable source inputs
and saved evidence. Plain logs and deterministic gzip copies preserve their exact
original bytes; the manifest includes decompressed raw-log hashes. No production
credentials/session dumps or provider keys are saved here. Fixture names/emails
and command identities belong to the synthetic test accounts.

From a checkout of the tested source, use the example-only isolated Compose
[recipe](reproduce.sh), setting FLUX_REPO_ROOT and unused FLUX_TEST_PORT/
FLUX_TEST_MAILPIT_PORT/COMPOSE_PROJECT_NAME as needed: prepare, regression,
draft-home, api, cleanup. It uses the trusted Docker configuration; it installs no
host application dependencies. The recorded run used flux155browser/18581/18585;
the reusable recipe defaults to another project/port pair to avoid collisions.
All owned containers, volumes, network and three tagged images were removed:
[cleanup.log](cleanup.log). Unrelated projects were retained.

The initial b3 source was rejected for text-only ABA clearing and hidden failed-
clear disclosure. Its first 31 browser cases also exposed two fixture errors
(Only mine had no owned in-progress work; the next project link was clicked before
its loader settled). At 292, 33 cases passed, but editing the running shell recipe
caused a later wrapper exit127; it is not reported as a successful final process.
The remaining account-key and cross-tab findings were fixed at 5bd, then all
recorded final processes completed successfully. No criterion was lowered.

The historical 1000-object baseline remains a FAILED bounded-fetch/render/draft
baseline at d53622c. This small native fixture verifies the draft correction only.
Implement all agreed bounded summary/page/association/detail/choice consumers,
then repeat every 30-warm-up/200-action/60s distribution on the agreed 1000-object
shape. Task integration, real agents, motion, physical Android/iPhone/iPad PWA/
WebPush, wide/enlarged-text and integrated release evidence still remain required.
All whole #155 AC1–AC5 remain open; no merge or issue completion is claimed.
