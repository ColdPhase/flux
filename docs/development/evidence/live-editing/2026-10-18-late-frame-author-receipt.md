# Late-frame author validation receipt

This is an author-side validation receipt for the bounded #228 AC-3 late-frame
change. It is not an independent review or complete AC-3 acceptance.

The reviewed source bytes were committed as `cd333518320c4da53f0d8ea1877553ba25265c0b`
(tree `3299a2b0f74ad4736e55baa8fe1f71f7038ebdd6`). The corrected Chromium run
started before that commit while the worktree was clean of concurrent edits;
the source and test bytes were subsequently committed unchanged. The WebKit
and targeted app-test commands ran after the commit. The root later reported
integrating the code chain at `c66eefc7`; this receipt does not assert that
commit was the image input for these runs.

The exact successful commands were:

```sh
FLUX_LIVE_EDITING=on FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_live_map_delivery_order
FLUX_LIVE_EDITING=on FLUX_UI_BROWSER=webkit ./scripts/check_ui.sh test_live_map_delivery_order test_live_map_projection test_live_map_lease_expiry
./scripts/check_application.sh tests/app/live-map-presence.test.ts
```

The corrected Chromium delivery test passed 1/1 (15.287 seconds). WebKit ran
the delivery test, four projection cases, and lease-expiry case: 6/6 passed
(41.821 seconds). The focused presence unit test passed 3/3. The UI runner's
build, typecheck, and lint passed; lint reported nine existing warnings and no
errors. Actual browser engine names were printed by the runner as Chromium and
WebKit.

Two earlier Chromium attempts failed before the map-delivery assertions
because the test harness's `newer`/`cleared`/`expired` frame branches had been
indented after an unconditional return in the presence branch. The first
command was `FLUX_LIVE_EDITING=on FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_live_map_delivery_order test_live_map_projection test_live_map_lease_expiry`;
only delivery-order failed, while all four projection cases and lease-expiry
passed. The second command was
`FLUX_LIVE_EDITING=on FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_live_map_delivery_order`;
it reproduced the harness failure and confirmed the route saw map frames. A
third invocation of that focused command was interrupted during build, before
tests ran. The interruption cleanup emitted a duplicate cleanup `chmod`
message; a post-cleanup inventory showed no containers or volumes for that
interrupted Compose project. After correcting the indentation, the focused
Chromium delivery test passed.

Compose project names visible in runner output were `flux-ui-1792338494-1973124`
(Chromium), `flux-ui-1792338721-1984064` (WebKit), and
`flux-test-1792338808-1992658` (targeted app test). The run scripts completed
cleanup, and post-cleanup container inventories for those projects were empty.
Container IDs, pre-teardown image inventories, network inventories, and raw
log file paths/hashes were not captured; they remain unverified. The runner
output was not persisted as an external raw log. Do not infer image or
container provenance from the project names alone.

The three successful commands above used the committed source bytes listed at
the top. No claim is made here about unrelated test suites, other browsers,
or the complete #228 acceptance contract.
