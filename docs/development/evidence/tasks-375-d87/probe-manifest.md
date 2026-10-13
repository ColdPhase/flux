# PR #375 d87 phone scroll and recovery probe

- Product source pin: `d87fde2df4cbddafc8fb6c4771d5d9fda9eab8a2`.
- This is a detached worktree; the only diff is a temporary test method in `app/tests/ui/test_tasks_final.py`. No product source is changed.
- Harness SHA-256: `a446288202b89b18f3a501c2f9137f5ad5a6855674886e1836c4a93c0267134a` (copy: `harness-test_tasks_final.py`).
- Runtime result: Chromium, `Ran 2 tests in 4.249s / OK`, Compose project `flux-ui-1791928331-2719907`, tool session 19985. The probe worktree's source commit stayed at d87; only the temporary UI test module differs. `git diff --check` passed and Compose cleanup removed this project's containers, volumes, networks, and per-run images.
- Browser run: one Chromium UI run through `scripts/check_ui.sh`, using the normal Compose source stack, fresh project/ports and an isolated screenshot directory.
- Viewport: 320×568 CSS px, DPR 3, light/default text. Fixture: the existing `TasksFinalJourney.test_01` six-task Community garden sensors project, with `All` explicitly selected.
- Selected unittest IDs, in fixture order:
  1. `test_tasks_final.TasksFinalJourney.test_01_a_project_with_every_kind_of_owner_and_state`
  2. `test_tasks_final.TasksFinalJourney.test_14_diagnostic_phone_scroll_and_refresh_recovery`
- Probe assertions: final task row fully within `.pane-scroll` and center hit-testable after scrolling to bottom; offline error toast close button center hit-testable; after dismissal and scrolling, `Refresh work` fully within the scrollport and center hit-testable; restoring network and activating Refresh restores all six task rows and removes the error heading.
- Screenshots are produced by the existing `shot` helper in the isolated screenshot directory. The temporary harness file and its SHA-256 are recorded beside this manifest before execution.

Measured values and three screenshots are in `probe-output-excerpt.txt` and `screenshots/`. At the list bottom, `scrollTop=271`, `scrollHeight=615`, `clientHeight=344`; the final row occupied y=319.80–381.80 inside the scrollport y=77.55–422 and its center hit the row title. The offline toast close hit-test succeeded. After dismissal and scrolling, `Refresh work` occupied y=305.13–326.56 inside the same scrollport and its center hit the button; restoring the connection and activating it returned all six rows.

This probe checks whether the short phone view remains usable by scrolling and whether the offline recovery control can be reached after dismissing feedback. It does not change or redefine UI behavior.
