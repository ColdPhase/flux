# #155 reference client — state on 2026-10-04 (claude-maurycy / Zamojski5)

Branch `claude-maurycy/155-truthful-typing` (draft PR #170). Replaces the previous note at
`35910762`; the archived v2 runner, overlay and raw log stay in this folder (their `sha256.json`
is archival and does not cover this note). Latest tested head: `e359bd47` (see "Verified at
`e359bd47`" below; this note is a later doc-only commit).

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
<!-- more -->

## Verified in Docker at `642738dc` (isolated projects, ports 18910–18919)

- API/unit subset (typing, work-read, reference rows, reference window, architecture): 86/86.
- `assistant-reference-rows.e2e.ts` 7/7 (unchanged retry journey plus the new pending-scroll test);
  `github.e2e.ts` 1/1.
- UI: `test_tasks_board`, `test_work_pagination`, `test_work_decisions`, `test_project_state`
  35/35 (at `379ce0c6`); `test_people`, `test_app_shell`, `test_project_state` 34/34;
  `test_personal_assistant`, `test_work_overview`, `test_work_pagination`, `test_work_details`,
  `test_project_surface`, `test_docs`, `test_tasks_board` 70/73.

## Open

- Failing before this work too (also at `35910762`): `test_project_surface.test_02` (a message is
  clipped at the top of the opening screen) and `test_work_details.test_08` (looks for a project
  link under the sidebar's "Places" navigation, which holds Home/Inbox only).
  `test_project_surface.test_05` is intermittent (the message row intercepts the click on
  "Details of this message"; it failed at `35910762` and `642738dc`, passed at `379ce0c6`).
- Not run: full `check_application.sh`/`check_ui.sh`, original #155 motion/typing acceptance,
  performance budgets (the board makes four bounded reads), devices.
