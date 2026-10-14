# PR #374 evidence — exact source 6b344ac

PR: https://github.com/ColdPhase/flux/pull/374  
Source head: `6b344acedd1479e5f4e1ffcc03accd85937f6754` on `claude-hubert/354-wiki`  
Base at composition: `d7f8d8defbee91e0f0d78fee95841b026ae00c31` (`main`)  
Parent task: [#354](https://github.com/ColdPhase/flux/issues/354), still open. The archive commit is a docs-only child of the exact source head; it is reachable by the annotated archive tag and does not change the PR head.

Independent exact-head Sol evaluation: [scoped technical PASS](https://github.com/ColdPhase/flux/pull/374#pullrequestreview-5513770452). It finds no remaining P1/P2 in the delivered Wiki slice. It does not close #354 or claim release acceptance. The current exact-head Actions checks are [Application validation](https://github.com/ColdPhase/flux/actions/runs/38519098710) and [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38519098742), both successful.

## #354 acceptance map

- **AC-1, computer Wiki:** scoped PASS for the delivered page list/reader, attribution and outline. Current run logs do not claim a fresh complete desktop-reader suite; the evaluator retains prior compatible evidence only where production bytes are unchanged.
- **AC-2, references:** scoped PASS for accepted-decision cards and task references. This also relies on retained compatible evidence for unchanged implementation; no new broad reference suite is claimed here.
- **AC-3, phone Wiki:** scoped PASS for the integrated title/menu, `Wiki · N pages` context, page chips, reader/edit placement and absence of competing Wiki toolbars. Exact-head Chromium and WebKit WikiFinal coverage plus the nine current Chromium frames are recorded below.
- **AC-4, existing behavior:** current evidence covers the ordered export/audience journey and Wiki phone sharing/refusal, focus and overflow paths. The original exact-head WebKit run still records a cleanup `pageerror` in `PhoneScenarios.test_5`; the same-source diagnostic passed that journey with its unchanged error guard, but did not reproduce the pageerror. Actual agent-authored Wiki writes and native WebKit clipboard remain unverified.
- **AC-5, render and keyboard:** scoped visual review of the supplied nine Chromium frames finds no P1/P2 composition defect. The packet does not include a wide-table frame, open Details frame, dark 320px frame or phone import-refusal frame; the visual review records these limits. This is not a full light/dark, viewport, keyboard or release acceptance pass.

The integrated parent acceptance remains broader than this Wiki slice. Keep #354 open and its full AC-1–5 unchanged; do not infer whole-issue completion from this PR handoff.

## Exact-head verification

- Chromium, exact 6b: **5 passed** in 12.820s. Selectors: WikiFinal phone title/chips/edit; WikiFinal no other toolbars; WikiPanes fixture setup; import/refusal; WikiPanes phone index-before-document. The actual run is `logs/chromium-5tests.log.gz`.
- WebKit, exact 6b original run: **16 methods, 14 passed, 1 failed, 1 expected failure** in 82.834s. All seven WikiFinal methods pass; `PhoneScenarios.test_6_export_and_audience` passes. The single failure is the unhandled-pageerror guard in scenario 5, not a failed Wiki content assertion. See `logs/webkit-original-16methods.log.gz`.
- WebKit, exact 6b diagnostic: **8 methods, 7 passed, 1 expected failure** in 63.243s; scenario 5 passed with the original unhandled-pageerror assertion intact. Two `/api/v1/needs-you` requests were recorded as `Load request cancelled` immediately before the DM-to-project hard navigation; the project route then fetched the endpoint with HTTP 200. No `pageerror` recurred. This supports a navigation-cancellation correlation but does not conclusively establish the earlier pageerror's cause. No product change or error suppression followed. See `logs/webkit-diagnostic-8methods.log.gz`, `diagnostic-instrumentation.patch` and `diagnostic-provenance.md`.
- The first diagnostic invocation used the non-TestCase mixin as its unittest selector and stopped before running tests. It is retained as an explicitly no-tests harness attempt in `logs/selector-loader-failure-no-tests.log.gz`; it contributes no runtime result.

Compose cleanup was verified after the corrected WebKit diagnostic. The diagnostic patch is test-only instrumentation in a detached temporary worktree; that worktree was removed after archiving. Source branch remains at the pinned head above.

## Files

`visual-manifest.json` maps each exact current Chromium PNG and source PNG hash to its lossless WebP archive image, with CSS viewport, DPR, theme and fixture state. `visual-review-sol61.md` is the independent source-free appearance review; `neutral-visual-brief.md` records the neutral scenario and corrected fixture distinctions. `SHA256SUMS` covers every file in this packet.
