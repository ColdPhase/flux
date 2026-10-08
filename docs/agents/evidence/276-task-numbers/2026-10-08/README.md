# Task numbers and current Details composition — 2026-10-08

Part of #276 / PR #282, under #336 / F-026. Tested candidate `16010f17aabc2b81640bf36b396254e88f140ac4` contains the accepted main composition `0f68aa963be920fbc7ebf30742da4aef54fe34be`. Production is byte-equivalent to `6f962f6335cc7c560609a0c99c8309e1e83bf925`; the later changes are two maintained browser-test files. This evidence checkpoint adds documentation only. Original worktrees and earlier evidence are preserved.

The six accepted numbering criteria pass in the [independent final review](independent-final-review.md): per-project first number, 20 concurrent creations, ordered migration backfill and immutable identity, permission-filtered exact lookup, additive MCP outputs, and visible desktop/phone task numbers. Details also preserves real loading/error/retry and later-page Previous/Refresh while omitting the complete first empty relation page. [Bounded visual review](bounded-details-visual-review.md) assessed the matching production screenshots; it does not certify all final layouts.

| Actual source and command scope | Result |
| --- | --- |
| Unchanged production `6f962f6`: isolated Docker API/SQL/Search/MCP/export/native/architecture selection | 127/127 pass, 12 suites, 36.054s |
| Current `16010f1`: six maintained UI modules using exact 6f production images and two readonly current test overlays | 71/71 pass, 192.679s, exit 0 |
| Earlier test-only `ed247ab`: same production, six UI modules | 70/71, exit 1; Search Cancel measured 43.999996185302734 px |

The current Cancel guard still requires computed minimum height 44px and rejects a 43.999px box; its 0.0001px measurement tolerance covers that floating-point drift. The original option-target checks remain. Failed evidence is retained and not renamed a pass.

The same-symptom map camera failure was reproduced on current production and traced to Playwright scrolling before pointer input during naturally running entry motion: default locator tap shifted 6/6 contexts; public `scroll="none"` and an uncovered touchscreen tap shifted 0/6 each. See the [causal review](camera-causal-review.md), [18-context summary](camera-arrival-summary.json), and [losslessly compressed observations](camera-actionability.json.gz). The maintained test retains deliberate visibility scrolling, normal actionability and uncovered-center checks, adds equality at opening, and keeps Close/focus/keyboard/selection guards. No production camera fix or retroactive explanation of an untraced historical failure is claimed.

The 18-context summary is the main camera record. The full raw camera observations are stored as deterministic gzip; decompressing them returns exactly the original 1,438,417 bytes (SHA-256 `d653dd39d41ac85a65ef9e62213384cfb3b239f6ef998e36681f07b5f85bf2dd`). This storage-only update does not relabel the earlier runtime evidence.

The attached PNGs and JSON retain their original capture bytes. [Manifest](manifest.json) records exact bytes, dimensions, source pins, test blobs and original log hashes. Full raw logs and the remaining original images are retained in the local independent archive `/home/hubert/.codex/review-evidence/flux/276/2026-10-08-16010f17/` rather than publishing fixture credentials.

Whole #276 remains open. General re-import is unsupported (`reimportSupported:false`); the proposal to keep/reassign imported numbers is not implemented. Complete final Search and composer/reference layouts, including number-specific Mono presentation in Search/Jump to snippets, remain required under #345/#343/#348. Current generic Search text is not presented as full F-026 acceptance. No fresh full application command, dump/restore, external MCP client, release acceptance or eligible GitHub approval is claimed. Publish this bounded slice, obtain current required checks and independent Code Owner approval, then merge normally.
