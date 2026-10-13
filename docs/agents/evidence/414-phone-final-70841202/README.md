# #414 phone-shell evidence at 70841202

This compact evidence record is parented to exact source PR head `7084120254f35c44ca542b29941aee873abe1938` (#414), based on `main` at `4a696b6679eea6dcdd1e2de15ffcc5011b6e54e8`. The source PR worktree is clean and its head is unchanged. The packet contains 22 lossless WebP frames with PNG hashes, pixel dimensions, CSS viewports, DPR, theme, and fixture/scenario in `manifest.json`. Each WebP was decoded and pixel-compared to its PNG source.

The first 16 frames were captured from production source `46f635e9234dceca5eab453d8a12754c3c74ba48`; this production tree is identical to 70841202, which changes only a PhoneFinal09 test expectation. Six additional frames (opened project Details at two widths/themes and returning-user Home in two themes) were captured on exact head 70841202. The first Home frames use a new-account fixture without prior work; the added Home frames use HomeFinal's returning-user fixture with a Continue card.

## Verification

- Chromium selected journey set at 46f635e9: 14/15 passed. The only failure was a stale PhoneFinal09 heading expectation after `/tasks` became Home with an empty-state heading. The corrected assertion passed 1/1 at 70841202; production source did not change between those pins.
- WebKit at exact 70841202: 15/15 selected journeys passed.
- Required CI at exact 70841202: [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38468634308) and [Application validation](https://github.com/ColdPhase/flux/actions/runs/38468634319) passed.
- Capture-only selectors: project Details captured 1/1 and returning Home captured 1/1. The first combined capture attempt had a harness binding error in its Home wrapper after the Details capture passed; the corrected Home-only attempt passed. This was not a product test failure. Run IDs, cleanup, and exact harness are recorded in `capture-run-record.md` and `capture-harness*.py`.
- Docker cleanup was verified after each run.

## Independent visual review

`initial-visual-review.md` records the first image-only assessment. Its initial Home omission concern was resolved by the returning-user fixture: the empty Home was a new account with no return point. Its opened-Details and viewport questions were resolved by the exact-head additions. `followup-shell-verdict.md` is the current scoped verdict: no blocking visual conformance issue was established for this shell slice. A repeated task title in Details is optional low-severity polish.

The phone Tasks toolbar remains an integrated conformance issue owned by #375, outside #414 source scope. Do not treat the inherited Search/Kanban/List/Mine row and status controls as conformant or as a #414-specific fix. #341 remains open for this and its other unfinished criteria; this PR is partial.

## Files

- `manifest.json` — all 22 frame hashes, source pins, actual viewports, DPR, theme, fixture/scenario.
- `neutral-brief.md` — visual review scope and canonical F-026 references.
- `initial-visual-review.md`, `followup-details-visual-review.md`, `followup-shell-verdict.md` — initial and follow-up independent visual reports.
- `browser-results.md` — exact selector and CI details.
- `screens/` — 22 pixel-identical lossless WebP frames.
- `logs/` — successful browser output plus corrected Home capture log.
- `capture-harness.py`, `capture-harness-attempt1.py`, `capture-run-record.md` — temporary capture implementation and transparent run history.
