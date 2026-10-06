# Independent source-only reader typing delta review

Reviewed head: `230a33d1f6375bc150a5a6b5001d7869fd5228b4`.
Delta parent: `ca1385cb264094459cfc620c9480b75d0d3dd2c4`.
Worktree: `/Users/maurycyzamojski/Dev/Projekty/flux/.worktrees/155-truthful-typing` (clean when inspected).
Reviewer: independent subagent `/root/bounded_state_contract_review`; parent remains sole implementation writer. Date: 2026-10-03.

## Outcome

No material source finding in the three-file delta. The reader typing rendering correction conforms to the accepted contract, and the two assertion changes preserve or strengthen the applicable behavior requirements. This assessment is source-only; it does not approve runtime behavior, the whole #155 task, or a GitHub merge.

## Reviewed behavior

- `ProjectConversation.tsx:443` renders `TypingNotice` for an existing conversation while access has not been lost. The existing `useTyping` context already follows this same read-enabled condition. Its writable flag still gates publishing, and the neighboring writer condition still excludes the textarea, send control, and assistant invitation for readers. Known access loss removes the conversation surface and retires the typing context; the unchanged client also clears stale/closed transport snapshots. The change displays already permitted activity rather than introducing a new audience or publication path. The accepted typing contract explicitly permits viewers to watch and requires a readable notice without a write invitation.
- `test_typing.py` changes the reader expectation from a disabled composer to an absent composer plus visible read-only caption, matching the existing reader UI. It retains the assertions that the reader sees Alice's activity, sends no active frames, and clears activity upon current access revocation. The existing unrelated-reader DM isolation assertion is unchanged.
- `test_work_pagination.py` changes `1 work item` to the accepted native-state label `1 open task`. It retains the false-empty-state negative assertion and adds reachability checks: desktop activates the Open segment, while phone opens the overview and selects the named native task. Both assert the created object's exact title in the visible detail heading. These changes agree with the accepted native-state/read extension and do not weaken the separate native project-state suite.

## Verification limits

Independently inspected `git diff ca1385cb264094459cfc620c9480b75d0d3dd2c4 230a33d1f6375bc150a5a6b5001d7869fd5228b4`, nearby conversation rendering, `useTyping`, `TypingNotice`, client publication/lifecycle guards, reader tests, and the applicable checked-in contracts. Delta `git diff --check` and Python AST syntax parsing for both changed test files passed.

No app or browser test was executed by this reviewer. The owner reported a previous 59-browser run at the parent pin exposed the missing reader notice and a fresh eight-module/59-test run is in progress. Neither report is counted here as independently verified runtime PASS at this head. All original typing, task-plan, native-state, and whole-#155 acceptance gates remain required with current-head evidence and normal eligible independent evaluation.
