# Map presence isolation — author verification, 2026-10-18

Existing #228 / Draft PR #613. These are bounded author checks, not independent
review or a latency acceptance result. The remaining 200 ms criterion requires
its unchanged maintained measurement. No full nine-cohort run or new profile was
performed here. The original minimap is retained.

## Source and compatibility

The clean detached composed checkout started at
`4469b47ef87a36e73c4bad237b2e4c1b84426d2b`, containing the presence implementation
and the separately authored backend project/private memo. Runtime failures below
required only two corrections to this author's new lifecycle test:

- `d854f124`: await async Playwright `WebSocketRoute.close`, so the real connection
  actually closes. Composed tested source: `f25706c96d70591da7e0e114bb418d6da2744847`.
- `a9f9899a`: supply `{}` for the actual grant DELETE because the inherited fixture
  always sends JSON content type. Composed tested source:
  `6ef4c37bd86d09a020864a48c63ea3142213c141`.

`git diff --exit-code 4469b47e 6ef4c37b -- app/apps app/packages` is empty.
The coordinator's integrated `2f401ca3` also has identical application files to
`4469b47e`. Passing earlier application checks therefore remain applicable; the
corrected lifecycle method alone was rerun in Chromium. Clean verification tree:
`.worktrees/228-presence-check-4469b47e`. No product behavior, cadence, thresholds,
observer trace flags or geometry changed during verification.

## Actual results and retained failures

| Actual tested source | Selection | Terminal result |
| --- | --- | --- |
| `4469b47e` | Two selected store/projection unit files | PASS 7/7; zero skipped, cancelled or todo; build, type check and lint passed |
| `4469b47e` | Four Chromium methods below | FAIL 1/4, PASS 3/4, 34.006 s. Lifecycle called async close without await; disconnect did not execute. Render/native positive, 50/200-item drags, private cancel/own Undo passed. |
| `f25706c9` | Chromium lifecycle only | FAIL 1/1, 9.112 s. Room replacement, actual disconnect/reconnect and natural expiry passed; grant request returned 400 `FST_ERR_CTP_EMPTY_JSON_BODY` before revocation. |
| `6ef4c37b` | Four WebKit methods below | PASS 4/4, 45.983 s; actual engine logged WebKit |
| `6ef4c37b` | Corrected Chromium lifecycle only | PASS 1/1, 9.240 s; actual engine logged Chromium |
| `50e0520a` | One Chromium baseline render control | Expected FAIL 1/1, 2.696 s: old application editor render count 7 → 12 |

Both initial author harness FAILs remain FAIL in the artifact manifest; neither
establishes a product failure. No passing selector was repeated after the
one-line lifecycle corrections. Store units cover snapshot identity, immutable
previous snapshots, notification/unsubscribe, exact expiry boundary, idempotent
clear and separate account/room instances. Projection units cover actual
500-thought native identity, 200-item preview reuse, changed native bodies,
removals, expiry and separate editor caches.

The lifecycle browser test uses unchanged forwarding to the actual server, an
awaited real socket close, automatic reconnect, actual route replacement, sender
room disconnect/natural expiration, and an actual 204 project grant revocation.
No synthetic wire messages or fake clocks are used. Cursor and People leaves
clear in those cases; the existing two-way named/color/position/leave assertions
and no-uncaught-browser-errors assertion also pass.

## Observed render control

The public React DevTools observer compares committed host props rather than
fiber identity. Actual trusted pointer movement sends at least five fresh
authorized peer presence packets; the cursor's style must change each time.

| Engine/source | Presence-only editor / graph / thought-shell | Cursor paints | Native geometry/content positive control |
| --- | --- | --- | --- |
| Chromium `4469b47e` | 4 → 4 / 6 → 6 / 3 → 3 | 2 → 7 | editor 5, graph 7, shell 4; peer shows actual patched x and text |
| WebKit `6ef4c37b` | 4 → 4 / 5 → 5 / 3 → 3 | 5 → 11 | editor 5, graph 6, shell 4; peer shows actual patched x and text |

Both final logged controls report six received peer presence packets by the
native-positive log point. The assertions before the native edit require at
least five fresh packets and five cursor paints. The real native body/position
PATCH and visible peer assertions ensure the instrumentation does not merely
hide all geometry work.

The private negative-control checkout `50e0520aa8e94bc5b1bb765975bb35cbb5c1d9a1`
is the unchanged application at `6ac818c6082ca7b035f07373bafb749f993ca19e`
plus **only** `app/tests/ui/test_live_map_cursors.py`. Its exact overlay SHA-256
is recorded in [baseline-control.json](baseline-control.json); that file matches
the final positive test source. Application diff against 6ac is empty. Its
fresh-wire and cursor-paint assertions pass before the parent-render assertion
fails `12 != 7`. Thus the new control distinguishes the previous behavior using
real transport. The native-positive part is not reached in this expected failure.

## Commands and artifact binding

From the composed frozen checkout, the selected unit command was:

```sh
FLUX_TEST_PORT=18685 FLUX_TEST_MAILPIT_PORT=18686 ./scripts/check_application.sh \
  tests/app/live-map-presence.test.ts tests/app/live-map-projection.test.ts
```

The four browser selectors were, in this order:

```text
test_live_map_cursors.LiveCursors.test_map_shows_the_peers_named_cursor_and_who_is_here
test_live_map_cursors.LiveCursors.test_map_presence_clears_on_room_change_disconnect_expiry_and_revocation
test_live_map_selection.LiveMapSelectionJourney.test_selection_clicks_are_local_then_real_50_and_200_drags_share_and_commit
test_live_map_projection.LiveMapProjectionJourney.test_remote_changes_during_drag_private_cancel_and_independent_own_undo
```

They were passed to `./scripts/check_live_editing.sh` with
`FLUX_UI_BROWSER=chromium` or `webkit`, `FLUX_LIVE_EDITING_PORT=18685` and
`FLUX_LIVE_EDITING_MAILPIT_PORT=18686`. The two Chromium corrections selected
only the lifecycle method; the baseline selected only the first render method.
`FLUX_LIVE_EDITING_SHOTS` retained cursor screenshots for the initial Chromium,
failed lifecycle and final WebKit runs. No screenshot setting changed a latency
measurement; none ran here.

[attempts.json](attempts.json) pins every source, exit result, absolute raw log
path, log hash, actual runtime inventory and retained screenshot hashes. The six
runtime JSON files were captured from **actual containers before project
cleanup**, recording actual container IDs and immutable image IDs (not merely
tag names). All inventories have running API/DB services (the unit run also has
a running test service). The final WebKit, final Chromium lifecycle and failed
`f25706c9` lifecycle inventories caught the actual ui-test container's terminal
state between `docker ps` selection and `inspect`; those records preserve that
state rather than claiming every captured producer was still running. The
project names bind them to the corresponding log. No environment, cookie or auth
state was retained. Raw logs and PNGs
stay outside Git under `/home/hubert/flux-evidence/228-presence-*`.

[cleanup.json](cleanup.json) records the post-terminal inspection of all six
owned Compose projects: zero containers, volumes, networks and per-run image
tags. The sole heavy slot was released to the coordinator immediately afterwards
at 12:11 UTC, before this docs-only receipt was written. User demo and Qwen
services were not altered. No further Docker run belongs to this receipt.
