# Current Soft volume verification (#338 / PR #353)

Date: 2026-10-07. Tested application and browser-test source:
`33362d428a9b6393bfe0d9d44ad23430e9e0fde9`. These captures replace the older
before/after pairs as evidence for the final corrections. This directory and
its report are documentation only; they do not change the tested application.

## Behavior and checks

The final Docker run used the repository's pinned browser images, a clean Compose
project/volumes, ports 18685/18686 and no Web Push keys:

```sh
FLUX_UI_PORT=18685 FLUX_UI_MAILPIT_PORT=18686 \
FLUX_UI_SCREENSHOT_DIR=/tmp/flux353-keyboard-radio/screenshots \
FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= \
./scripts/check_ui.sh test_soft_volume test_file_messages test_work_details
```

Result: **27/27 tests pass, 82.620 seconds**. The same Docker build completes the
application build, type check and lint. The run cleans up its Compose containers,
volumes/networks and two per-run images.

- Sixteen SoftVolume cases use separate real accounts in Chromium and WebKit.
  Both engines exercise light/dark and 1440×900 / 390×844 CSS viewports. They check
  actual theme/storage migration, loaded same-origin Geist/Geist Mono, component
  shape/press/reduced motion, all five state glyphs beside explicit state words,
  and a real Open task parked by an accepted native pivot. Ordinary task titles
  contain no status words. The composited contrast guard requires opaque glyphs
  and at least 3:1; the parked mark uses an opaque muted token.
- Real project-conversation time, stored `calibration.csv`, private uploaded
  `delivery.csv` draft/size and native count use Geist Mono in both themes and
  viewports. No synthetic demonstration DOM substitutes for those fields.
- A private two-person DM verifies the owner's readable initials and real
  shortcut keys. A native task Details title grows with 200% root text size in
  both engines and viewports without horizontal overflow.
- Actual native pivot radio selection remains neutral. Pointer selection and
  ArrowRight change the choice; Tab/Shift+Tab keyboard entry shows a neutral 2px
  visible focus ring. Both engines, themes and viewports check selected/focused
  state and at least 3:1 accent contrast.
- One file-only message journey and ten native work-Details journeys retain
  file/task creation, read persistence, paginated relationships/choices,
  unavailable/conflict drafts, pivot acceptance, held-command continuity and
  correct project scope.

At that source: `scripts/check_contrast.py` passes all **48 pairs**;
`python3 -m unittest discover -s tests -p 'test_*.py'` passes **76 tests**;
`check_agent_setup.py` and `git diff --check` pass. API/full browser-suite release
acceptance is not claimed from this targeted run.

The intermediate `945c3c14` run had four WebKit subtest failures: after pointer
selection and ArrowRight, the browser did not classify focus as `:focus-visible`.
The final test exercises actual Tab entry before requiring that focus ring;
selection, keyboard movement, focus, contrast and all original assertions remain.
Its production stylesheet is identical to the final tested source. Earlier
full-suite failures and earlier narrow reruns in the PR history are historical,
not a current full-suite pass.

## Captures

These twelve unmodified PNGs are selected from the complete 50-image final run.
Phone captures use DPR 3; dimensions below are CSS dimensions. Synthetic names,
messages and files are fixture content, not live user data.

| Scene | Capture |
| --- | --- |
| Five normal states, Chromium, desktop/light | [1440×900](338-chromium-task-glyphs-1440-light.png) |
| Parked Open task, WebKit, phone/dark | [390×844](338-webkit-task-parked-390-dark.png) |
| Own DM initials/keys, Chromium, desktop/dark | [1440×900](338-chromium-dm-details-1440-dark.png) |
| Own DM initials/keys, WebKit, phone/light | [390×844](338-webkit-dm-details-390-light.png) |
| Actual saved file and private upload, Chromium, desktop/light | [1440×900](338-chromium-files-1440-light.png) |
| Actual saved file and private upload, WebKit, phone/dark | [390×844](338-webkit-files-390-dark.png) |
| Native radio selection/focus, Chromium, desktop/dark | [1440×900](338-chromium-pivot-radio-1440-dark.png) |
| Native radio selection/focus, WebKit, phone/light | [390×844](338-webkit-pivot-radio-390-light.png) |
| Enlarged title, Chromium, desktop/light | [1440×900, 200% text](338-chromium-title-200-1440.png) |
| Enlarged title, WebKit, phone/light | [390×844, 200% text](338-webkit-title-200-390.png) |
| Original bounded pivot state, Chromium, desktop/light | [1500×900](bounded-details-pivot-desktop.png) |
| Original bounded pivot state, Chromium, phone/light | [412×915](bounded-details-pivot-phone.png) |

## Independent evaluation and limits

The independent technical evaluator read the exact parked/radio changes and
final run log, independently calculated contrast, and found no remaining defect
in those deltas. They did not rerun the Docker application and did not provide
an eligible GitHub approval. The [separate neutral visual review](visual-review.md) inspected all 50 final
captures at the same source and found no remaining material foundation issue.
It does not certify functional behavior or accessibility.

This evaluates shared palette/type/components. Final sidebar, header, page layout,
phone shell, panel and Kreska integration remain separate #336 children. Captures
are short-file samples and a sparse DM; long filenames/history and dark 200%
text are not demonstrated. Screenshots cannot certify interaction, permissions,
accessibility or full release readiness. Current-head checks, resolved review
threads and an eligible independent GitHub approval remain mandatory.
