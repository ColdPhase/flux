# Independent camera diagnosis at exact6f9

2026-10-08. Evaluator `/root/final_queue_reviews`, read-only application/test investigation. Production source `6f962f6335cc7c560609a0c99c8309e1e83bf925`, actual retained API image `sha256:20ee0017ca5a45ceffddc089c70d59b0703fb76307892dceba5292a4d8d92a6a` and UI runner `sha256:e5c38f1e3a7d6ca3081eff885294049111580124921502102f720e56d2c24b05`. No application, maintained test, assertion or data in any shared/demo database was changed by evaluator. Every probe used a new owned Docker project and genuine isolated native fixture setup.

**Current reproduction is caused by Playwright actionability retry scrolling before input.** It is not evidence of Sheet focus or native-touch camera mutation. Original97 historical failure remains preserved and its exact historical event sequence was not retroactively reconstructed; its same0→334 symptom is consistent with this independently reproduced mechanism. Parent owns the recorded accepted disposition.

## Evidence sequence

1. Current independent maintained six-module UI run:71/71 OK185.725s, EXIT0. Original Map03/06 exact camera/zoom/selection/close comparisons passed. This did not erase the earlier failure.
2. Existing unmodified separate diagnostic at current6f9:6 contexts /54 snapshots. Dark repeat1 reproduced0→334;5 contexts stayed stable. The scroll event occurs at506.7ms BEFORE pointerdown507.8ms, while focus is still the view control; count focus509.3ms and Sheet focus514.2ms follow. Thus Sheet focus/Close restoration is later than the shift. Fonts are loaded and canvas358×375 throughout. Badge y575.875→242.875 matches its alignment to the canvas's top. Collection EXIT0 means collection completed, not PASS.
3. Observer-only broad contrast:24 contexts covering light/dark, original/settled font-layout baseline, locator versus uncovered coordinate touchscreen input. None shifted. Safe progress probe of6 original-path contexts also did not reproduce. These are retained non-reproductions, not a fix or waiver.
4. Controlled **natural production arrival** contrast:18/18 requested windows actually observed, none missed. No animations were created, disabled or forced; production motion remained enabled. All measured target centers were uncovered and inside the canvas. Exactly one delivery option changed in the two locator groups:

| Delivery during the actual early Map arrival animation | Observed | Camera shifts |
| --- | --- | --- |
| Ordinary `Locator.tap()` |6(light/dark×3) |6/6,0→334 before first pointerdown; persists after Close |
| Same normal actionability checks, public `Locator.tap(scroll="none")` |6(light/dark×3) |0/6; same3 stability retries |
| Trusted `page.touchscreen.tap` at measured uncovered center |6(light/dark×3) |0/6 |

The exact installed Playwright1.62 public Python signature accepts `scroll='auto'/'none'`. Its actual bundled `_retryPointerAction` cycles scroll alignment through default/end/center/start on retries, even when earlier attempts fail the stable-element check before scrolling. After3 entry-motion stability retries the ordinary tap uses `block:start`, and `_performPointerAction` scrolls before delivering touch input. Safe progress logs show those3 retries in both locator groups. With only auto-scrolling disabled, stability checks/input continue normally and the camera stays unchanged. This isolated contrast supplies causal evidence rather than an inference from stable reruns alone.

## Raw records

- Maintained run: `/tmp/flux282-6f9-independent-ui.log`;78 PNG/JSON artifacts in `/tmp/flux282-6f9-independent-ui-manifest.json`.
- First current reproduction: `/tmp/flux282-6f9-independent-camera/282-camera-diagnostic.json`,6 raw PNGs, manifest `/tmp/flux282-6f9-independent-camera-manifest.json`, log `/tmp/flux282-6f9-independent-camera.log`.
- Broad24 context trace: `/tmp/flux282-6f9-actionability/camera-actionability.json`; observer `/tmp/flux282-6f9-actionability-observer.py`; log `/tmp/flux282-6f9-actionability.log`.
- Safe6 context progress: `/tmp/flux282-6f9-progress-camera/282-camera-diagnostic.json` and `/tmp/flux282-6f9-progress-camera.log`.
- Causal18 context raw frames/events: `/tmp/flux282-6f9-arrival-camera/camera-actionability.json` (the retained filename), screenshots, log `/tmp/flux282-6f9-arrival-camera.log`, summary `/tmp/flux282-6f9-arrival-summary.json`, observer `/tmp/flux282-6f9-arrival-observer.py`.
- Exact installed driver source excerpt: `/tmp/flux282-6f9-pw-actionability-source.txt`. Progress output filters out API request/response headers, cookies and credentials; no full protocol/network trace or environment dump was saved.

All owned probe stacks/volumes/networks were removed. The two exact current UI/API image tags were intentionally retained for the owner's current test-only regression verification; no older624 images or results were relabelled.

## Correct continuation

Owner's pinned test-only `ed247ab7d34734d77989e72be549e32e753eeeb2` retains the original deliberate visibility scroll and exact camera baseline, requires actual uncovered/in-canvas target center and unchanged preinput camera, uses public tap(scroll="none") on that visible target, and adds opening equality while retaining Close/focus/other cases. No production change is indicated by this diagnosis. Independent source delta is acceptable; actual updated maintained verification is being run with the current one-file readonly overlay against these exact source-equivalent6f9 images.

Do not count18 diagnostic controls as18 maintained tests, call the old failure a production fix, infer external-device/WebKit acceptance, or close whole#276/F-026 from this bounded evidence. Current API127 and UI71 evidence remains commit/scope qualified; Search Mono and importer/public scope records plus normal protected remote gates remain separate.
