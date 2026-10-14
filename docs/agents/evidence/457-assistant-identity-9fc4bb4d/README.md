# PR #457 assistant join evidence — composition 9fc4bb4d

This packet records evidence for source commit `9fc4bb4d3b7310b7b8745f8de81cc2047268f54f`, composed with main `a77a8b563d86a4b53e1ec3f99bde9d7b493a588a`. It does not modify the PR source tree.

- `browser-results.md`: exact focused browser and API outcomes and capture inventory.
- `logs/compose-e2e-and-build.log`: Sol-run canonical Compose build, typecheck, lint, Chromium/WebKit E2E, and cleanup output.
- `logs/api-review.log`: independent focused API test and cleanup output.
- `join-*-manifest.json` and PNGs: screenshots from the E2E journey, generated metadata only.
- `neutral-visual-brief.md`: appearance-only brief for a separate visual evaluator.
- `SHA256SUMS`: hashes for every file in this packet except this checksum file itself.

The E2E fixtures use separate data per engine. The generated agent UUIDs were not emitted by the maintained runner; do not infer cross-engine identity from screenshots. Device scale factor was not explicitly set. API/browser outcomes establish the checks listed in `browser-results.md`; screenshots alone do not establish behavior or accessibility.
