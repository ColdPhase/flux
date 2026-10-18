# Normal production Docs and explicit-off UI — 2026-10-18

All four selected lanes pass, without diagnostic-mode API instrumentation. These
are author checks for whole-issue Draft #613 / #228, not independent acceptance,
latency evidence or permission to promote production.

| Actual source | API mode | Actual browser | Selection | Result |
| --- | --- | --- | --- | --- |
| `6ac818c6082ca7b035f07373bafb749f993ca19e` | production/on | Chromium | Docs | PASS 9/9, 19.566 s |
| `6ac818c6082ca7b035f07373bafb749f993ca19e` | production/on | WebKit | Docs | PASS 9/9, 27.402 s |
| `6ac818c6082ca7b035f07373bafb749f993ca19e` | production/off | Chromium | Docs + explicit-off | PASS 12/12, 20.463 s |
| `7cbdd7fd9d1007db65ea76144b4fcb1f71693481` | production/off | WebKit | Docs + explicit-off | PASS 12/12, 31.481 s |

Zero skips/failures/errors; all four runners exit 0. The 42 invocations overlap:
there are nine maintained Docs methods in every lane and three additional
explicit-off methods in each off lane. They are not 42 unique regressions.

Each clean detached source used its own disposable Compose project and
`FLUX_UI_PORT=18685 FLUX_UI_MAILPIT_PORT=18686`. For on lanes:

```sh
FLUX_LIVE_EDITING=on FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_docs
FLUX_LIVE_EDITING=on FLUX_UI_BROWSER=webkit ./scripts/check_ui.sh test_docs
```

For off lanes, use the corresponding browser with:

```sh
FLUX_LIVE_EDITING=off FLUX_UI_BROWSER=webkit \
  ./scripts/check_ui.sh test_docs test_live_editing_off
```

[Lane metadata](lanes.json) retains exact sources, selectors, commands, results
and original log/runtime hashes. Compressed runner logs preserve build/type/lint,
actual engine markers and test output. The four actual runtime JSON inventories
record the eight observed containers, real container/image IDs and allowlisted
configuration. In each inventory the API is actually running with
`NODE_ENV=production`, the declared `FLUX_LIVE_EDITING` mode, and neither the
old development availability flag nor telemetry enabled. The UI browser name is
checked in the actual browser, not inferred solely from an environment variable.
The normal runner also starts its existing worker and mock model-provider
services; these journeys use no external model charges.

The Docs journeys cover private/published boundaries, ordinary save, concurrent
version refusal, immutable history/diff, linked results, phone reading/editing,
sanitized Markdown and exact historical text. The explicit-off journeys require
no live UI flash or editing request, ordinary wiki behavior and immediate ordinary
map Undo. The off module now honors the selected browser; no earlier Chromium
run is relabeled WebKit.

The first three pins precede the map producer memo and presence subscription
isolation; their Docs source, dependencies, configuration and ordinary version
paths are unchanged. The final WebKit/off pin composes those map changes and both
cursor-test harness fixes. Preserve these pins and assess compatibility for later
changes; this report does not claim a newer source was executed.

[Cleanup](cleanup.json) verifies all four owned projects have zero containers,
volumes, networks and per-run image tags after terminal exit. The user demo and
Qwen were preserved. Full logs, normal-run screenshots and original inventories
remain outside Git under `/home/hubert/flux-evidence/228-docs-*`. Integrated live
IME/Copy/recovery/network/authority behavior, the original complete latency gate
and independent functional/visual acceptance remain separate required evidence.
