# #155 reference client — state on 2026-10-04 (claude-maurycy / Zamojski5)

Branch `claude-maurycy/155-truthful-typing` (draft PR #170). This replaces the earlier terminal
handoff note; the archived v2 runner, overlay and raw log stay in this folder.

## Done since the previous handoff (`fc8f62f6`)

- Merged current `main` (Studio 11.6 shell): the shell keeps this branch's bounded work summary
  (no full project work collections) with main's tab order/labels and state-line position.
- Production typing task alias: `typingRoutes` gets `typingTaskDiscussion(db)` (read-only
  `getDiscussionRoot` with current `project.read`; creates nothing). Regression in
  `typing-access.test.ts`: no alias before a genuine contribution, the actual root after it,
  viewer read-only, outsider/unknown task null, revoked grant ends it.
- Reading position: one owner (`useMessageReadingPosition`) keeps the reader's row and follows
  the end for a reader who is there (only scrolling up leaves following); reader scrolls are
  recorded even while a message batch reloads; the initial settle loop stops on any scroll or
  focus it did not cause.
- RR2 amendment (see `docs/development/performance/2026-10-03-native-reference-row-extension.md`):
  every proposal target in the loaded window is read first (still ≤100), so Accept/Dismiss
  authority no longer depends on scroll.
- GitHub e2e expects a cleared search to return to the window the person left.
- Raw evidence over 300 lines is gzip-only.

## Verified in Docker (isolated projects, this machine)

At the branch head before this note: API 83/83 (typing, work-read, reference rows, architecture);
UI `test_personal_assistant`, `test_work_overview`, `test_work_pagination` 24/24;
`github.e2e.ts` 1/1 (105 native tasks, 50-row windows, private selection);
`assistant-reference-rows.e2e.ts` **5/6**.

## Open defect (not weakened)

`required metadata retry … answer reading anchor`: the test now also asserts the answer is still in
view before the refresh. Observed at 390×844: the reader scrolls to an earlier answer
(feed `scrollTop` 534), then, when the lost-response reply commits and the reference failure
notice appears, the feed is back at its previous position (1569). Console tracing shows neither the
reading-position hook nor follow/settle wrote that value, and the hook's scroll listener did not
see the reader's scroll — suspected feed re-attachment/remount around the identity refresh.
Next: log `attachFeed` calls and feed element identity across that refresh.

## Not claimed

Full `check_application.sh`/`check_ui.sh` on this head, the original #155 motion/typing
acceptance (AC-1–AC-5 video, reduced motion, two-user typing UI), performance budgets, devices.
