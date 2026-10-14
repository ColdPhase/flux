# PR #457 assistant join evidence — exact head b6451de1

This docs-only packet records evidence for source commit `b6451de1eeb2362a7be3efdb3bec5e083cad2ba9`, whose parent is composition `9fc4bb4d3b7310b7b8745f8de81cc2047268f54f` on main `a77a8b563d86a4b53e1ec3f99bde9d7b493a588a`. It does not modify PR source.

- `browser-results.md` records exact-head checks, behavior tests and independent visual result.
- `logs/full-focused-run.log` is the complete Docker build/typecheck/lint, Chromium/WebKit UI selection, assistant-join E2E and cleanup transcript.
- `logs/focused-run.sh` records the test runner and exact source guard.
- `e2e/` contains the 16 exact-head E2E PNG captures, two engine manifests and the independent visual review.
- `neutral-visual-brief.md` is the appearance-only task brief supplied to the fresh evaluator.
- `SHA256SUMS` hashes every packet file other than itself.

Each browser engine creates an independent fixture and generated agent UUIDs were not emitted by the maintained runner. Do not treat Chromium and WebKit captures as one persistent agent identity. Device scale factor was not explicitly set. Screenshots establish appearance only; UI/API behavior is established by the listed test output.
