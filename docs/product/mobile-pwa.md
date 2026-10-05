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
MOB criterion. #136 owns integrated UX; #20 remains responsible for mobile
installation, interaction and notification evidence.

## Required outcomes

| ID | User-visible outcome | Acceptance evidence |
| --- | --- | --- |
| MOB-1 | Install and launch Flux on Android, iPhone and iPad; recognizable icon/name, standalone window, stable identity and deep links | Manifest, icons and service worker meet each platform's documented install requirements; in emulation, the standalone display mode, cold launch, login/session recovery and reopening the correct project from a link |
| MOB-2 | Productive layouts on phones and tablets, in portrait, landscape and tablet split view | Real content and all key journeys at emulated phone/tablet viewports, with a reduced-height (software keyboard) viewport, safe-area insets, rotation, zoom and touch; no clipped composer/actions or accidental page-wide scrolling |
| MOB-3 | Full mobile collaboration: capture, conversations, files, projects, tasks, decisions, search, maps and agent results | Integrated phone/tablet journeys with real persisted data, including opening a notification and continuing the linked work |
| MOB-4 | Relevant push notifications with consent and user control | Subscribe, deliver with app backgrounded/not open, open the intended authorized item, mute/unsubscribe, reject permission, expire a subscription and recover delivery without duplicate notifications; delivery through the push mock and a real push service endpoint, and Apple/Chrome display rules met as documented |
| MOB-5 | Recover safely from weak connectivity, suspension and updates | Preserve drafts, show pending/failed state, reconnect without double submission or data loss, and upgrade the service worker without losing in-progress input |
| MOB-6 | Self-hosting includes mobile installation and push operations | Documented HTTPS deployment, origin/subpath handling, push configuration, required outbound connectivity, diagnostics and end-to-end delivery from a self-hosted instance |
| MOB-7 | Mobile quality is verified independently before release | A dated engine/viewport/input matrix, a documented-requirements checklist with dated sources, observable journey evidence, separate visual review and interaction/accessibility testing; physical-device results are optional |

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
