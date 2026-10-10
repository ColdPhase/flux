# Mobile and tablet PWA

**Accepted founder requirement, 27 September 2026 (F-010).** Flux must be a
first-class mobile workspace as well as a desktop application. Android phones
and tablets, iPhones and iPads are required product targets. Users must be able
to install Flux as a PWA, launch it from their home screen, collaborate comfortably
with touch, and receive authorized Web Push notifications. This is part of the
complete application release; agents choose and review the implementation without
waiting for founder approval.

**Founder direction [#266](https://github.com/ColdPhase/flux/issues/266) item 10,
2026-10-05:** "we do not need a real iPhone etc." The product requirement above is
unchanged; only its evidence changes. MOB acceptance uses browser emulation in
Docker plus documented platform requirements from dated primary sources (see
[Acceptance evidence](#acceptance-evidence)). Physical Android, iPhone and iPad
sessions are optional extra evidence and never a release gate. No Android
Emulator or iOS Simulator is needed either (#266 item 6).

This supplements the original [foundation](FLUX-FOUNDATION.md), especially areas
8.1–8.16 and the design/attention principles. Preserve that original document.
Include mobile use in persona journeys, architecture, design proposals, the
coverage matrix, task contracts and final integrated verification from the start.

The later [F-015 adaptive-workspace contract](../design/adaptive-workspaces.md)
extends this to a continuous small-phone → tablet → desktop → 4K/ultrawide
experience. ADAPT-1–ADAPT-5 and [#151](https://github.com/ColdPhase/flux/issues/151)
add useful wide-screen capacity and cross-layout continuity without reducing any
MOB criterion. The final design (#336) owns integrated UX; #20 remains responsible for mobile
installation, interaction and notification evidence.

## Required outcomes

| ID | User-visible outcome | Acceptance evidence |
| --- | --- | --- |
| MOB-1 | Install and launch Flux on Android, iPhone and iPad; recognizable icon/name, standalone window, stable identity and deep links | Manifest, icons and service worker meet each platform's documented install requirements; in emulation, the standalone display mode, cold launch, login/session recovery and reopening the correct project from a link |
| MOB-2 | Productive layouts on phones and tablets, in portrait, landscape and tablet split view | Real content and all key journeys at emulated phone/tablet viewports. Includes a simulated on-screen keyboard: the viewport shrinks by about 40–50% while a field has focus, and the field, Send and draft must survive (see [Acceptance evidence](#acceptance-evidence)). Also safe-area insets, rotation, zoom and touch. No clipped composer or actions, no accidental page-wide scrolling, and no focus zoom: editable controls are at least 16 px on coarse pointers. |
| MOB-3 | Full mobile collaboration: capture, conversations, files, projects, tasks, decisions, search, maps and agent results | Integrated phone/tablet journeys with real persisted data, including opening a notification and continuing the linked work |
| MOB-4 | Relevant push notifications with consent and user control | Subscribe, deliver with app backgrounded/not open, open the intended authorized item, mute/unsubscribe, reject permission, expire a subscription and recover delivery without duplicate notifications; delivery through the push mock and a real push service endpoint, and Apple/Chrome display rules met as documented |
| MOB-5 | Recover safely from weak connectivity, suspension and updates | Preserve drafts, show pending/failed state, reconnect without double submission or data loss, and upgrade the service worker without losing in-progress input |
| MOB-6 | Self-hosting includes mobile installation and push operations | Documented HTTPS deployment, origin/subpath handling, push configuration, required outbound connectivity, diagnostics and end-to-end delivery from a self-hosted instance |
| MOB-7 | Mobile quality is verified independently before release | A dated engine/viewport/input matrix that includes the simulated on-screen keyboard, a documented-requirements checklist with dated sources (WebKit/Apple focus-zoom and keyboard behaviour, Chrome `interactive-widget`), observable journey evidence, a separate visual review and interaction/accessibility testing. Physical-device results are optional. |

## Acceptance evidence

Founder direction #266 item 10, 2026-10-05. Each MOB criterion closes on two
kinds of evidence, both tied to the tested commit:

1. **Emulation in Docker.** Chromium and WebKit through Playwright at the
   [adaptive matrix](../design/adaptive-workspaces.md#viewport-and-input-verification-matrix)
   phone/tablet viewports, with touch, coarse pointer, device scale factor,
   rotation, reduced viewport height, safe-area insets and the standalone
   `display-mode` path where the engine can apply it (otherwise a forced test
   flag on the same code path). The manifest and service worker are served over
   HTTPS; push goes through the existing push mock and, for transport, a real
   push service endpoint (the [fixture](../development/mobile-push-verification.md)'s
   desktop provider path). Record engine versions, viewport, scale and throttling.
   **The on-screen keyboard is simulated** (founder decision by @Zamojski5 on
   #268, 2026-10-05). While a field has focus, the test shrinks the viewport the
   way a phone keyboard does, by about 40–50% of the height at 390×844 and on a
   tablet. It does this through a viewport or CDP device-metrics change, with the
   matching `visualViewport` resize and scroll events. It then checks:
   - the focused field and the composer's Send stay visible and tappable above
     the keyboard, and nothing the person needs is hidden behind it;
   - the draft, the scroll position and the selection survive opening and
     closing the keyboard;
   - focusing does not zoom the page: every editable control (`input`,
     `textarea`, `select`, `contenteditable`) computes at least 16 px on a coarse
     pointer. iOS Safari is reported to zoom into a smaller focused field; this
     is a report, not a vendor statement (see the focus-zoom row below).

   This is recorded as emulation. Chromium's `interactive-widget=resizes-content`
   shrinks the layout viewport, but iOS Safari does not support it (MDN
   browser-compat-data, retrieved 2026-10-05). So the iPhone behaviour also needs
   the keyboard and focus-zoom rows under
   [Documented platform requirements](#documented-platform-requirements-266-checked-2026-10-05),
   plus the app's handling of `visualViewport`.
2. **Documented platform requirements.** A checklist that maps each Apple,
   Android/Chrome and standards requirement below to the Flux code or test that
   meets it, with dated primary sources. Observations, vendor statements and
   inferences stay labelled separately.

Emulation does not run iOS Add to Home Screen, OS permission prompts or OS
notification display; Chrome calls device mode "a first-order approximation".
The founder accepts that residual risk. The documented requirements cover these
steps. A later physical report that contradicts them reopens the affected
criterion. Physical sessions remain useful extra evidence, recorded with exact
device/OS/browser versions; they are never a release gate.

**Existing physical evidence.** [#20 session 1](https://github.com/ColdPhase/flux/issues/20),
2026-10-05, `main` `fdb70955`: Android Chrome installed, `fcm.googleapis.com`
subscription, provider 201, display not recorded. iPhone Home Screen app installed,
`web.push.apple.com` subscription, provider 403 (the fixture signed with
`mailto:…@example.test`; #263 now signs with its https origin and warns about
contacts Apple may refuse). iPad not tested. This is retained evidence, not a blocker.

## Interaction and layout

- Design navigation, panels, conversations and primary actions for reach and touch.
  A map/canvas has useful touch gestures and an accessible alternate route to its
  objects; dragging or hovering cannot be the only way to do essential work.
- Choose layouts from available space. Use the tablet area for useful parallel
  context and collapse panels deliberately on phones. Maintain reading position
  and draft state across rotation, pane changes and background/foreground changes.
- Support the virtual keyboard, browser chrome changes, safe-area insets, text
  enlargement and reduced motion. Keep focused fields and send/confirm actions
  visible. Aim for at least 44 CSS px touch areas for primary actions.
- Check 320/360/390 CSS px phone widths, wider phones and 768/1024 CSS px tablet
  layouts, plus split-view widths, in emulated touch contexts. Use the broader
  [adaptive viewport/input matrix](../design/adaptive-workspaces.md#viewport-and-input-verification-matrix),
  including landscape/short heights, real text enlargement and intermediate
  widths. Samples do not replace continuous adaptation checks.
- Measure startup, long-list rendering, scrolling, reconnection and key input
  under recorded CPU and network throttling that approximates low-end phones
  (throttling is relative to the host, so record the host). Agents record useful
  performance budgets with measurements; a desktop screenshot is insufficient.

## Installation, offline behavior and updates

Provide the manifest, appropriate icons, install guidance, service worker and
secure deployment needed by the supported platforms. Feature-detect installation
and notification capabilities. Give platform-appropriate steps when the browser
cannot expose an install button.

Define a safe offline policy: an understandable disconnected view, durable drafts
and explicit pending operations. Server collaboration and agent execution resume
when connectivity returns. Avoid duplicate writes after retries. State what data
is retained on the device; partition it by account/workspace and clear sensitive
cached data on logout. Recheck server permissions when reconnecting or following
a deep link. Handle storage eviction and service-worker/schema upgrades explicitly.

## Push, privacy and operations

Ask for notification permission after a clear user action and explain the useful
events it enables: mentions/replies, assigned work, decisions and agent outcomes.
Users control categories, quiet periods and projects. Keep an in-app notification
inbox usable when push is unavailable, denied or disabled by the operating system.

Persist subscriptions per user/device with authorization, revocation and expiry.
Authorize the event recipient at delivery time and the target again when opened.
Use privacy-preserving lock-screen content by default. Never send private project
text to a user whose access was removed. Protect subscription endpoints against
cross-account changes and forged requests; bound retries and remove dead endpoints.
Treat subscription endpoint URLs/keys as sensitive configuration.

Self-hosted deployments need documented HTTPS and outbound access to the relevant
browser push services. Show operational delivery failures and permission states.
An accepted send is not proof that an OS displayed a notification; power/network
policies and user settings affect delivery. The agent runtime executes server-side
or in its supported runtime and must survive the mobile web app being suspended.

## Platform research and release gate

Record exact tested engine versions and the platform versions each documented
requirement applies to. Cover current and previous major iOS/iPadOS releases and
representative supported Android phone/tablet environments at release time, plus
desktop regression checks. Choose a documented minimum supported baseline based
on documented capabilities and tests. Installation and OS notification delivery
are accepted on the documented requirements plus emulation
([Acceptance evidence](#acceptance-evidence)); real devices are optional.

Research checked 27 September 2026; these are documentation observations, not
Flux implementation or device-test results:

- [MDN installation guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
  updated 7 September 2026: installation behavior varies by platform; the
  `beforeinstallprompt` mechanism is unavailable on iOS. Flux needs an iOS-specific
  installation path as well as browser-provided prompts where supported.
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API):
  subscriptions and service-worker push events are separate from the visible app.
  Recheck the current compatibility information before selecting the release baseline.
- [WebKit's introduction of iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
  **historical baseline, 16 February 2023**: iOS/iPadOS 16.4 introduced Web Push
  for home-screen web apps, with permission requested through user interaction.
  This historical source does not prove today's device compatibility; verify the
  current supported releases and install/permission path against current
  documentation before shipping (sources checked 2026-10-05 below).

### Platform facts used by the PWA/Web Push foundation (#41)

Checked 27 September 2026 while implementing [#41](https://github.com/ColdPhase/flux/issues/41).
These are vendor documentation statements plus our inferences, not device results.

- **iOS/iPadOS need a Home Screen web app.** Apple's
  [Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
  (vendor documentation) says web push is available to "Home Screen web apps in
  iOS 16.4 or later" and to Safari 16 on macOS 13+. *Inference:* in an iPhone/iPad
  Safari tab the client shows add-to-Home-Screen guidance instead of a push button.
- **Permission follows a gesture.** The same Apple page says to let the user grant
  permission "with a gesture, such as clicking or tapping a button" and to call the
  subscription method "immediately from the gesture's event handler". MDN's
  [`Notification.requestPermission()`](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static)
  (modified 11 June 2025) also says to request it in response to user interaction.
  Flux calls `requestPermission()` as the first statement of the click handler and
  subscribes only after it resolves to `granted`. *Observed* in #20 session 1
  (2026-10-05): an installed iPhone Home Screen app returned a `web.push.apple.com`
  subscription through this flow.
- **VAPID limits.** Apple's page states the JWT audience must be the push service
  origin, the expiry at most one day ahead, the public key must match the one given to
  `PushManager.subscribe`, and senders should not refresh the JWT more than once per
  hour. The worker signs 12-hour tokens and reuses them per push service origin.
- **Outbound access.** Apple asks restricted networks to allow `https://*.push.apple.com`.
- **Observed in Docker (Playwright 1.63.0, headless Chromium):** the service worker
  registers and controls the page over HTTPS with a self-signed certificate
  (`--ignore-certificate-errors`), offline navigation shows the fallback page, and
  `Notification.permission` starts as `denied` in headless mode, so real permission
  and OS delivery cannot be shown there.

### Documented platform requirements (#266, checked 2026-10-05)

Retrieved 2026-10-05 for the [acceptance evidence](#acceptance-evidence). Vendor
or standards statements unless marked as a report or an inference.

- **On-screen keyboard, Chrome on Android.** [Prepare for viewport resize behavior changes coming to Chrome on Android](https://developer.chrome.com/blog/viewport-resize-behavior)
  (last updated 2022-10-28): from Chrome 108, "If you don't include
  `interactive-widget` in the viewport meta tag, Chrome will use the default
  behavior, which is `resizes-visual`". `interactive-widget=resizes-content`
  restores the earlier behaviour. Flux: `app/apps/web/index.html` sets
  `interactive-widget=resizes-content`; the simulated keyboard is
  `test_phone_shell.py` test_11 (#267).
- **On-screen keyboard, iPhone and iPad.**
  - Support: [MDN browser-compat-data, `interactive-widget`](https://github.com/mdn/browser-compat-data/blob/main/html/elements/meta/name/viewport/interactive-widget.json)
    (retrieved 2026-10-05) lists `chrome_android` 108, `firefox_android` 133 and
    `safari` `false`; `safari_ios` mirrors Safari. So iOS keeps the layout
    viewport while the keyboard is up.
  - Apple guidance: the HIG's [Virtual keyboards](https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards)
    (page change noted 2025-06-09, retrieved 2026-10-05) says "Using the layout
    guide also helps you keep important parts of your interface visible while
    the virtual keyboard is onscreen".
  - Flux: on touch screens, the app follows `visualViewport` while the keyboard
    is up (`AppLayout.tsx`, #267). This is an inference from the support data;
    it is unverified on a physical iPhone.
- **Focus zoom on iOS (report).** No Apple or WebKit statement about zooming into
  focused fields below 16 px was found (searched 2026-10-05). The 16 px threshold
  is a widely reported WebKit behaviour, so treat it as a report and an
  inference, not a vendor requirement.
  - The HIG's [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)
    (page change noted 2023-06-05, retrieved 2026-10-05) asks to "match the size
    of a text field to the quantity of anticipated text".
  - Flux: a coarse-pointer rule sets every editable control to at least 16 px
    (`ui/ui.css`), and `test_phone_shell.py` test_12 checks it on six screens.
- **Apple Web Push.** [Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
  (undated page): web push for "Home Screen web apps in iOS 16.4 or later";
  permission through a gesture, subscribing "immediately from the gesture's event
  handler"; Safari "doesn't support invisible push notifications" and revokes
  permission if a push is not shown at once; allow `https://*.push.apple.com`;
  the VAPID public key must match the subscription's; refresh the JWT at most hourly.
  A 403 `BadJwtToken` means the JWT is missing, signed with the wrong key, its
  subject "isn't a URL or `mailto:`", its audience isn't the push service origin,
  or its expiry is more than one day ahead. A 410 means "The device token has expired."
- **Apple VAPID contact, reports.** [Apple Developer Forums 725473](https://developer.apple.com/forums/thread/725473)
  (February 2023): a malformed `mailto: <address>` subject caused `BadJwtToken`.
  [yuvomi v1.66.2 release notes](https://newreleases.io/project/github/ulsklyc/yuvomi/release/v1.66.2):
  Apple refused an `admin@localhost` contact. *Inference* from these and #20
  session 1: use a `mailto:` at a real domain or the public https origin.
  [RFC 8292 §2.1](https://www.rfc-editor.org/rfc/rfc8292#section-2.1) says `sub`
  SHOULD be a `mailto:` or `https:` contact URI.
- **Apple Home Screen apps.** [WebKit, Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
  (16 February 2023): push only after Add to Home Screen; the request must follow
  direct user interaction; the Badging API is available. [WebKit Features in
  Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
  (15 September 2025): on iOS/iPadOS 26 "every website added to the Home Screen
  opens as a web app" by default, and a manifest is no longer required for that.
- **Android/Chrome install.** [web.dev, What does it take to be installable?](https://web.dev/articles/install-criteria)
  (updated 19 September 2024): HTTPS; a manifest with `name` or `short_name`,
  192 and 512 px icons, `start_url`, a `display` of `fullscreen`, `standalone`,
  `minimal-ui` or `window-controls-overlay`, and no `prefer_related_applications: true`;
  plus an engagement heuristic (one click/tap and 30 seconds).
- **Android/Chrome push.** [Chrome, Web Push Interoperability Wins](https://developer.chrome.com/blog/web-push-interop-wins)
  (2016): Chrome's Web Push relies on Firebase Cloud Messaging, which accepts the
  standard Web Push protocol; with VAPID no GCM/FCM account is needed. [web.dev,
  Subscribing a user](https://web.dev/articles/push-notifications-subscribing-a-user)
  (2016): Chrome requires `userVisibleOnly: true`. #20 session 1 observed an
  `fcm.googleapis.com` endpoint and provider 201 from Android Chrome.
- **Standards.** [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
  (modified 28 May 2025): an active service worker is required and push events
  arrive whether or not the page is open. [W3C Push API](https://www.w3.org/TR/push-api/).
  [MDN `display-mode`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/display-mode)
  (modified 20 April 2026): reports the display mode actually applied, which can
  differ from the manifest's request.
- **Emulation limits.** [Chrome DevTools device mode](https://developer.chrome.com/docs/devtools/device-mode)
  (updated 20 February 2024): "a first-order approximation"; CPU throttling is
  relative to the host. [Playwright emulation](https://playwright.dev/docs/emulation)
  covers user agent, screen, viewport, touch, `isMobile`, scale factor, permissions,
  color scheme, reduced motion and offline.

### Requirement-to-evidence map (#20, MOB-7)

Code and test references were checked on `main` `ecdceb95` on 2026-10-10. Vendor
sources are the ones listed above (retrieved 2026-10-05, not fetched again). Status:
**emulated** means exercised in Chromium or WebKit emulation in Docker; **code** means
implemented and covered by API or unit tests but not exercised in a browser;
**device** means it needs a real device or OS and is unverified here; **open** means
not implemented or not tested. Each row keeps the labels of its source.

| Requirement (source, type) | Flux code | Test or observation | Status |
| --- | --- | --- | --- |
| Installable manifest: `name` or `short_name`, 192 and 512 px icons, `start_url`, `display: standalone`, no `prefer_related_applications` (web.dev install criteria, 2024-09-19, vendor) | `app/apps/web/public/manifest.webmanifest` | `app/tests/app/pwa.test.ts:25`, `:42` | emulated (manifest only; Chrome's install prompt is not exercised) |
| Apple touch icon 180 px, `apple-mobile-web-app-capable`, manifest link (WebKit, 2023-02-16 and later, vendor) | `app/apps/web/index.html:5,14,16` | `app/tests/app/pwa.test.ts:56` | emulated (markup) |
| Service worker at scope `/` with a fetch handler; `sw.js` served uncached (MDN Push API, 2025-05-28, vendor) | `app/apps/web/src/pwa/register.ts`; `app/apps/web/src/pwa/sw.js:32` | `app/tests/app/e2e/pwa.e2e.ts` scope test; `pwa.test.ts:67` | emulated |
| iOS/iPadOS: web push only for Home Screen web apps, iOS 16.4 or later; Add to Home Screen is the install step (Apple, undated page; WebKit, 2023-02-16, vendor) | `app/apps/web/src/pwa/push.ts:33-34,78`; `NotificationsButton.tsx` (`needs-install` note) | none in a browser | code; Add to Home Screen is **device** only |
| Permission requested from the user's gesture, as the first statement of the handler (Apple, vendor; MDN `Notification.requestPermission()`, 2025-06-11, vendor) | `app/apps/web/src/pwa/push.ts:97`; click handler in `NotificationsButton.tsx` | `pwa.e2e.ts` counts prompts on load (0). The gesture path is not browser-tested: headless permission starts `denied` | code; the prompt itself is **device** only |
| Subscribe "immediately from the gesture's event handler" (Apple, vendor) | `push.ts:97-110` subscribes after the awaited prompt, not synchronously | observed on an iPhone Home Screen app, #20 session 1 (2026-10-05) | observed; the literal "immediately" wording is **not** met, so it is open for review |
| `userVisibleOnly: true` required by Chrome (web.dev, 2016, vendor) | `push.ts:109,142` | observed: Android Chrome `fcm.googleapis.com` subscription and provider 201 (#20 session 1) | observed |
| A push must show a notification at once or Safari revokes permission (Apple, undated, vendor) | `app/apps/web/src/pwa/sw.js:74-86` (every `push` calls `showNotification`) | none in a browser | code; display is **device** only |
| VAPID: `aud` is the push origin, `exp` at most one day ahead, `sub` a `mailto:` or https URI, public key matches (Apple, vendor; RFC 8292 §2.1) | `app/packages/core/src/push/config.ts:87-88,103-105` (subject validation and reachability warning); worker reuses its JWT per origin | `app/tests/app/push.test.ts:40`, `:63`; a 403 on 2026-10-05 before #263 changed the subject | code and API tests; FCM accepted (201); the iPhone 403 is not re-observed since #263 |
| A `404` or `410` from a push service removes the subscription; `503` is retried, `400`/`403` are not (Apple, vendor; worker behaviour) | `app/packages/core/src/push/delivery.ts:96-103` | `app/tests/app/push.test.ts:189`, `:254` | code and API tests |
| Outbound HTTPS to the push services (`*.push.apple.com`, `fcm.googleapis.com`) (Apple, vendor) | `docs/development/containers.md:256-257`; `app/apps/worker/src/push/public-lookup.ts` | `app/tests/app/push-public-lookup.test.ts:37`, `:52`, `:70` | documented and API-tested; FCM transport observed |
| Standalone detection with `display-mode` (MDN, 2026-04-20, vendor) | `push.ts:33-34`, used only for the iOS install note | none; there is no standalone test flag | **open** for the MOB-1 standalone cold launch |
| Install guidance where the browser offers no install button (contract, MOB-1) | only the iOS note in notification settings; Chrome `beforeinstallprompt` is not used | none | **open** (MOB-1); the surface is for the final design (#341, #352) |
| Editable controls at least 16 px on a coarse pointer (WebKit report, not an Apple statement) | `app/apps/web/src/ui/ui.css:116` (`.ui-input`) | `app/tests/ui/test_phone_shell.py` `test_12`, six routes | emulated on six routes; other routes **open** |
| Simulated keyboard keeps the field and Send visible; the app follows `visualViewport` (contract; MDN browser-compat `interactive-widget`, 2026-03-26: Safari unsupported) | `app/apps/web/index.html:5`; `app/apps/web/src/app/AppLayout.tsx:263` | `test_phone_shell.py` `test_11` (Chromium and WebKit lanes) | emulated; the iOS keyboard is **device** only |
| Safe-area insets (MDN `env()`, 2026-09-12, vendor) | `index.html:5` (`viewport-fit=cover`); `app/apps/web/src/app/app.css:13,40,48` | none; emulation cannot apply insets | code; **device** only |
| Offline: an understandable offline page; API responses never cached (contract, MOB-5) | `sw.js:32-54`, `sw.js:38` (`/api` bypass) | `pwa.e2e.ts` offline test | emulated |
| Update: the new worker waits, the app asks, one reload on confirmation (contract, MOB-5) | `app/apps/web/src/pwa/register.ts`; `app/apps/web/src/pwa/UpdatePrompt.tsx` | `pwa.e2e.ts` update test | emulated; **open**: drafts and in-progress input across an update are not tested |
| Lock-screen privacy: generic title unless the server sent a full preview; tap-time recheck through `GET /api/v1/inbox/:id` (contract, #41) | `sw.js:72`, `sw.js:96-107`, `sw.js:112` | `push.test.ts:222` and `:246` (recheck and expiry, API level) | code and API tests; the display is **device** only |
| Denied or revoked permission keeps the inbox usable (contract, MOB-4) | `NotificationsButton.tsx` `MESSAGES.denied` and `unsupported` | `push.test.ts:315` covers push unavailable, not a browser permission state | **open** for the browser state |

Still open for #20 after this map: the install guidance and standalone cold launch
(MOB-1); browser subscription, mute and unsubscribe flows with the push mock (MOB-4);
drafts across a service-worker update (MOB-5); the self-hosting walk-through (MOB-6);
phone and tablet journeys (MOB-2 and MOB-3, owned with #151, #264, #265 and #136).
Other UI suites still launch Chromium only; `test_settings` and `test_notifications`
already select WebKit through `FLUX_UI_BROWSER`, and the phone shell and the
service-worker journey now run in both engines.

### Lock-screen privacy

A push notification can appear on a locked or shared screen, so its content follows
the same audience as the thing it is about ([#41](https://github.com/ColdPhase/flux/issues/41),
[access policy](../development/access-policy.md)):

- A notification exists only for a recipient who can read its source (a workspace,
  project, draft or direct message) when it is created, and follows that person's
  preferences, muted places and quiet hours ([#116](../development/notifications.md)).
- Right before sending, the worker rechecks the source through the access policy. A
  recipient who can no longer see the source receives nothing. The title and body
  are included only while the recipient can read the source; otherwise the device
  shows the fixed text "New activity in Flux" with an opaque notification id.
- Tapping a notification never trusts the payload: the service worker asks
  `GET /api/v1/inbox/:id`, which rechecks access and the session, and opens the app at
  its start page when the answer is `404`.
- A subscription belongs to the session that created it. Signing out, revoking that
  session, revoking other sessions, resetting the password or deleting the account
  deletes it, so a handed-over or signed-out device stops receiving previews.
- The push payload is end-to-end encrypted to the device (RFC 8291), so the push
  service cannot read it. Operating-system settings (for example hiding previews on
  the lock screen) still apply on top. The tap-time fetch and generic preview are
  part of MOB-4/MOB-7 evidence in #20, verified as described in
  [Acceptance evidence](#acceptance-evidence).

MOB-1 through MOB-7 are required in milestone 2 and its final acceptance report;
track implementation in [issue #20](https://github.com/ColdPhase/flux/issues/20).
Optional physical-device evidence can be collected in one disposable trusted-HTTPS
session; see [the device verification fixture](../development/mobile-push-verification.md).
Agents may create and sequence smaller issues, but cannot mark the full product
complete with mobile install, touch journeys or push delivery unverified by the
[acceptance evidence](#acceptance-evidence).
Native app-store packaging can be decided separately; PWA delivery is required.
