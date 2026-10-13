# #417 exact-head implementation and verification evidence

This docs-only evidence packet is pinned to source `dd01f6f667ca9d4253f36f5eedf46cb135bd54ee`, based on `main` `fe4e08f0d6ece3e3b2f6ec5482e7826ab2bfec0b`. PR #417 merged as `943ef7cef268527799116026c805138ee4f78563` on 2026-10-13. Issue #347 remains open and partial.

## Evidence

- `browser-results.md` records exact commands, current-head results, cleanup and CI.
- `chromium.log` and `webkit.log` are the persisted Docker test logs for the exact dd01 head.
- `screens/` contains 36 lossless WebP copies of the 18 Chromium and 18 WebKit PNG captures. Each conversion was compared to its source PNG; absolute pixel error was zero.
- `neutral-brief.md` is the review prompt; `independent-visual-review.md` preserves the fresh visual review unchanged.
- `scope-audit.md` records why the phone-shell finding is inherited from `main` and belongs to #341/#414; it does not change the visual review's finding or claim an integrated phone-shell pass.
- `api-provenance.md` records the focused API result and its limitation: the command output showed 10/10 pass, but no output log was saved.
- `api-focused-runner.sh` is the focused runner script used for the API test at the earlier source pin.
- `manifest.json` includes the source/base/merge pins, test and check metadata, screenshot hashes and dimensions.

Canonical UI references are F-026 in `docs/design/final/README.md`; in particular `screens/phone-thread.webp`, `screens/phone-agents.webp`, and `screens/phone-handoff.webp`.
