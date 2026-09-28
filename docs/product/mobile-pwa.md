# Mobile and tablet PWA

**Accepted founder requirement, 27 September 2026 (F-010).** Flux must be a
first-class mobile workspace as well as a desktop application. Android phones
and tablets, iPhones and iPads are required product targets. Users must be able
to install Flux as a PWA, launch it from their home screen, collaborate comfortably
with touch, and receive authorized Web Push notifications. This is part of the
complete application release; agents choose and review the implementation without
waiting for founder approval.

This supplements the original [foundation](FLUX-FOUNDATION.md), especially areas
8.1–8.16 and the design/attention principles. Preserve that original document.
Include mobile use in persona journeys, architecture, design proposals, the
coverage matrix, task contracts and final integrated verification from the start.

## Required outcomes

| ID | User-visible outcome | Acceptance evidence |
| --- | --- | --- |
| MOB-1 | Install and launch Flux on Android, iPhone and iPad; recognizable icon/name, standalone window, stable identity and deep links | Installation from the supported browser, cold launch, login/session recovery and reopening the correct project from a link on each platform |
| MOB-2 | Productive layouts on phones and tablets, in portrait, landscape and tablet split view | Real content and all key journeys at narrow widths, with software keyboard, safe areas, rotation, zoom and touch; no clipped composer/actions or accidental page-wide scrolling |
| MOB-3 | Full mobile collaboration: capture, conversations, files, projects, tasks, decisions, search, maps and agent results | Integrated phone/tablet journeys with real persisted data, including opening a notification and continuing the linked work |
| MOB-4 | Relevant push notifications with consent and user control | Subscribe, deliver with app backgrounded/not open, open the intended authorized item, mute/unsubscribe, reject permission, expire a subscription and recover delivery without duplicate notifications |
| MOB-5 | Recover safely from weak connectivity, suspension and updates | Preserve drafts, show pending/failed state, reconnect without double submission or data loss, and upgrade the service worker without losing in-progress input |
| MOB-6 | Self-hosting includes mobile installation and push operations | Documented HTTPS deployment, origin/subpath handling, push configuration, required outbound connectivity, diagnostics and end-to-end delivery from a self-hosted instance |
| MOB-7 | Mobile quality is verified independently before release | A dated OS/browser/device matrix, observable journey evidence, separate visual review and interaction/accessibility testing; unavailable device tests remain unverified |

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
- Check 360/390 CSS px phone widths, wider phones and 768/1024 CSS px tablet
  layouts as starting fixtures, plus actual devices and split view. These samples
  do not replace responsive behavior between breakpoints or accessibility checks.
- Measure startup, long-list rendering, scrolling, reconnection and key input on
  representative mobile hardware and constrained networks. Agents record useful
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

Record exact tested OS/browser versions. Cover current and previous major iOS/
iPadOS releases and representative supported Android phone/tablet environments
at release time, plus desktop regression checks. Choose a documented minimum
supported baseline based on available capabilities and tests. Use real devices
or a suitable device service for installation and OS notification delivery;
viewport emulation is useful layout evidence only.

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
  current supported releases and install/permission path on devices before shipping.

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
  subscribes only after it resolves to `granted`. *Unverified:* whether iOS accepts
  the subscribe after that await must be confirmed on devices (MOB-7).
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
  the lock screen) still apply on top. *Unverified on devices:* the tap-time fetch and
  generic preview on iPhone/iPad and Android are part of MOB-4/MOB-7 evidence in #20.

MOB-1 through MOB-7 are required in milestone 2 and its final acceptance report;
track implementation in [issue #20](https://github.com/ColdPhase/flux/issues/20).
Agents may create and sequence smaller issues, but cannot mark the full product
complete with mobile install, touch journeys or push delivery still unverified.
Native app-store packaging can be decided separately; PWA delivery is required.
