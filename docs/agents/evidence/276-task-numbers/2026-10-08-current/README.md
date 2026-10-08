# Current task numbering composition — 2026-10-08

Part of #276 / PR #282, under #336 / F-026. Current tested source is `1b7c3c03690b4fe4027001b38f7facb69e3c0c63`, composed with protected main `94e708cdcdc8607e004d37846165cd6ec6479211`. This publication changes documentation only. The [earlier numbering/camera evidence](../2026-10-08/README.md) remains unchanged, with its original source pins.

Task numbers and immutable native destinations now coexist with the accepted full author column: actual avatar, full human or agent identity, owner and time. At narrow relative container widths, enlarged titles use their full height and the timestamp moves to its own line. The original exact metadata-row, 32px author-face, shared column and gap checks remain unchanged. No global font reduction or browser-zoom change was introduced.

| Actual source and configured scope | Actual result |
| --- | --- |
| `892f1cf5`: `check_ui.sh test_work_details`, three consecutive isolated runs | 12/12 each, 28.774s / 28.581s / 28.894s, each child exit 0 |
| `892f1cf5`: maintained Map-count/Search/Task-announcement/Tasks-board/Work-decisions modules | 59/59, 147.966s, child exit 0 |
| `892f1cf5`: bounded Docker API/SQL selection, 18 files | 155/155, 12 suites, 64.258765847s, child exit 0 |
| `1b7c3c03`: `./scripts/check_ui.sh test_task_announcements` | 17/17, 57.298s, exit 0; package build, TypeScript and lint included |

[892 completion metadata](892-check-summary.json) preserves the wrapper's later **143** exit, whose cause is unverified, separately from the five completed child phases and zero-resource audit. These remain 892 executions: only notice CSS and its browser module subsequently changed. DB/core/server/worker, all app tests, Details and the other four UI modules are byte-identical, as checked by the [independent current source review](independent-current-source-review.md). No fresh full-application run is inferred.

[Negative controls and log hashes](control-summary.json) retain actual failures. The title-negative e81 had four genuine clipping failures. The spacing-negative003a had four timestamp-line failures; its number Range rule already passed and does not reproduce painted digit overlap. The attempted d957 repair still failed four unchanged exact-row guards. Current1b7 repairs that layout rather than weakening the author helper. The entire 17-method module is not claimed to run in both engines; its phone cohort runs Chromium and WebKit.

The current phone cohort checks 320/light and390/dark at default and root200% text, with DPR3 and default browser zoom100%. Full title dimensions equal scroll dimensions, time lies8.75px below the author, actual touch opens the expected native Details, full API task projections remain equal and task/notice/root counts do not change. [Chromium measurements](enlarged-reflow-chromium.json) and [WebKit measurements](enlarged-reflow-webkit.json) are unchanged captured JSON. The Range rule uses the first text fragment; it is not proof of every digit's complete painted bounds, arbitrary long names, OS text scaling or browser zoom.

The [fresh neutral visual review](independent-current-visual-review.md) finds full authors, task numbers/titles, entry affordances and shared author alignment readable. It also records **two material outstanding F-026 gaps**: source-aware P5 task-event composition and surrounding phone navigation/composer density. Those remain required under #343 / #341, with the state-change record at https://github.com/ColdPhase/flux/issues/343#issuecomment-6051786889. This is bounded numbering/reflow evidence, not approval of the complete conversation design. Agent/multiple-task/long-name states and full light/dark combinations still need the relevant broader review. Functional assertions do not replace that visual work.

| Unmodified current image | CSS viewport / engine / theme / text |
| --- | --- |
| [Desktop](task-announcements-desktop.png) | 1440×900 / Chromium / light / default |
| [Phone320](task-announcements-phone-320.png) | 320×640 / Chromium / light / default |
| [Phone320 WebKit](task-announcements-phone-320-webkit.png) | 320×640 / WebKit / light / default |
| [Phone320 text200](task-announcements-phone-320-text200.png) | 320×640 / Chromium / light / root200% |
| [Phone320 text200 WebKit](task-announcements-phone-320-text200-webkit.png) | 320×640 / WebKit / light / root200% |
| [Phone390 dark](task-announcements-phone-390-dark.png) | 390×844 / Chromium / dark / default |
| [Phone390 dark WebKit](task-announcements-phone-390-dark-webkit.png) | 390×844 / WebKit / dark / default |
| [Phone390 dark text200](task-announcements-phone-390-dark-text200.png) | 390×844 / Chromium / dark / root200% |
| [Phone390 dark text200 WebKit](task-announcements-phone-390-dark-text200-webkit.png) | 390×844 / WebKit / dark / root200% |

[Capture metadata](capture-metadata.json) and [manifest](manifest.json) provide exact pins, hashes, original bytes and raster dimensions. Each portable independent report links its byte-identical original `.txt`; only local link destinations and Compose-ID references are adapted for publication. Original SHA-256 hashes remain recorded. The portable images/measurements are linked above. Full logs and original controls are retained privately in `/home/hubert/.codex/review-evidence/flux/276/2026-10-08-1b7c3c03/`, preserving synthetic fixture credentials outside the repository. Current and both control cleanup files record zero owned containers, volumes, networks and image tags. Shared services and original dirty worktrees were preserved.

Parent #276 remains open. Re-import is unsupported (`reimportSupported:false`); final Search/reference/composer placement remains under #345/#343/#348. Whole F-026, full application, dump/restore, external MCP-client and release acceptance are not established here. Normal current required checks, resolved review threads and eligible independent Code Owner approval remain merge gates. No auto-closure or bypass is requested.
