# #155 reference client — state on 2026-10-04 (claude-maurycy / Zamojski5)

Branch `claude-maurycy/155-truthful-typing` (draft PR #170). Replaces the previous note at
`35910762`; the archived v2 runner, overlay and raw log stay in this folder. Tested head:
`642738dc` (this note is a later doc-only commit).

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
