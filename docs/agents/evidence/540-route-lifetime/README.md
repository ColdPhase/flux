# Paused association recovery: lost shell-loader request (#540)

Investigated 2026-10-16 on PR #528. The interception repair changes the test
fixture, not the product's association retirement or router/session guards.
Required WebKit verification additionally exposed interrupted native scrolling;
that separate product repair is described below.

## Actual application failure

The original full UI failure at `16f7866` stopped at test06's existing ten-second
`ready` assertion: the thread remained `loading`. An earlier diagnostic at
`2ab3d31` reproduced it but did not record the following workspace request.
Passing later captures and isolated native-fetch controls did not resolve that
gap and are not evidence of a repair.

The [captured failing control](capture.json), at product head
`3d110cef190581f0cb928fe72b501d76c681a8d3`, closes the gap. Only the test was
instrumented, using the exact [capture patch](capture.patch); original route
release/removal order and assertions were preserved. The first repetition failed
(1 test, 16.091 seconds, EXIT 1):

- The released `/me` returned 200; its 317-byte body was consumed and contained
  a user/session. Native loadingFinished and Playwright requestfinished occurred.
- At the same browser timestamp, the application invoked `/api/v1/workspaces`
  with `signal.aborted === false`. Chromium emitted requestWillBeSent `82.158`.
- No native completion/failure followed for that request. The API received no
  `/workspaces` after the final `/me` throughout the failure window. Both fixture
  held-response arrays were empty; the pane remained `loading`.

This is a dispatched shell-loader request lost before API arrival, not a missing
association-fetch invocation or an unconsumed `/me` body. The shell loader awaits
workspaces before completing revalidation; association reads deliberately remain
paused until revalidation is idle. A separate genuine held-workspaces control
established that gate and resumed the original ready/work-chip assertions when
the real response was released.

The capture did not listen to Network.responseReceived for `/workspaces`; it does
not separately establish absence of that event. It also did not record the exact
Fetch.disable protocol timestamp. Raw capture, server correlation, original
source patches and terminal logs remain under `/home/hubert/flux-evidence/540/`;
`capture.json` pins the source/log hashes.

## Browser mechanism and bounded repair

The pinned Playwright 1.62.0 image uses Chromium 151.0.7922.34. Removing the last
route disables request interception. Playwright's
[upstream investigation](https://github.com/microsoft/playwright/issues/41802)
identifies a Chromium Fetch.disable race with a new request: requestWillBeSent
occurs, followed by no terminal event. The
[upstream regression was enabled for Chromium 155 and later](https://github.com/microsoft/playwright/commit/28b4e74e6d4c82dc2ab9ddf6f316c390ac5a7dc5)
on 2026-09-25. The exact internal Fetch.disable attribution here is supported by
that vendor evidence and the fixture boundary, rather than a captured protocol
command; the actual application's lost workspace request is directly observed.

Test06 now retains the `/me` route until its existing context cleanup. Before
releasing the genuine held response, it switches the handler to normal forwarding.
Removing the association route still leaves interception active. No response is
invented, no sleep or timeout is added, and every paused-revalidation, ABA,
fresh-association and first-work assertion is retained. The module honors
`FLUX_UI_BROWSER` so this same scenario and its surrounding journeys run in
Chromium and WebKit.

## Verification

The positive control uses the same capture source and original assertions with
only the bounded route-lifetime repair: **30 tests passed in 53.224 seconds,
EXIT 0**, with all 30 final workspace requests completed and panes ready. The
complete uninstrumented Chromium/WebKit module results are recorded in the pinned
PR handoff. The captured
negative control demonstrates an intermittent race; its failure is not claimed
as deterministic on every invocation. The genuine held-workspaces experiment is
the deterministic loader-gate control, not a substitute for the observed failure.

To repeat the old-source capture in an isolated checkout at `3d110cef`, apply
`capture.patch` and run through Docker:

```sh
FLUX_UI_PORT=26102 FLUX_UI_MAILPIT_PORT=26103 ./scripts/check_ui.sh \
  test_work_associations.MessageWorkJourney.test_06_paused_router_revalidation_retires_viewport_selector_aba
```

Full UI and final application checks remain separate PR gates. These targeted
observations do not imply that either full suite passed.

## WebKit: a separate active-scroll interruption

The complete module at `3289adbd` passed Chromium (8 tests, 21.929 seconds,
EXIT 0), but WebKit failed (8 tests, 57.170 seconds, EXIT 1): phone screenshot
positioning invoked an unsupported mouse-wheel API; test06 stopped before its
final-message viewport condition; test08's single PageDown stopped at the held
batch. Those failures are not hidden by the interception repair.

Actual-app scroll/offset tracing showed native movement before both desktop
failures. At the loading transition the old association content collapsed by
76 pixels; the native offset changed and the animation stopped. There were no
application scrollTop writes during either gesture. The initial native-div
capture in that same diagnostic produced no events and is not a valid baseline.

The separate [neutral WebKit control](native-scroll.py), with no Flux scripts,
records [these comparisons](native-scroll.json):

| Native gesture | Stable content, auto | Remove 76px, auto | Remove 76px, none |
| --- | ---: | ---: | ---: |
| One PageDown from 9760 | 10233 | 9828 (stopped) | 10233 |
| One wheel from 255 | 19485 (end) | 10735 (stopped) | 19409 (new end) |

Both stable-content `none` controls also complete. The neutral diagnostic exits
0 to report all comparisons; it is separate from application acceptance. Run it
in the same pinned UI-test Docker image, mounting `native-scroll.py` read-only,
as for the adjacent interception probe. No sleeps, changed animation preferences
or application event handlers are used.

The [independently accepted repair contract](../../../development/thread-reading-position-2026-10-16.md)
keeps the original single native wheel/PageDown assertions in both engines,
disables competing automatic anchoring only on the thread feed, and requires its
existing reading-position owner to protect settled loading anchors and end
following. New actual-app controls cover a settled reader whose viewport resize
retires the batch under a held real read, both after a finished wheel and after
non-scrolling pointer/focus input, plus end-follow/leave-end on viewport changes.
The existing owner distinguishes observed scroll motion from input alone and
returns ownership to settled-anchor restoration on native `scrollend`. The phone-only screenshot positioning uses native scroll-into-view;
it does not replace either tested gesture. Final-head results belong in the PR
handoff; the failed historical WebKit run remains failed.

The independent source review identified a second settled-reader boundary:
pointer/focus input could leave `readerMoved` true without any subsequent scroll
or `scrollend`. The actual-app negative control verifies those input events, zero
scroll/end events, a real held changed selector and retiring content; it fails
the unchanged anchor assertion by **76 pixels** (1 test, 9.555 seconds, EXIT 1).
The owner now marks motion when it observes a reader scroll (including a pending
scroll detected before its event), rather than on every input. Test11 keeps this
regression alongside the wheel-ended control. Two earlier attempts never reached
the held transition because they captured the initial 51-ID window before the
older-message seek; they are setup failures, not anchor evidence. New controls
explicitly await the older 100-ID request before selecting the resize boundary.
