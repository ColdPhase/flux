# #414 visual supplement capture record

Source PR head: `7084120254f35c44ca542b29941aee873abe1938`. Product source was unchanged during capture; the only temporary worktree addition was the harness below, removed after the captures.

- Harness: `capture_414_missing_frames.py` (SHA-256 `27c6332031aa5588f1223f7265305ea891e8af4cff716542ccce6e658699f1e8`).
- Details run: `FLUX_UI_BROWSER=chromium FLUX_UI_SCREENSHOT_DIR=FLUX_UI_SCREENSHOT_DIR=<archive-root>/screens ./scripts/check_ui.sh capture_414_missing_frames.ProjectDetailsCapture.test_capture_project_details capture_414_missing_frames.ReturningHomeCapture.test_capture_returning_home_continue`; Compose project `flux-ui-1791926115-2650807`. The Details selector passed and produced four frames. The Home selector exposed a harness binding error before capture; this was not a product assertion. The failure and original harness are preserved as `capture_414_missing_frames-attempt1.py`.
- Corrected Home-only run: `FLUX_UI_BROWSER=chromium FLUX_UI_SCREENSHOT_DIR=FLUX_UI_SCREENSHOT_DIR=<archive-root>/screens ./scripts/check_ui.sh capture_414_missing_frames.ReturningHomeCapture.test_capture_returning_home_continue`; Compose project `flux-ui-1791926275-2655901`, 1/1 PASS.
- Both runs used the standard Docker runner; cleanup removed their per-run containers, volumes, networks, and images.
- Exact frame viewport, DPR, scenario, and SHA-256 are in `manifest.json`.
