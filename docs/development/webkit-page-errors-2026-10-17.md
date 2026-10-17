# WebKit lane: requests started while the page is left, and a focus move that took keystrokes

Recorded 2026-10-17 for #471 and #491. Author evidence from Docker runs in Playwright 1.62.0 WebKit
(26.5) and Chromium; raw logs and the temporary probes are in the author's evidence folder
`flux-evidence/471-491-webkit-lane/` (probes are not part of the repository). Independent evaluation is
still required.

## #471: what the "access control checks" page error is

- Playwright's WebKit driver raises every console message with level `error` and source `javascript` as a
  page error (`wkPage._onConsoleMessage`, `coreBundle.js` of 1.62.0). The text is WebKit's own
  `Fetch API cannot load <url> due to access control checks.`; the driver splits it at the first colon, which
  is why the page error starts with `/127.0.0.1:...`. The app handles the rejection (`api/client.ts` turns it
  into `NetworkError`), so the issue's suspicion of an unhandled rejection is not the cause.
- Plain page, no app (WebKit, two rounds each): a fetch that is **running** when the page navigates only
  fails with `Load request cancelled` and raises no page error. A fetch aborted by its own `AbortController`
  raises none, and neither does a real network failure while the page stays (`Load failed`, a console line
  without the `javascript` source). A fetch **started** in `pagehide` raises exactly the reported page error,
  in both rounds. Starting the fetch earlier and aborting it in `pagehide` or `beforeunload`, or sending it
  `keepalive`, also raised nothing.
- In the app (`DesktopScenarios.test_1`, requests and events traced per page error): `beforeunload` at -7 ms,
  the running `POST /return-points` of Home's continue card cancelled at -5 ms, its handler swallows the
  error and the chain's next step `GET /workspaces/<id>/work/assigned?limit=100&offset=0` starts at -1 ms,
  still in the beforeunload phase: that start is the page error. Every page-error failure of the listed
  journeys on main at `51b6920f` is this one: `test_app_shell` 12 and `DesktopScenarios.test_1`
  (`work/assigned`, three of three runs); `test_sketches` passed, and the earlier `assistant-runs`,
  `capabilities`, `dms`, `members` and `people` cases did not occur (#474 waits for them by caller).

Decision: the cause is any request that starts after the browser has begun leaving the page, so the
guard belongs in the one place every request goes through. `request()` waits while `pageLeaving()` and
starts when the page is live again (`pageIsLive`, a click or key press, `pageshow`, or the 1 s grace of a
cancelled navigation). #474 first tried a global flag that **rejected** such requests and stranded a view
opened after a dismissed leave prompt; this one **defers**, so that view loads at its first click, and an
aborted wait is an `AbortError` like the request's own. `keepalive` requests (sent on the way out on
purpose) do not wait. The page-error guards of the journeys are untouched.

Tests: `tests/app/api-client-page-leaving.test.ts` (9, 6 fail on main), `test_page_leaving.py`
(1: window events fired while leaving start no request; 2: negative control, a request the page starts
itself is still a page error in WebKit and none in Chromium, so the guard is live; 3: a real failed read
is shown and can be tried again). Residual: the grace of 1 s still lets a navigation that takes longer
than that release held requests; `composer/connection.ts` probes call `fetch` directly; a page that gets
`pagehide` and never `pageshow` waits for the first click or key press.

## #491: why the next Add kept the previous status

Probe (WebKit, 28 consecutive adds through the real form, clicks and events traced): the 9th add failed.
The fill's `focusin` on Email at +5 ms, then `focusout` Email and `focusin` on the roster heading at +7 ms
with no `input` event in between, the Add click at +61 ms submitted with an empty address
(`defaultPrevented`, no POST), the panel showed "Enter the email address of their Flux account.",
`.people__done` still named the previous person and the server's members lacked the address.
`WorkspacePeople.changed()` focuses the roster heading in `requestAnimationFrame` after every change,
adding someone included; Playwright's `fill` focuses the field and then inserts the text, and in WebKit the
frame fell between the two. Passing iterations showed the heading focused before every fill. The proposed
reset/revalidation race was not the cause.

Fix: only a closed member editor moves focus to the roster; adding someone leaves focus in the form, which
also lets a person add the next address without tabbing back. Tests: `test_people.PeopleFocus` (keyboard
typing straight after an add arrives complete; a role change still focuses the roster). Original
`DesktopScenarios` 1 and 2 are unchanged.

## Same family, found while verifying

- The Create window moves focus to a tab's text one frame after a pointer click; a `fill` into the first
  project's "Your space" in that frame landed in the other field (3 of 40 rounds in WebKit; the same symptom,
  a disabled "Create project", failed `test_app_shell` 14 once). `create_window.create_other` now waits two frames
  after the tab is selected (0 of 80 afterwards).
- `test_inbox_final` 07b dispatched a synthetic `pagehide` on a page it keeps using; it now also dispatches
  `pageshow`, the restore of a page from the back-forward cache.
- Not reproduced: `PhoneScenarios.test_1` `give_access` kept "Jonas can now write" instead of "Mia can now
  read" once in the first three WebKit module runs; 30 further traced attempts passed.
- Already failing on main, unrelated: `test_app_shell` 06 in WebKit (`focus ring` style `none`).
