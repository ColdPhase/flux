# #725, #726, #727: phone stream band, readable map opening, short-window rail (2026-10-30)

Branch `claude-hubert/725-727-layout`, stacked on `claude-hubert/151-finish` (PR #728). Docker, `scripts/check_ui.sh`, ports
33000/33001; emulated viewports in headless Chromium and Playwright WebKit, not devices. Rules recorded in
[adaptive layout rules](../../../design/adaptive-layout-rules.md).

| Issue | Change | Test (`test_adaptive_matrix.AdaptiveReflow`) | Measured |
| --- | --- | --- | --- |
| #725 | The opening "whole messages" room is at most 48 px (`WHOLE_MESSAGE_ROOM`); past that the newest message stays against the field and the top one is cut | `test_23` | Newest message to field, CSS px (added room): 320×568 41 (0), 360×640 40 (0), 390×844 40 (0), 820×1180 48 (0), 1440×900 98 (48), the same ±1 in WebKit. Before: 137.6 and 146.6 px of added room on the phones |
| #726 | The map opens at the largest zoom that fits, never below 90% (`OPEN_MIN`); the Fit button keeps its 60% / 75% overview floor | `test_24` | Titles ≥ 12 px and meta ≥ 10 px on opening at 1280×800, 1440×900, 820×1180; first thought in view; Fit then zooms out. 1440×900 opens at 90% (was 60%: 8 and 7 px) |
| #727 | On windows ≤ 480 px tall the rail's places, projects and messages scroll as one band; toggle, New, Stop and the account stay outside it | `test_25` | 844×390 and 900×400: six projects each reachable and unclipped, the controls inside the window and unmoved by scrolling or choosing a project |

Shots (Chromium, DPR 1): [conversation 320×568](conversation-320x568-light.webp), [conversation 390×844](conversation-390x844-light.webp),
[map 1440×900](map-1440x900-light.webp), [rail 844×390](rail-short-844x390.webp) and [scrolled](rail-short-844x390-scrolled.webp).
Looked at by the author, not an independent visual review. The phone stream now starts with the top message cut under the
header; the rail at 844×390 shows only the places until the band is scrolled.
