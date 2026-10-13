# Wiki evidence — PR #374 / issue #354

Pinned application source: `2dcf15056b9f02c592a431e642b6f47febd0946c`, branch `claude-hubert/354-wiki`, normally composed with `main` at `3163f2e2192987c7dfc40a4535adbdbc6b1c8f45`. This evidence branch is docs-only, based directly on that source commit; it is not a new PR or an issue-completion claim.

## Current visual and interaction result

The independent review passes the scoped Wiki content, page strip, project view menu, empty state, and Page actions. The earlier cutoff concern is withdrawn: the initial Page actions state can scroll, its Details row becomes fully visible and tappable, and that tap opens Details. See the [independent visual report](independent-visual-review.md), [neutral brief](neutral-brief.md), [before](wiki-phone-390-page-actions-light.webp) and [after](wiki-phone-390-page-actions-scrolled.webp) images, [raw probe metrics](scroll-probe-metrics.json), and [probe source](scroll-probe.py). The probe SHA-256 is `beceaea87cbbca9bf4dcde0abd8e3495918890f9f90a6ac4e857a23bfbf96004`.

In the probe, the popup moved from `scrollTop=0` to `24` (`scrollHeight=724`, `clientHeight=700`). Its bounds were y=60..760. After scrolling, Details was y=694.3..754.5, bottom navigation began at y=778.2, and the viewport height was 844. The row had no nav overlap, its center hit-test targeted Details, and the touch tap opened the Details dialog. The probe used Playwright WebKit with a 390×844 CSS viewport, device scale 2, `has_touch=True`, coarse-pointer and no-hover media features. Playwright raised “Mouse wheel is not supported in mobile WebKit” with `is_mobile=True`, so the final run used `is_mobile=False`; `navigator.maxTouchPoints` reported 0. This is scoped reachability evidence, not full mobile WebKit emulation. The initial failed harness run ended before any product measurements and is not counted as a product failure.

The phone bar/header mismatch in the #374 captures remains an **upstream shell integration dependency** assigned to #341 / PR #414. The visual report records that limitation; these captures predate the integrated #414 shell. No full integrated-shell pass is claimed.

## Captured images

All seven original visual-review captures and the follow-up scrolled capture are 780×1688 pixels (390×844 CSS px at 2×). They are stored as lossless WebP; `manifest.json` records each source PNG hash, output WebP hash, byte size, and pixel-identity check.

| State | Image |
| --- | --- |
| Populated Wiki, light | [Light Wiki](wiki-final-phone-390-light.webp) |
| Populated Wiki, dark | [Dark Wiki](wiki-final-phone-390-dark.webp) |
| Project view menu | [View menu](wiki-phone-390-view-menu.webp) |
| Page actions initial, light | [Page actions light](wiki-phone-390-page-actions-light.webp) |
| Page actions initial, dark | [Page actions dark](wiki-phone-390-page-actions-dark.webp) |
| Empty Wiki, light | [Empty light](wiki-phone-390-empty-light.webp) |
| Empty Wiki, dark | [Empty dark](wiki-phone-390-empty-dark.webp) |
| Page actions after natural wheel scroll | [Details fully visible](wiki-phone-390-page-actions-scrolled.webp) |

## Verification at the pinned source

- WebKit `WikiFinal.test_phone_has_no_other_toolbars` and `WikiFinal.test_phone_title_chips_and_edit`: **2 passed**.
- WebKit `PhoneScenarios`: **8 passed, 1 expected failure, 0 skipped**. `PhoneScenarios.test_6_export_and_audience` passed. A prior isolated selector skipped because its preceding scenario state was absent; it is not counted.
- The ephemeral visual-capture harness: **1 passed**; the separate scroll-reachability probe: **1 passed**. Both temporary test modules were removed after their runs.
- Docker build, TypeScript typecheck and lint completed; lint reported 0 errors and 3 existing hook warnings (`drafts.ts`, `DocEditor.tsx`, `createdDraft.ts`). The isolated Compose project was removed; post-run checks found no containers, volumes or networks.
- On the predecessor source `7e2d8cb8d09f739584430c1defeb0d5f01ba66e4`, the earlier Chromium result was **50 passed, 1 skipped, 1 expected failure**. The normal merge from `main` adds seven files, all unrelated to Wiki; a scoped diff confirms Wiki source and the two Wiki test files are byte-identical between `7e2d8cb` and `2dcf150`. The earlier Chromium result is compatible evidence, not a new run at `2dcf150`.
- Exact-head required checks on PR #374 passed: [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38446661156) and [Application validation](https://github.com/ColdPhase/flux/actions/runs/38446660989). Base was `main` at `3163f2e2192987c7dfc40a4535adbdbc6b1c8f45`.

Issue #354 remains open with its complete AC-1–5. This packet does not certify native WebKit clipboard, real agent-authored Wiki writes, integrated #341/#414 phone shell, full PWA behavior, or release acceptance. No formal GitHub approval or merge is claimed; a fresh eligible exact-head review is the next gate.
