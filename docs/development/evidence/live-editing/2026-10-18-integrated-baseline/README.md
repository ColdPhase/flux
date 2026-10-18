# Integrated live-editing baseline, 2026-10-18

Historical author verification at clean source
`1b49737901f475a9b810a1660ba0e4bc6dac3ecc`, before the whole-issue production
promotion and the next application performance change. It does not accept #228
or enable production. The same five maintained modules ran in each engine:
`test_live_editing`, `test_live_map_projection`, `test_live_map_selection`,
`test_live_map_cursors`, `test_live_map_lease_expiry`.

| Actual engine | Methods | Passed | Errors | Skips | Time | Runner exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 31 | 31 | 0 | 0 | 130.088s | 0 |
| WebKit | 31 | 29 | 2 | 0 | 156.761s | 1 |

Each engine printed 30 actual browser-engine markers; the other method checks
the real TCP forwarder's small-frame delivery. No functional assertion failed.
The WebKit run is nevertheless **FAIL**, with two required paths unverified:

- `test_11_quota_and_concurrent_own_undo_keep_100k_body`: the observer requests
  Chromium's unsupported `clipboard-write` permission before reaching the quota
  assertions. This is not a passing 100k/undo check for WebKit.
- `test_14_ime_composition_shares_the_committed_text_once`: creating a CDP session
  fails on WebKit before any composition. This is not IME coverage for WebKit.
  Playwright documents [CDP as Chromium-only](https://playwright.dev/python/docs/api/class-browsercontext#browser-context-new-cdp-session);
  the pinned [WebKit permission implementation](https://github.com/microsoft/playwright/blob/v1.62.0/packages/playwright-core/src/server/webkit/wkPage.ts)
  supports `clipboard-read`, not `clipboard-write`.

[Results and exact commands](results.json), [source-input hashes](source-inputs.json),
[Chromium log](chromium.log.gz), [WebKit log](webkit.log.gz) and
[retained manifest](manifest.json) keep the original source and observed failures.
No input, transport or editor was mocked to make this run pass. The later native
copy/paste observer repair and a supported native WebKit composition path require
new checks; they cannot retroactively change these outcomes.

No actual container/image inventory was captured before cleanup. The later empty
inspection is not runtime binding and is deliberately excluded. Source pins,
original logs and engine observations are retained without claiming the missing
inventory. [Cleanup](cleanup.json) confirms no containers, volumes or networks
remain for either owned Compose project; each runner removed its two images.
User demo and Qwen services were preserved. Original logs and cursor screenshots
remain under `/home/hubert/flux-evidence/228-integrated-1b497379-*`.

The passing [earlier controls and failed canonical timing](../2026-10-18-map-identity-method/README.md)
retain their own source pins. This baseline is not the final production candidate,
Gate 4 latency proof, neutral visual review, or independent functional acceptance.
All original AC-1–AC-5 and Gate-1–Gate-4 requirements remain in the same issue/PR.
