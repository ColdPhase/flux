# Independent source evaluation — native document reference owner fences

Reviewed head: `8ac82c405d9b20d6f20470a168247acdfddc9cfa`.
Slice baseline: `c4f01936e5cdc49eae8b0fe7978b7f8daf6126df`.
Prior source finding pin: `a61cf336b6bcef916dd8c1c36588fc4e14e810ca`.
Owner-reported runtime baseline: `6db070846f4b37af83491b1749c92a349796a7e8`.
Reviewer: independent subagent `/root/bounded_state_contract_review`, source only, no branch/source or GitHub edits. Date: 2026-10-03.

## Outcome and remaining finding

The prior P1 private editor ownership finding is addressed in source. One narrower P2 remains in asynchronous save completion; LP1–4 and whole #155 are not accepted by this report.

**[P2] Fence save completion during a pending navigation/reconciliation, before the old editor unmounts.** `DocEditor.tsx:137–140` checks only `mounted.current` after awaiting the native save. Starting navigation to another project leaves the old editor mounted while destination loaders are pending. If the delayed save finishes in that interval, it still clears its private retry storage and calls `navigate` back to the old document reader, replacing/interfering with the user's chosen navigation. The `reconciling` guard at line 132 gates new save dispatch only; it does not govern the already-running callback. An account reconciliation has the same pre-commit lifetime window.

Concrete Docker reproduction to add: start an A-project save and hold its successful HTTP response after native commit; start navigation to the B-project editor while holding B's project/editor loader response; release A's save while B is still loading; then release B. Expected: the requested B destination proceeds, A's callback cannot redirect it or consume a retired owner's stored retry state. Current source allows the A redirect because its layout cleanup has not run. The existing new test releases the save only after the B editor is visible, which verifies post-commit retirement and misses this earlier interval. Use a current reconciliation/transition ownership guard at completion, or retire the callback when the owning editor transition begins; preserve the successful native effect and safe same-key retry semantics. This is a source finding, not an executed reproduction by this reviewer.

## Prior P1 and source review

- The stateful editor is now keyed by account/project/document. Each new owner restores its own storage slot and gets its own mounted ref, picker state, draft, base, preview, and attempt. Returning A→B→A creates a new A lifetime; the original A ref remains false, so its delayed callbacks cannot revive simply because the identity tuple repeats. Same-document version revalidation retains the intended conflict behavior.
- Layout cleanup retires callbacks after the old lifetime unmounts. Aborted preview completions explicitly check the signal before publishing. Persisting `attempt` alongside the owner's private fields/base preserves the UUID across a retired save and a return to that owner; normal edits still select a new command identity. The new delayed-save test asserts the restored UUID is submitted and only one native document exists after retry.
- Native choices remain three separate enabled 50-row observations, with per-kind paging and no collection concatenation. All remains mixed discovery capped at 40, with an explicit type selector for full native paging. Literal title search and existing kind-prefix behavior are unchanged from the prior inspected slice; exact kind/ID mapping, Markdown escaping, self-exclusion, and reader destinations remain coherent.
- Required failure/loading suppresses partial options; retry preserves current query/editor text. Account/project/selector render fencing and generation checks remain in the shared read store. Selected keyboard position is now keyed during render by owner/type/query/native observation rather than resetting in a later effect, and list scrolling exposes the selected option inside its own viewport.
- The existing docs tests only narrow combobox/listbox locators to distinguish the newly added type select; their reference insertion expectations remain unchanged.

## Test semantics and verification limits

New browser test source covers actual native >100-object paging/search, foreign-project exclusion, six exact references and persisted mentions, self-exclusion, failure/retry, same-document project/document draft changes, account switch with a held old native response, native title mutation plus query A→B→A, and a delayed native save followed by post-commit scope change and same-UUID retry. The last four scope tests currently use desktop scenes; phone execution of those specific fences and the separate neutral rendered assessment remain unverified LP4 requirements. Browser-held responses also do not by themselves prove a transport that ignores abort; source generation guards and their relevant unit evidence must retain that distinction.

Independently inspected the full six-file source delta since the slice baseline, nearby editor/router integration and the existing choice/read store. `git diff --check` and Python AST syntax parsing of both changed UI test files passed. I inspected `/tmp/flux155-doc-ref-ui-baseline.log`: it reports 10 tests passing and two private project/account draft tests failing, consistent with the owner-reported prior baseline; I did not execute that baseline.

No current Docker build/application/browser test was run by this reviewer. The owner's selected 14-test current run was pending when assigned and is not counted here as independently executed PASS. The prior P1 is closed at source level only; the P2 needs repair and a pinned regression. All original LP1–4, #155, scale/parent migration, native state/task-plan, device/provider/release criteria remain required. Eligible final GitHub evaluation remains with the designated independent peer.
