# Message alignment and connection labels — #481 / PR #482

Date: 2026-10-11. Owner: `PelikanFix16`. Branch: `codex-hubert/481-message-labels`.
Implementation revision: `e95edb52236b1b4c52a2af16b5d051b34b939b51`; review/test checkpoint: `0657169b37d16c7669d23b3e2f16f045d4919de7`.
Subsequent commits add only test/evidence files. This is scoped implementation evidence, not release acceptance or eligible GitHub approval.

## Observable outcomes

- **AC-1:** the current human’s root, reply and queued/failed message appears on the right; another human and a trusted agent appear on the left. Avatars, names, sources and actions follow the corresponding side. Neutral activity rows retain their existing placement. Direct messages retain their current behavior.
- **AC-2:** a selected thought exposes **Connections** on computer/tablet. The list names each connected thought and offers **Add label** / **Edit label**. A bare line and an existing label also open the same editor. The selected connection displays **+ Label**. The toolbar stays within the canvas and clear of the label.
- **AC-3:** add/edit/blank-to-clear updates the same stored link. Cancel sends no write. The update authorizes access, compares the opened label atomically, and uses idempotency keys. A conflict keeps the draft and shows the saved label before explicit replacement. Failed/unknown saves retain text and command identity; replay refreshes current server state. If access disappears, typed text remains available to copy.
- **AC-4:** keyboard focus returns to a stable thought or the Connections trigger; dialog keyboard shortcuts cannot undo the underlying map. Tablet targets remain at least 44 px. Existing phone view/add-only behavior is retained. Connection creation, draft composition and camera retention are checked separately.
- **AC-5:** local technical review and a fresh screenshot-only visual review are complete. Eligible independent GitHub review remains the next actor’s task.

## Checks and scope

All application commands ran in Docker/Compose in the isolated flux-481-verify project (application port 18841, Mailpit port 18842). No existing user stack was changed.

| Check | Result / scope |
| --- | --- |
| Docker production/test image build | Pass: application build, TypeScript checks and ESLint using the maintained `docker/Dockerfile` |
| `sketch-link-labels.test.ts`, `sketches.test.ts`, `dm-sketches.test.ts` | 21/21 pass: API/storage, private/project/DM authorization, concurrent CAS, replay/revocation, rollback and validation |
| `architecture.test.ts` | 9/9 pass |
| Chromium `test_message_alignment`, `test_one_conversation`, `test_direct_messages` | 28/28 pass: roots/threads, two human viewers, pending/failure/retry, sources, keyboard/touch, contrast and existing DM journeys |
| Chromium `test_connection_labels` tests 01–08 | 8/8 pass after final map layout changes |
| Chromium `test_map_connect` tests 01,02,13 | 3/3 pass: drag and keyboard creation, unchanged draft graph/camera at 1440/1024/820/390 in light/dark |
| WebKit `test_connection_labels` tests 01–08 + `test_message_alignment` + map tests 01,02,13 | 13/13 pass |
| Legacy WorkDecisions geometry (tests 01–06,09 together) | 7/7 pass: both authors, linked objects and open Details across desktop/phone |
| Long labels (80 characters), Chromium and WebKit | Pass: compact tablet presentation, full text retained on reopen, cancel preserves stored label |
| `task-discussion-actors.e2e.ts` | 2/2 pass in Chromium with genuine trusted-core agent messages and real human replies; not a vendor/MCP client certification |
| Independent runtime repro in Chromium and WebKit | Pass: clear-label focus; Ctrl+Z inside the dialog sends zero writes, then map Undo still works after closing |
| Repository setup checker + Python regression suite + changelog checker + whitespace | Pass; 120 Python tests |

The first map composition run exposed an820 px camera shift from clipped controls; the final layout passes that same regression. The legacy WorkDecisions geometry case depends on earlier fixture journeys and is run with its setup, rather than treated as an independent test. No acceptance criterion was weakened.

### Reproduction

Use the maintained UI runner with isolated ports and a screenshot directory:

```sh
FLUX_UI_PORT=18841 FLUX_UI_MAILPIT_PORT=18842 FLUX_UI_BROWSER=chromium \
  FLUX_UI_SCREENSHOT_DIR=/tmp/flux-481-chromium ./scripts/check_ui.sh \
  test_connection_labels test_message_alignment test_one_conversation test_direct_messages \
  test_map_connect.MapConnectJourney.test_01_drag_a_dot_to_connect_and_release_on_empty_space \
  test_map_connect.MapConnectJourney.test_02_connecting_works_without_a_pointer \
  test_map_connect.MapConnectJourney.test_13_composition_keeps_visible_map_context_and_camera
```

Repeat the connection-label/alignment/map selection with `FLUX_UI_BROWSER=webkit`.
For the legacy geometry case, select WorkDecisions tests 01–06,09 together.
The focused API command in the maintained test service is:

```sh
node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/app/sketch-link-labels.test.ts tests/app/sketches.test.ts tests/app/dm-sketches.test.ts
```

The actor browser check uses the repository’s pinned Playwright 1.63.0 image with the checked application workspace from the test image, the same Compose network/environment, and `node_modules/.bin/tsx --test tests/app/e2e/task-discussion-actors.e2e.ts`. This avoids rebuilding an unchanged application solely to switch the browser runner.

## Independent evaluation

`contract_review` did not author the implementation. Its initial review reproduced two P2 findings: a disappearing label opener lost focus, and Ctrl+Z from a dialog button undid the background map. Both were corrected, statically re-reviewed at 0657169b, and independently rechecked in both engines. Final verdict: no remaining blocking finding in the reviewed scope.

`visual_review` used a fresh context, a neutral garden-collaboration brief, fixed Prostota references and screenshots without implementation code or author rationale. It found clipping/label occlusion in the first tablet render. The second render at 0657169b resolves that finding; no remaining material visual issue in the supplied scoped map screenshots. It also found pre-existing phone navigation/chrome differences, outside these changes and covered by the existing phone-shell work #266. That observation is not a pass for the entire phone shell.

The reviewer preserved the readable authorship split, named Connections/Add label actions, endpoint context, focused field and restrained Save hierarchy. Screenshot review does not establish interaction, accessibility conformance, persistence, dense crossing graphs or every enlarged-text setting. Local review under the author’s account does not replace eligible independent GitHub approval.

## Rendered evidence

Screenshots are losslessly encoded as WebP, with no cropping or layout changes. Desktop 1440×900, phone 390×844, tablet 820×1180 at 3× device density; browser zoom 100%. Map screenshots use 0657169b. Message screenshots use 3836b4f0; conversation code is unchanged in the final source revision.

| Scenario | Screenshot |
| --- | --- |
| Own/right, other/left, source card | [Desktop conversation](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/message-alignment-stream-desktop-light-chromium.webp) |
| Phone conversation | [Phone](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/message-alignment-stream-phone-light-chromium.webp) |
| Dark phone replies | [Thread](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/message-alignment-thread-phone-dark-chromium.webp) |
| Discoverable connected-thought list | [Connections](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/connection-labels-connections-desktop-light-chromium.webp) |
| Dark label editor | [Editor](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/connection-labels-editor-desktop-dark-chromium.webp) |
| Tablet: complete toolbar and readable label | [Map](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/connection-labels-map-tablet-820-chromium.webp) |
| Tablet label editing | [Editor](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/connection-labels-editor-tablet-820-chromium.webp) |
| Explicit conflict recovery | [Conflict](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/481-message-labels/connection-labels-conflict-desktop-chromium.webp) |
