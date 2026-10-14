# Task creation Undo evidence for source `2b586920`

The source under review is `2b58692015218f9cb0acc132fadd313eb3df99cc`, composed with current `main` at `32d5c7794844ecd7fdf6a9e5dbd643144e833230`. The composition adds the Wiki change only; independent source review confirmed Undo implementation, API, migration, tests, tooling and scripts are unchanged from the tested source. The `LiveEntry` difference is the Wiki-specific menu variant; the Undo E2E route surfaces use the default header and unchanged inline behavior.

## Verification

- Current exact-head required checks: Agent setup (run `38522209246`) and Application validation (run `38522209214`) pass.
- Bounded Undo API/core/migration/reversal tests at `b4f01d958f5764e752951be90fdf5eec5346ada4`: 65/65 pass, including the accepted migration 0059 compatibility and preservation of Undo history (`logs/flux394-b4-focused.log.gz`).
- Undo E2E at `127221579838b6353efdd99c3cdaeb55ff96f4ac`: Chromium test C1 1/1 pass; WebKit W10 10/10 pass. Compose cleanup completed. The latest UI source is equivalent for these routes; the subsequent main composition changes only Wiki UI.
- Paired `scripts/check_backup.sh` at exact composed tree `2b586920`: PASS. It exercised DB and files backup/restore, historical reverted task/notices/receipt and bearer state, schema 94 upgrade from prior main with migrations 0048/0060, guarded pre-use reversal to the prior image, re-upgrade, refusal after use and failed-upgrade recovery. Compose cleanup completed. Full transcript is in `logs/flux394-2b586920-backup-restore.log.gz`.

## Visual captures

Frames show retained Undo history, keyboard navigation and Undo notice. Chromium frames were captured by the successful `test_9` run at `3c677fe56470e3a80836e46151eae4d59b855d1e`; WebKit frames were captured by the successful W10 run at `127221579838b6353efdd99c3cdaeb55ff96f4ac`. Viewports are 1280×900 and 390×844, light theme; zoom was not measured. The neutral visual review found no concrete P1/P2; see `visual-review.md`.

## Retained failed attempts

The earlier test failures remain available in `logs/flux394-3c677fe-e2e-run.log.gz` and `logs/flux394-68eb227-e2e-run.log.gz`. The C2 failure was a fixture that selected an agent-owned task, which the current hand-off correctly filters out; the fixture was corrected to use a human-created task. Another C1 attempt raced async loading of task options; the final test awaits `selectOption` before checking both kept and excluded task options. Assertions were preserved. These historical failures are not counted as passes.

`SHA256SUMS` covers every file in this directory except itself.
