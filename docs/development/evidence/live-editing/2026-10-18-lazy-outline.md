# Deferred List outline during Map movement

2026-10-18, author preparation for existing #228 / Draft #613.

Application baseline: `7af776c7dfd4403e3937c8ccd4b9723c7808d587`. The Map does not consume the List outline during movement, yet `useOutline` builds it on each parent render. The retained timed 28ad profile attributes 217.587 ms owner self-time and 240.615 ms peer self-time over 60 seconds to `buildOutline`; its source and hook are unchanged at this baseline. This is modest avoidable work, not proof of the remaining latency failure's cause or a predicted Gate 4 pass.

Defer only `buildOutline` until this render's outline is read (including reveal/move actions), sharing one local result. Keep eager ID-only `rememberThoughts`, preference persistence, current immutable graph/state captures, and all DOM, styling, authority, transport and measurement behavior. No cross-render content cache. Correct the existing outline fixture to launch the requested actual browser.

Verification: the maintained `sketch-outline.test.ts` file, then existing outline methods 04 (reparent/reorder/Undo) and 05 (native edits/deletion/Undo/reveal and Map/List switching) in Chromium and WebKit, serially in Docker. No new implementation-shaped test, profiler or latency run. Author evidence does not replace independent evaluation.

## Confirmed live Undo announcement

The selected production-on journey exposed an existing success message left at “Waiting for confirmation” after a committed inverse. Extend only the live hook's existing confirmed-current completion callback to notify its caller; the editor announces “Undid” there. Exact receipt/ordered-head or current resynchronization, retry identity, scope lifetime and refusal guards stay unchanged. Ordinary Undo still announces immediately. Preserve method 05's success assertion and add success/refusal assertions to the existing private-cancel/own-Undo and peer-conflict journeys. Retain both prior failed invocations.

## Source-pinned author verification

Source commits: `4c34f93d089df04b94ebcba2dbc08e11232455e3` (lazy outline and actual engine selection), then `759ecb40696f88cccb231dd33c49b739563d4e76` (confirmed live Undo announcement and existing controls). Changes remain on `codex-hubert/228-lazy-outline`; no publication or independent evaluation was performed by this author.

| Source / invocation | Actual outcome |
| --- | --- |
| 4c34, named `sketch-outline.test.ts` | 12/12 PASS, 0 skips; 202.014 ms |
| 4c34, Chromium 04+05 without setup method | 2 fixture errors (`KeyError` IDs); exit 1, 1.792 s |
| 4c34, Chromium 01+04+05 | 01+04 PASS; 05 FAIL at live Undo announcement, exit 1, 17.011 s |
| 759e, Chromium 01+04+05 + live refusal 06 + projection/private-cancel/own-Undo | 5/5 PASS, 0 skips; exit 0, 13.352 s |
| 759e, WebKit same five | 5/5 PASS, 0 skips; exit 0, 20.716 s |

Method 01 is the existing shared graph setup dependency, not a new acceptance criterion. No failed assertion was removed or relaxed. The 12 pure outline tests remain compatible: their graph implementation, test file and dependency lock are unchanged in 759e. Both source builds passed type checks and lint (0 errors, 9 existing warnings outside changed files). Final browser lanes used normal production-on `check_ui.sh`, actual Chromium/WebKit, live test flag 1, normal worker, and no development/telemetry/API-instance selectors.

Commands were `./scripts/check_application.sh tests/app/sketch-outline.test.ts` and `FLUX_UI_BROWSER=<engine> FLUX_LIVE_EDITING=on FLUX_UI_PORT=18685 FLUX_UI_MAILPIT_PORT=18686 ./scripts/check_ui.sh` with the five exact selectors retained in the [verification record](2026-10-18-lazy-outline/verification.json). That record retains actual running CIDs/images/configuration, raw log/runtime hashes and paths, all invocation exits, and final cleanup. [Focused result/failed assertion excerpts](2026-10-18-lazy-outline/759e-webkit.txt) accompany it. All five owned projects had zero containers, volumes and networks at 14:58:23 UTC; the heavy slot was released immediately. User services were untouched.

### Limits and retained profile interpretation

No new timing run or profile was taken. The original 7af full-nine result remains 8/9, map-500/drag-200 p95 213.16741593182087 ms FAIL. Input to *first* publication was p50/p95 35.466/56.914 ms; final covering publication 84.741/136.664 ms also includes later replacements during observation. These overlapping stages do not isolate application input cost.

In the older retained 28ad timed profile (60 s), the largest source-mapped product functions were peer SketchMap 329.438 ms self / 460.985 inclusive, buildOutline 240.615 / 265.926, and SketchView 177.619 / 828.269; owner buildOutline 217.587 / 217.587, SketchMap 192.350 / 318.856, and SketchView 111.313 / 602.299. React host-update `ap` self was 475.929 ms owner / 465.896 peer, with owner native `setAttribute` 1040.503 ms. Inclusive values overlap. Old owner `computeBox` 7862 ms belongs to the Playwright observer, whose identity-read path has since changed; it is not a current product hotspot. Several other application changes also postdate that profile.

The patch removes the source-proven unused outline construction only. Its modest sampled cost does not predict the remaining p95 gap or establish a timing pass. Current graph freshness, exact Undo state and refusal behavior passed the affected real-browser checks; full #228 completion, timing and independent acceptance remain with the parent work package.
