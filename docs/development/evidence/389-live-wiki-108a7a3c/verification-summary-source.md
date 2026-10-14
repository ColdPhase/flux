# #389 current-head verification record

Source: `108a7a3c5935cb0265e55658176e97b759a1d937` (`codex/228-main-composition`), matching `origin/codex/228-main-composition`. Base: `bb74618a3bf1ef6b1de5f6f9b2ed700651104648`. Source worktree was clean. No production files changed in the verification follow-ups; the three new tests exercise the real PostgreSQL doc/task-use UOW and both lock orderings.

## Results on exact source

- Targeted API: **31/31 passed** across `editing-http-lifetime.test.ts`, `mcp-map-actions.test.ts`, `agent-stop-questions.test.ts`, and `live-doc-native-fence.test.ts`. This includes successful Save-use latching after mention removal, refusal for an already-reverted task with unchanged doc state, and the Save-wins/Undo-wins SQL concurrency paths. See `flux389-108a7a3c-api/api-tests.log` and `build.log`.
- Configured live editing + Wiki integration: Chromium **5/5**, WebKit **5/5**. Each engine ran LiveEditingJourney 01/02/07 and WikiFinal phone title/edit + computer panes/outline. See `flux389-108a7a3c-live-chromium/unittest.log` and `flux389-108a7a3c-live-webkit/unittest.log`.
- Capability-off browser path: Chromium **2/2**, WebKit **2/2** for ordinary Wiki reader/editor from first render. See `flux389-108a7a3c-off-chromium/ui.log` and `flux389-108a7a3c-off-webkit/ui.log`.
- Required PR checks at this head: Agent setup SUCCESS (run `38525761449`); Application validation SUCCESS (run `38525761371`).
- Compose cleanup completed for all five successful runs. No project containers remained afterward.

## Visual artifacts

Configured-live Chromium and WebKit runs each contain six current-source frames (live-reader desktop/phone, Wiki phone light/dark, Wiki desktop light/dark) with `screenshot-manifest.json` and `SHA256SUMS`. Both checksum sets pass. Neutral brief: `flux389-108a7a3c-visual-brief.md`.

The Chromium tests and all six captures completed. The original Chromium temporary runner then failed only while serializing its manifest (`false`/`true` used as Python names); `manifest-repair.txt` documents reconstruction from declared viewport contexts and verified PNG metadata. The corrected runner was used for WebKit, and its hash is in `harness-sha256.txt`. No tests or captures were rerun for the Chromium metadata repair.

## Attempts before successful runs

- `4750ea72743afbe93b20560c3523ea57b9f8f90c`: source/type preflight stopped before tests at TS2345 (`barrier<void>` type); preserved at `flux389-4750ea72-api-retry/build.log`.
- `c01c52b3efa686e367e5554d0d69da4d29f4cd2c`: typecheck passed; lint found an unused race-fixture binding; no tests ran, preserved at `flux389-c01c52b3-api/build.log`.
- `372363e63991e9bba3db9876f158e4322040c579`: next typecheck caught that the binding was removed from the wrong test; no tests ran, preserved at `flux389-372363e6-api/build.log`.
- A first runner guard typo and a Compose-command quoting error stopped before any container/test run; their records are in `flux389-4750ea72-api/` and `flux389-4750ea72-api-retry/`.

## Scope limits

No Gate 4 latency or codec-admission result is claimed. Direct `installHead` fixtures in the native fence test exercise the real Save UOW boundary; they are not codec-admission evidence. PR `reviewDecision` remains GitHub-derived `CHANGES_REQUESTED` from an older review at `c4c492c7`; there are no pending review requests. A fresh independent exact-head review and visual assessment remain separate from these author-run checks.
