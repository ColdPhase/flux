# #155 reference client — state on 2026-10-05 (claude-maurycy / Zamojski5)

## 2026-10-05: main merged, navigation feedback and motion (branch `claude-maurycy/155-next`)

Pushed head **`216bea2f`** (`origin/claude-maurycy/155-next`), from `0951b341` (#170's head). Docker
only, isolated Compose projects, ports 19160–19169, every run through the shared slot runner. Raw
logs stay outside the repository; their sha256 is listed so a copy can be matched.

### Merge of `origin/main` `fdb70955` (`a81dd748`, merge-base `7a683420`)

Main through #195 (one conversation stream + reply drawer), #225, #246, #233, #212, #213/#209/#208/
#205 and #211/#190. Twelve conflicted files; resolutions are in the `a81dd748` message. Main code
that read the removed project work collection now uses bounded reads: the stream's root chips
(`useMessageWorkRead`, read only: the stream keeps #195's own position owner), announcement titles
and discussed tasks (one reference-row read of the visible `data-native-ref` rows), the thread root
(shown whole with what was made from it, in the thread's one association read), and proposal result
titles in Tasks (`5a739ac2`, by identity, ≤100; shown once read, `1e7d7ae0`). Contract text:
`bounded-native-work.md` ("One project conversation", 2026-10-05).

Integration fixes found by the full runs (each commit names the failing run):
- `fcf4a772` the thread's 15 s fallback refresh was restarted by every stream revalidation and never
  fired (test_typing.test_02 at `a81dd748`).
- `a03a2d26` a tab's own edited draft is no longer replaced by another tab's write (main's
  test_home_notes.test_01 at `17357b4a`; the branch's revisioned store adopted the other tab's text,
  so two tabs saving Home notes at once lost one; it is the branch's change, not a main flake and
  not intermittent: the cause is in `drafts.ts`, unchanged from `a81dd748` to `17357b4a`); the
  branch-only proposal-pagination seed in `check_application.sh` uses `node_modules/.bin/tsx` like
  main (`pnpm exec` made corepack fetch pnpm 12.6 and fail).
- `a3d16726` the reference-rows e2e enables the assistant with main's current disclosure (#192).
- Tests retargeted to the thread (`#thread`, `.thread__feed`, `.thread__pane`, `#thread-composer`,
  main's composer storage); no assertion removed. test_09 of test_typing now expects main's #195
  behaviour (the private prompt keeps its own draft) while still asserting no typing pulse.

### Remaining #155 acceptance implemented (`b4eb9d51`..`216bea2f`)

Design record: `studio-v11.6.md` UI116-5 "Implementation record". Pure rules in
`app/apps/web/src/ui/motion-rules.ts` (unit tests `tests/app/motion-rules.test.ts`).
- **AC-1** One traveling highlight for the project row and the work-tab mark: it moves from the
  trusted click (before the router renders), the item becomes current when its content shows; a
  newer choice retargets, a choice that does not happen returns it; transform only, `--dur-2`
  160 ms. Drafts, focus and the sidebar scroll are untouched. Arrivals: only entries newer than the
  newest one shown rise in (opacity + 4 px), only when visible and not under a modal; restored
  history, earlier pages and refreshes never move; a reader with earlier content keeps their place
  and gets one static "N new messages · N new tasks" line. Tests: `test_motion` 01–05, 07, 09.
- **AC-2** Typing in the Agents task thread (same canonical conversation as the task's thread in
  Conversation: one presence per person across both views, nothing created for it). Tests:
  `test_typing` 01–11 (new 10: task views dedupe, no stored message; new 11: phone keyboard height).
- **AC-3** The assistant's working mark moves only while the run executes (not queued/stopping);
  its text always says the state. Board placement/cancel/rollback/keyboard/menu/touch: main's
  `test_tasks_board` 03–09 (unchanged). Agents connection states have no motion.
- **AC-4** Loops pause while hidden, off screen or under a modal (`useLoopPause`; assistant and live
  marks); reduced motion = 0 ms tokens, nothing animates (`test_motion.test_05`); the typing line and
  the new-below line are static live regions announced once per change. Durations against the #151
  budgets: below.
- **AC-5** Navigation interruption (`test_motion` 01–03), reading anchors (07; the branch's
  association/reference journeys), keyboard (04), 200 % zoom emulated as 720×450 CSS px at DPR 2 and
  the phone drawer (06), virtual keyboard emulated by viewport height (`test_typing.test_11`),
  reduced motion (05), modal (08). Video: `motion/*.webm` (Chromium, recorded by the journeys at
  `216bea2f`; sha256 `03b0f4dc…` project interruption, `d0b27524…` tab interruption, `e89a8c99…`
  arrivals/new-below, `b7ecdff2…` two-user typing receiver) and the five `motion/*.png`.

### Measurements (`motion_performance.py`, opt-in, Docker)

`./scripts/check_ui.sh motion_performance` (FLUX_UI_PORT 19164) at **`60399670`** (motion code is
unchanged to `216bea2f`; later commits touch Tasks proposals and one test). Chromium 151.0.7922.34,
Python Playwright, 3 projects × 60 roots/40 tasks, a 40-reply thread, two people. Per distribution
30 warm-ups, ≥200 measured trusted actions over ≥60 s; page clock from the event's timeStamp to a
double-rAF paint proxy (not a raster claim). The phone profile is 390×844 with CDP 4× CPU
throttling: emulation, not a device. Report: `motion-performance-60399670.json`
(sha256 `15014d65…`). All within budget:

| p95 (ms) | budget | desktop | desktop, reduced motion | phone CPU4× |
| --- | ---: | ---: | ---: | ---: |
| Tab click → mark on the chosen tab | 150 / 300 | 55.4 | 58.2 | 62.2 |
| Tab click → motion ended | 370 / 520 | 187.7 | 58.2 | 229.6 |
| Tab click → view current (committed paint) | 2000 / 4000 | 119.3 | 89.2 | 241.6 |
| Tab journey longest frame | 50 / 100 | 16.8 | 16.8 | 66.7 |
| Project click → highlight on the chosen row | 150 | 67.0 | 66.8 | – |
| Project click → motion ended | 370 | 186.1 | 66.8 | – |
| Project click → project current | 2000 | 100.9 | 103.3 | – |
| Project journey longest frame | 50 | 16.8 | 16.8 | – |
| Reply keydown → input paint, typing live (n≈387) | 100 / 200 | 37.7 | – | 40.9 |

Earlier runs, kept because they drove the changes: at `17357b4a` the project highlight's feedback
p95 was 274.1 ms (the mark waited for the router) → `a03a2d26` moves it from the click; at
`a3d16726` its height transition laid out the sidebar every frame (committed p95 813.2 ms with
motion vs 105.0 ms reduced, longest frame 200 ms) → `60399670` moves it by transform only.

### Verification at the pushed head `216bea2f`

- Build, typecheck, lint (`docker build --target build`, `pnpm build && pnpm typecheck && pnpm lint`):
  pass, `eslint .` 0 problems (at `1e7d7ae0`; `216bea2f` changes one Python test only).
- Full `./scripts/check_ui.sh` (FLUX_UI_PORT 19162/19163): **364 run, OK, 4 skipped** (live media
  needs `check_live_ui.sh`). Log sha256 `077b9bce4b7d267c44fce61a46805bb9aba794c4fca8c80d5f850fcbf2f3d9e1`.
- Full `./scripts/check_application.sh` (FLUX_TEST_PORT 19160/19161): **exit 0**; main suite 915/915,
  then every later step (PWA 3/3, access stream, task actors, contributions, GitHub, proactive 6/6,
  proposal pagination, task plan, agent connections, session restart, background comparisons
  switched on, push/email unavailable). Log sha256 `423111f72a818c027dfb34cff9f49528a1577ab74b50321993a6e8e0e701f22f`.
  The first run at this head failed one main API test (`search.test.ts`, HTTP 500 "timeout exceeded
  when trying to connect", log `f5e494a6…`): the same pool-connect timeout (main's 1.5 s
  `connectionTimeoutMillis`) hit a different concurrency-heavy test in 3 of 7 runs (`stream.test`
  at `a81dd748`, `work-thought-tasks-native` at `5a739ac2`, `search` here) and passed in the others;
  recorded as a load-dependent flake, not fixed here.
- `assistant-reference-rows.e2e.ts` **7/7** and `github.e2e.ts` 1/1 at `a3d16726` (own overlay,
  ports 19168/19169; log sha256 `80a22738…`); the thread code is unchanged since.
- Unit: `motion-rules`, `message-associations`, `work-reference-window`, `architecture`, `stream`
  27/27 at `da0b2d89`.
- Intermittent once, then passing in 3 full runs: `test_work_associations.test_08` (one PageDown
  across a held batch, at `fcf4a772`).

### Not done here

- Real Android/iPhone/iPad, real 4K/ultrawide, real browser zoom and on-screen keyboards: emulated
  only. Independent visual and interaction review on this head (AC-5) and Hubert's evaluation.
- "Small panel/save/reconnect effects do not alter focus order" has no new dedicated test.
- The 128-socket typing transport budget stays the earlier separate measurement.

## Peer findings at `35910762` and what changed

1. **Reader retention (fixed, `642738dc`).** Root cause from an instrumented run at 390×844:
   the feed is attached once and never remounted. The reader's scroll (1569 → 534) had not yet
   produced its scroll event when the reference read's revision changed (window focus →
   revalidation). The reading-position layout effect re-ran with the anchor saved before that
   scroll and restored it, writing scrollTop 1569 itself; the late scroll event then looked like
   the hook's own write. (The earlier note's "nothing wrote that value" was wrong.) The effect now
   treats a scrollTop it neither saw nor wrote, on the same feed element, as the reader's position.
   New e2e holds the feed's scroll events to make that race deterministic: it fails on the
   previous hook (317.875 → 832.875) and passes now. Side effect: the first ready read no longer
   resets the opening position to the top before settling.
2. **RR2 bound (fixed, `379ce0c6`).** `selectReferenceWindow`: focused, interacted, proposal
   targets nearest the viewport first, visible citations; ≤100. Every loaded proposal target is
   read while there are ≤98; beyond that the farthest wait and stay "Checking…". Unit-tested at
   the 100-proposals-plus-focused boundary. Amendment text updated.
3. **Choice positions (fixed, `87f87730`).** Each search keeps its own page while the picker is
   mounted (≤20 per picker, least recently moved dropped; one account/project; Refresh → page 1).
   GitHub e2e now pages B between returns to A. Stated in `bounded-native-work.md`.
4. **Merged `origin/main` `1c9e36c5` (`d81aef87`).** The Kanban board runs on bounded group reads,
   not the project work collection: see
   `docs/development/performance/2026-10-04-native-task-board-integration.md` (not yet reviewed).
5. **Map task counts (#196) on a bounded selector (`84119fd9`, `7a4529d0`).** Main's #196 counted
   a thought's tasks from the project work collection, which #155 removes.
   `GET /projects/:id/work-thought-tasks?thoughtIds=` (1..100) returns exact per-thought counts and
   one window of ≤100 (thought, task) pairs; contract in `bounded-native-work.md`.
6. **Merged `origin/main` `24f49522` (`045e924a`) and `d94f70e4` (`e359bd47`).** Both clean or
   additive; `e359bd47` brings main's GitHub "No pull requests are linked" line, which
   `github.e2e.ts` asserts alongside the picker-page assertions.

## Branch-only UI failures fixed at the product level (`ec9023cf`..`6765a745`)

Merged `origin/main` `7a683420` (`ec9023cf`; conflicts in AppLayout, DocEditor, LinkPicker kept
both sides; main's new Agents view moved from the project work collection to the bounded
`pivot_work` choice page plus an own-object read for `?task=`). Build, typecheck and lint at
the merge: pass, 0 warnings after `22f865aa` (`WorkReadContext` store keyed by its owner).

Cause, from evidence:
- **Opening settle ended by non-reader scrolls (`600565f8`).** Baseline at `2b3c2960`
  (post-merge, pre-fix): `test_project_surface.test_02` fails (`w170c-base-ui.log` sha256
  `67b3d0e5d7bf172a03339404bcfa9d928136195b1add7f5aded8b6f75ad4adf6`). Fixed by `3b9ecff1`:
  the settle ends only on genuine reader input (`readerIntent.ts`), or on a scroll it did not
  write within 500 ms of it; a reading-position change found before its scroll event is the
  reader's only after such input (keeps `642738dc`).
- **Late layout under a hovering pointer (branch-only; `.ws-acts` CSS is identical to main).**
  A temporary per-frame instrumentation module (`test_zz_shiftdiag.py`, not committed, sha256
  `ad7d9670cfb1afe7a50d36f032f69455385769e5904f7b85f686d3f1dfd9b171`; failing run
  `w170c-diag-0de0a4bc.log` sha256
  `886dcac0c34694b368103f4a32c9421b5c5c4b9dd1d03170eb6b29d670a0698e`) showed, 15 ms after the
  hover in `test_work_decisions.test_04`: the first chips arrived (rows shifted ~96 px in a feed
  that was not scrollable), a "Loading work…" pager under the feed vanished (+49 px), and in
  another run the header's state line grew 50 px. On main all of these came with the route
  loader. Fixed by `9128f31e` (the feed is laid out but hidden, `aria-busy`, until the first
  message-work, reference and summary reads settle, at most 1 s; no pager placeholder before
  the first page) with `1c84dce7`/`c1afa3bc`/`0de0a4bc`/`8e942a3f` (pointer movement is reader
  input; input away from the end stops following; a recently moved pointer keeps its message at
  its screen position during growth; scroll events record the position as before and re-aim the
  pointer). Rules recorded in `bounded-native-work.md` (`26d638de`).
- Intermediate heads and why they were not enough (runs of `w170c-ui3x.sh`: 3 consecutive
  `check_ui.sh` runs; 4 modules until `0de0a4bc`, then also `test_work_associations` and
  `test_typing`): `3b9ecff1` test_02 fixed, `project_surface.test_05` 2/3 failed
  (`3b1e8ab9…`); `1c84dce7` work_decisions/test_05 failures (`387d4952…`); `c1afa3bc` 2/3 failed
  (`72b5749d…`); `0de0a4bc` 1/3 failed (`f736ed2a…`); `9128f31e` decisions fixed but
  `test_work_associations` 02/05–08 regressed 3/3 (`2d46dd39…`), fixed by `8e942a3f`.

Verification at `8e942a3f` and later:
- `w170c-ui3x.sh` (sha256 `a75fbf0a5f14a4f8f4396945623ee3552fb7821756fbee9b1f0294d9bb935fd6`):
  `./scripts/check_ui.sh test_project_surface test_work_decisions test_work_details
  test_agents_view test_work_associations test_typing` ×3 (`FLUX_UI_PORT=18912
  FLUX_UI_MAILPIT_PORT=18913`): **73/73, 73/73, 73/73** (`w170c-ui3x.log` sha256
  `118bdb9a502c04336c7682b1a904cceceeb682875c3e07d168f817b4b322e830`). Instrumented
  work-decisions journey at `9128f31e`: 10/10 ×3 (`w170c-diag.log` sha256
  `ffa08b5937d90fecb080e78c0647924780378b87fb586899c890c8752547e82d`).
- e2e (`w170b-e2e.sh`): `assistant-reference-rows.e2e.ts` **7/7** including the held-scroll test,
  `github.e2e.ts` 1/1, at `3b9ecff1` ×3, `c1afa3bc` and `8e942a3f` (`w170c-e2e-c.log` sha256
  `5e3177b803350069b83a8a76529b9305b9a5a346c809605c9314eedf210c0a5e`).
- Full `./scripts/check_application.sh` at `26d638de` (`FLUX_TEST_PORT=18910
  FLUX_TEST_MAILPIT_PORT=18911`): **exit 0**; main suite **796/796**, every later step passed
  (PWA 3/3, proactive 6/6, GitHub, task plan, agent connections, session restart,
  push/email unavailable). Log `w170c-check-app.log` sha256
  `6fd687b3bf9d725107ac5745443bd6e030b48725abdf14b7fb2bb6d43adbfcbd`.
- Full `./scripts/check_ui.sh` at `26d638de`: **284 run, 6 failures, 4 skipped** (live media).
  Every failure was `test_doc_references` 04/07/08 at both sizes, a branch-only test still
  expecting the pre-#197 editor line "New doc · everyone in <project> can read it". All other
  modules passed, including `test_project_surface` 19/19, `test_work_decisions` 10/10,
  `test_work_details` 10/10, `test_sketch_work_details`, `test_map_task_count` 9/9,
  `test_agents_view` 17/17, `test_wiki_panes` 14/14, `test_typing` 9/9. Log
  `w170c-check-ui.log` sha256 `762d34ce61dc6e6dfb924bb55106834594d2269d7fcb973de958e8aa7889d414`.
- `6765a745` (test-only) asserts the same statement in main's wiki editor: "New page" in the bar
  and "Everyone in <project> can read it" in the crumb. `./scripts/check_ui.sh
  test_doc_references test_docs`: **16/16** (`w170c-docrefs.log` sha256
  `7a035afd35f7895c7915900b3b6be4146ecc3aec4b1d3805bf3e90649bae8edb`).
- `test_work_details.test_08` (`2b3c2960`) now clicks the same project link in the sidebar's
  "Projects" navigation (main's #184 sidebar keeps Home/Inbox under "Places"); assertions after
  the click unchanged; 10/10 in every run above.

## Verified at `e359bd47` (2026-10-04, Docker, isolated projects, ports 18910–18919)

Raw logs are kept outside the repository; their sha256 is listed so a copy can be matched.

- **Image build + API/unit subset** (`pnpm build && pnpm typecheck && pnpm lint` in the image,
  then 16 files): `FLUX_REPO=$PWD FLUX_TEST_PORT=18914 FLUX_TEST_MAILPIT_PORT=18915 sh targeted.sh
  tests/app/typing-{access,admission,connection,core,diagnostics,sender-proofs,socket}.test.ts
  tests/app/work-read-{client,keys,native,query,service}.test.ts
  tests/app/work-reference-rows-native.test.ts tests/app/work-reference-window.test.ts
  tests/app/work-thought-tasks-native.test.ts tests/app/architecture.test.ts`
  (`targeted.sh` = `check_application.sh` setup, then `tsx --test --test-concurrency=1 <files>`):
  **141/141 pass**, 7 suites. Lint: 0 errors, 1 warning (`WorkReadContext.tsx:12`
  `react-hooks/exhaustive-deps`, unnecessary `accountId`/`projectId` memo dependencies; branch
  file, not a failure). Log `w170b-api.log` sha256 `61935c9376707c9267ade50c29cd360e3c385f85de6cf5114a2b6f0a2d82211a`.
- **e2e** (Chromium, own overlay adding a `reference-e2e` service on the e2e image; runner
  `w170b-e2e.sh` sha256 `fc1a2aafe5d6b3b8db9e4f97aac83109438538b66a3610bc74993dea6f7d3034`,
  ports 18916/18917): `tsx --test tests/app/e2e/assistant-reference-rows.e2e.ts` **7/7**, then
  `tsx --test tests/app/e2e/github.e2e.ts` **1/1** (includes main's empty-state line). Log
  `w170b-e2e.log` sha256 `ef77bbcf967059c57870d9acbcf6e2739575ae88d4e0b582adec646a8976d176`.
  (A first attempt, `w170b-e2e-harness1.log`, stopped before any test: the runner did not build
  the `ui-test` image the overlay's `anthropic-mock` uses.)
- **Full `check_application.sh`** (`FLUX_TEST_PORT=18910 FLUX_TEST_MAILPIT_PORT=18911`): main
  suite **790/790**, then PWA e2e 3/3, access-stream, task-discussion-actors,
  task-contribution-effects and GitHub e2e 1/1 each; **failed at `proactive-comparison.e2e.ts`
  (5/6)** and, under `set -e`, stopped there: work-proposal-pagination, task-plan,
  agent-connections, session-restart, push-unavailable and email-unavailable did **not run** at
  this head. Failure: line 182 `getByRole('heading', { name: 'Measure ToF response at 5 lux' })`
  is a strict-mode violation, matching both the Tasks board card (`.tb-card__t`) and the Details
  title. Log `w170b-check-app.log` sha256
  `aae221879a48b7d803b43a8a7e9fa6d9863278172035909917c2e684a8a13d8f`.
- **Full `check_ui.sh`** (`FLUX_UI_PORT=18912 FLUX_UI_MAILPIT_PORT=18913`): **253 run, 4 failures,
  2 errors, 4 skipped** (live-media tests need `check_live_ui.sh`). `test_map_task_count` **9/9**,
  `test_typing` 9/9, `test_theme_accents` 7/7. Failing: `test_project_surface.test_02`,
  `test_sketch_work_details.test_01` (2 workspace subtests), `test_work_decisions.test_04`
  (ERROR) and `test_06` (FAIL), `test_work_details.test_08` (ERROR). Log `w170b-check-ui.log`
  sha256 `1affe1c19bf197f5aea1a19abd422f570a4dea6652529726de82dde012ce75cc`.

### Failures at `e359bd47`, compared with main `d94f70e4`

Main was checked out detached at `d94f70e4` (the merged main) and run with the same scripts.

- **`proactive-comparison.e2e.ts`: test-locator race, fixed in the test (`581bf551`).** Repeat
  runner `w170b-proactive.sh` (sha256 `97fd639a29bd60b65b985b5cb06061295428350453902de6524deab486385581`:
  `check_application.sh` setup, then `REPS` × seed-proactive-ui + this e2e): branch `08a83c6b`
  **0/3** (`w170b-proactive-branch.log` sha256
  `215848ccbd90a08d718d854a273fba75558b2143e48ab81a5b7e1769ded346c5`), main **3/3**
  (`w170b-proactive-main.log` sha256
  `3561dd91c96ca31c6dd477811e0d12d6f654d56e8225b0068c0f528bcc15747a`). Same board-card markup on
  both; main passes only because its Details renders before the board. The wait is now scoped to
  `.wd[data-detail-kind="work"][data-detail-id=<fixture work>]`, which also proves the exact work
  opened. No application code changed.
- **`test_sketch_work_details.test_01` workspace subtests: stale branch expectation, fixed
  (`5dd9d24f`).** Main's #210 canonicalises `/map/:id` of a project sketch to
  `/projects/:p/map/:id` (main's `test_map_task_count` asserts it); this branch-only test still
  expected `/map/:id`. Both entries now assert the canonical project route.
- **`test_work_decisions.test_04`/`test_06`: intermittent on the branch, not fixed.** Test bodies
  are identical to main's. Branch: failed in 2 of 3 runs (`w170b-check-ui.log`, `w170b-branch-ui2.log` sha256
  `70b03aa5e9068af54d32ff4d257fbf47b426ada7ade9d22f9533246d6fc7580b`), passed 10/10 in the
  `f70686bb` rerun below and at `7a4529d0`.
  Main: 10/10 (`w170b-main-ui.log` sha256
  `dd4a84f2b46a77a795fc1d1ccbbe966269936e7fadfe9f99ad1fab419bc2cabf`). test_04: the message row
  intercepts the click on its "Result" action (`.ws-acts` is `pointer-events: none` until the row
  is hovered; Playwright's scroll-into-view loses the hover). test_06 follows from test_04's missing
  result. Same signature as `test_project_surface.test_05`.
- **`test_project_surface.test_02`: branch-only since ≤`35910762`, not fixed.** Main 12/12 in this
  module (test_02 body identical). A message is clipped at the top of the opening screen.
  `test_07` also failed once in the branch rerun (overflow button 54px below the author), passed
  in the full run. Hypothesis for this group (unverified): since `600565f8` the opening settle
  stops on any scroll it did not write; late layout from the asynchronous message-work previews
  can then leave the opening screen mid-message, putting the target row's hover toolbar
  (`top: -10px`) out of view.
- **`test_work_details.test_08`: branch-only test, stale shell expectation.** It looks for a
  project link under the sidebar "Places" navigation, which main's #184 sidebar no longer has.
  `test_work_details.py` does not exist on main.

## Rerun at `f70686bb` (no application change since `e359bd47`)

`git diff e359bd47 f70686bb -- app/apps app/packages docker scripts` is empty; the commits after
`e359bd47` change two tests and this note.

- Proactive repeat runner, `REPS=2`: **2/2 pass** (`w170b-proactive-branch2.log` sha256
  `3f8bf7a43a3ad30fd4a43a5b57dcf32b0e827cb0a89ee9002c4bc6c4d488760b`).
- `./scripts/check_ui.sh test_sketch_work_details test_work_decisions test_project_surface`
  (`FLUX_UI_PORT=18912 FLUX_UI_MAILPIT_PORT=18913`): **29/30**: `test_sketch_work_details` 1/1
  (all four subtests), `test_work_decisions` 10/10, `test_project_surface` 18/19 (only
  `test_02` fails). Log `w170b-branch-ui3.log` sha256
  `50c03eb6e812cd6b1b2e00971167e809d5a4b302a60c108dc6aaf0d5ae2c5f54`.
- Full `./scripts/check_application.sh` (`FLUX_TEST_PORT=18910 FLUX_TEST_MAILPIT_PORT=18911`):
  **exit 0**. Main suite 790/790; PWA 3/3; access-stream, task-discussion-actors,
  task-contribution-effects, GitHub 1/1 each; proactive comparison + outcomes 6/6;
  work-proposal-pagination, task-plan, agent-connections 1/1 each; session restart
  prepare/verify; push-unavailable and email-unavailable 1/1 each. Log `w170b-check-app2.log`
  sha256 `595b70f216175c9e6b473392376d26a571703790dcb01667248b4589e1b2643e`.
- Full `check_ui.sh` was not repeated at this head (no application change); its `e359bd47`
  result above stands with `test_sketch_work_details` now passing.

## Verified in Docker at `642738dc` (isolated projects, ports 18910–18919)

- API/unit subset (typing, work-read, reference rows, reference window, architecture): 86/86.
- `assistant-reference-rows.e2e.ts` 7/7 (unchanged retry journey plus the new pending-scroll test);
  `github.e2e.ts` 1/1.
- UI: `test_tasks_board`, `test_work_pagination`, `test_work_decisions`, `test_project_state`
  35/35 (at `379ce0c6`); `test_people`, `test_app_shell`, `test_project_state` 34/34;
  `test_personal_assistant`, `test_work_overview`, `test_work_pagination`, `test_work_details`,
  `test_project_surface`, `test_docs`, `test_tasks_board` 70/73.

## Open

- Not run: original #155 motion/typing acceptance, performance budgets (the board makes four
  bounded reads), devices.
- `ConversationStream.tsx` / `person()` named in the request does not exist on main `7a683420`;
  the requested semantics are implemented in `app/apps/web/src/work/readerIntent.ts`. Deviations
  from the requested input list: a pointer pressed anywhere in the feed (main's existing settle
  behaviour) and pointer movement (instrumented evidence above) also count as reader input.
- Deviation from the requested classification: the "reader only after genuine input" rule
  decides the pending-scroll race and ends the opening settle, but a scroll event the reading
  position did not write still records the reader's position (as before). Applying the rule to
  scroll events too (`3b9ecff1`..`9128f31e`) regressed `test_work_associations` 02/05–08 3/3: an
  arrival `scrollIntoView` to an early message must leave following the end. `8e942a3f` and the
  `bounded-native-work.md` paragraph are authoritative; the `3b9ecff1` message describes the
  superseded rule.
- Product decisions for the evaluator beyond the request: the conversation opens hidden for at
  most 1 s (`is-opening`, `aria-busy`) until its first bounded reads settle; the Agents view
  reads `pivot_work` pages (without `?task=`, moving to another page of open tasks changes the
  default task and opens its thread).
- Lint at the final application code (`6765a745` build in `w170c-docrefs.log`): `eslint .`
  printed nothing (0 problems).
