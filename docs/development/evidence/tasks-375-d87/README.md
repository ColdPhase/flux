# PR #375 evidence at source revision d87

Source revision exercised: [`d87fde2df4cbddafc8fb6c4771d5d9fda9eab8a2`](https://github.com/ColdPhase/flux/commit/d87fde2df4cbddafc8fb6c4771d5d9fda9eab8a2). The evidence commit that carries this directory is documentation-only; its parent tree is the tested product revision. The PR remains open for current independent review.

## Current-head verification

Required GitHub checks for d87 passed:

- [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38472826828/job/115556012670)
- [Application validation](https://github.com/ColdPhase/flux/actions/runs/38472827021/job/115556495507)

Docker UI checks at the exact source revision passed:

- Chromium: 8/8 in 48.264 s; full runner output is `logs/chromium-c8.log`.
- WebKit: 15/15 in 77.814 s; full runner output is `logs/webkit-w15.log`.

Chromium covered `TasksFinalJourney` 01, 07, 11 and `TasksReviewJourney` 01, 04, 08, 10, 11. WebKit covered `TasksFinalJourney` 01, 04, 05, 07, 08, 09, 11; `TasksReviewJourney` 01, 04, 08, 10, 11; and `InboxFinal` 03, 04, 14. The source-pinned logs include the full unittest names and Compose cleanup output. The two existing runner projects were removed, including their containers, volumes, networks and per-run images.

These are impact-selected current-head runs, not a claim that every repository test or release acceptance suite was run. They exercise task row/phone filter presentation, state changes and Undo, session identity fencing and delayed responses, phone toast/footer behavior, offline recovery and shared Inbox effects.

## Phone scroll and recovery probe

`probe-manifest.md` records the detached exact-d87 fixture, source cleanliness, command context and selected methods. Its single temporary test method and source hash are preserved in `probe-harness.py` for reproducibility. Product files were unchanged. `probe-output-excerpt.txt` is an excerpt of actual stdout, not a complete runner log; early stdout was not persisted. The recorded result was Chromium 2/2, and cleanup removed the isolated project resources.

At 320×568 CSS px, DPR 3, light theme, with All explicitly selected and six seeded tasks, the final row at scroll bottom measured y=319.80–381.80 inside the scrollport y=77.55–422 and its center hit the row title. After dismissing the offline toast, “Refresh work” measured y=305.13–326.56 inside the scrollport and was hit-testable; restoring connectivity and activating it restored all six rows. The three screenshots are in `screenshots/probe/`.

## Visual review

`neutral-brief.md` records the fixture and screenshot provenance. `visual-review-initial.md` is retained as the original independent evaluation. `visual-review-final-disposition.md` records the follow-up after the scroll/recovery probe: the initial P2 claim that task content was inaccessible is withdrawn; the visible toast overlap is P3 polish because its close action and subsequent recovery path are reachable. No required visual issue remained in the supplied d87 screenshots and probe. The images do not establish accessibility or broad responsive acceptance.

The WebKit desktop Undo frames show the post-Undo confirmation (“back to open”), not the original offered Undo action. The separate test logs cover the actionable state and Undo interaction. All screenshot files here are lossless WebP conversions; decoding them reproduces the source PNG pixels exactly. `SHA256SUMS` records hashes for the included evidence files.

## Criteria and remaining scope

For [#346](https://github.com/ColdPhase/flux/issues/346), this PR implements the task board/list and phone list, readable state and ownership, state change/Undo behavior, and the phone Tasks screen without a second toolbar (the phone title menu and its own filter remain). The current browser selection verifies representative computer/phone states and the changed feedback/session paths. AC-3’s broader board drag/keyboard and the full issue matrix are not claimed as newly re-run by these selected checks. Keep #346 open pending the independent current-head evaluation and its complete acceptance decision.

This PR also supplies the Tasks-route portion of [#341](https://github.com/ColdPhase/flux/issues/341) AC-3/AC-5: the phone Tasks route has no chip toolbar, uses the title menu and filter row, and its tested touch targets meet the current checks. #341 remains open for its other routes and remaining whole-shell criteria; do not infer whole-phone-shell completion from this PR. Related phone-shell implementation is in #414, while the integrated Tasks toolbar criterion belongs to #346/#375. No issue was closed by this evidence update.

## Integrity

Run `sha256sum -c SHA256SUMS` from this directory to verify the included files. The original probe run was not archived as a complete stdout log; this limitation is preserved above rather than reconstructing missing output.
