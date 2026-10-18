# #228 production promotion verification — 2026-10-18

This is a candidate-branch implementation receipt for existing PR #613. It does not complete #228, authorize a merge, or waive any original gate/AC. The production default is promoted only through the final protected merge after every original gate and independent functional/visual acceptance passes.

The accepted contract is commit `7aada55094f7103ebbb89edd42ef998a961394e4`, `docs/development/live-editing-proposal.md`, “Whole-issue production promotion contract”. Implementation commit `72538ab1d58ca4d314cba191fcf5aca91f909965` adds the production `FLUX_LIVE_EDITING` control (missing/empty/on enables; off disables; other nonempty values fail configuration), separates diagnostic instrumentation, preserves unjoined native HTTP/MCP behavior and wires default/off UI modes. Commit `dfad765bd1379f5779b2b83eef910c4c470fd4df` keeps unjoined stale link-label conflicts ordinary: a conflict receipt must not create a live room. This extra fix came from source inspection, not a failed assertion. Final tested head `03590a3afdd3ac08d92a4959a09fe356d3979181` additionally corrects only the diagnostic runner's comments.

Branch: `codex-hubert/228-map-body-performance`. Final verification used the clean detached worktree `/home/hubert/Develop/flux/.worktrees/228-promotion-verification`; the primary worktree was released to the root writer before these lanes finished.

| Tested source | Lane | Files | Pass / fail / skipped / cancelled | Test duration |
| --- | --- | --- | --- | --- |
| `72538ab1d58ca4d314cba191fcf5aca91f909965` | normal Compose/default live, focused API | 10 | 57 / 0 / 0 / 0 | 53.927 s |
| `03590a3afdd3ac08d92a4959a09fe356d3979181` | normal Compose/default live, changed ordinary paths | 4 | 25 / 0 / 0 / 0 | 15.375 s |
| `03590a3afdd3ac08d92a4959a09fe356d3979181` | explicit `FLUX_LIVE_EDITING=off` | 3 | 10 / 0 / 0 / 0 | 7.642 s |

These counts overlap; they are not a claim of 92 distinct test cases. Each canonical `check_application.sh` run also completed the Docker build, TypeScript checks and ESLint. At the final head, agent setup/local links/evidence-size checks, 153 Python foundation tests, and whitespace checks passed.

The initial 10-file selection was:

```sh
FLUX_TEST_PORT=18685 FLUX_TEST_MAILPIT_PORT=18686 ./scripts/check_application.sh \
  tests/app/live-editing-default-off.test.ts tests/app/live-editing-promotion.test.ts \
  tests/app/native-map-ordinary-capacity.test.ts tests/app/mcp-map-actions.test.ts \
  tests/app/live-doc-native-fence.test.ts tests/app/live-map-authority.test.ts \
  tests/app/editing-http-lifetime.test.ts tests/app/editing-shutdown.test.ts \
  tests/app/editing-queue-telemetry.test.ts tests/app/editing-confirmation-fence.test.ts
```

The final default selection was `native-map-ordinary-capacity.test.ts`, `mcp-map-actions.test.ts`, `sketch-link-labels.test.ts` and `editing-http-lifetime.test.ts`, with the same canonical command and ports. The explicit-off selection omitted only `editing-http-lifetime.test.ts` and set `FLUX_LIVE_EDITING=off`; no other assertion or product permission changed.

The new restart regression passed in 7.565 s on actual compiled production API processes, real person sessions, PostgreSQL and authenticated WebSocket transport. It proves: missing production flag enables live map/wiki capability; a real wiki update receives durable sequence-1 ACK; stopping the API and restarting explicitly off preserves that unsaved text and refuses native body and metadata writes; re-enabling recovers the exact generation/sequence/body; Save persists version 2 with its author contributor; disabling again permits an ordinary version-3 edit; historical versions 1 and 2 remain immutable. Diagnostic variables do not override explicit off; normal live and off emit no calibration queue telemetry without both required selections.

Both final modes preserve every assertion of the 25-concurrent native HTTP creation burst on an unjoined map (all 201, no fabricated head/journal), exact idempotent replay with one effect, retained-room finite retryable refusal/recovery, actual MCP standing grants/ACLs, and ordinary stale-label conflict details with no new live room. The default lane also rechecks the existing real HTTP abort, PG-held COMMIT, response-loss, SQL lifetime, authorization and protected conflict-handoff cases.

Actual running inventories were captured before cleanup in `flux-228-promotion-api-{default-final,off-final}.inventory.json`. Both APIs reported `NODE_ENV=production`; canonical mode was respectively `on` and `off`, with no diagnostic marker. Observed versions: Node v24.21.0; PostgreSQL 18.6; pnpm 12.6.0; TypeScript 5.9.2; tsx 4.20.5; Playwright package 1.63.0; Yjs 13.6.33; Fastify 5.6.1; ws 8.22.0. The Playwright package pin is an inventory observation, not browser execution evidence. Full container IDs/image IDs and only allowlisted runtime fields are retained; no credentials or disposable homes are included.

One final-head build was intentionally terminated before API tests when the root requested release of the primary writer and a detached verification checkout. Its external `default-final-build-interrupted` log is an interrupted build, not a product test failure or pass. Both completed final lanes then ran from the detached checkout. No failing API assertion occurred in this batch.

`cleanup.json` verifies all containers, networks, volumes and project-tagged images are absent for the initial project, the interrupted build project, and both final projects; the canonical scripts each removed their three per-run images. Ports 18685/18686 were free at receipt time. The user's ordinary Flux demo and Qwen service were preserved. Heavy Docker and primary product-writer ownership were released to the coordinator.

The summaries contain test names/results only. `raw-log-manifest.json` records the external original log hashes and sizes; bulk/API logs remain outside the repository. Suitable compact checked-in evidence is this note, the three `*.summary.txt` excerpts, the two sanitized runtime inventories, `source.json`, `cleanup.json`, and the raw-log manifest.

Remaining acceptance is explicit: ordinary Docs UI default-live and explicit-off lanes; native clipboard full-100k helper verification on both engines; WebKit test14 composition harness fix and honest platform evidence; the current candidate's integrated phone/tablet/desktop/network/authority/recovery paths; all original performance and memory/queue gates; and the final eligible independent functional/visual review. The pre-promotion Chromium31/31 and WebKit29/31+2harness-errors baseline at `1b497379` does not verify these new UI changes. The previous map500/drag200 p95 220.806 ms still fails the unchanged 200 ms gate; no full nine-cohort latency run was performed in this batch. No blanket ordinary-functionality skip, acceptance waiver, merge, push, GitHub mutation or review request was made.

Suggested next UI commands after the pending WebKit IME fix:

```sh
./scripts/check_ui.sh test_docs test_live_editing_off
FLUX_LIVE_EDITING=off ./scripts/check_ui.sh test_docs test_live_editing_off
```

Run the required live modules and both engines on the coherent final candidate as well. New-doc and restore composition remain private; existing Docs tests retain those ordinary assertions and use mode-appropriate concurrent shared editing versus the original private CAS conflict journey.
