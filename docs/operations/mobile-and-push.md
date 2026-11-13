# Phones, tablets and push notifications

This page walks an operator from a running Flux to people installing it on Android,
iPhone and iPad and receiving notifications (MOB-6 in
[mobile-pwa.md](../product/mobile-pwa.md)). Details stay in the linked pages.

## 1. Serve Flux over HTTPS at the root of its own origin

- Browsers install a web app and run its service worker only in a secure context, so
  people must open `https://`. Follow the tested [Caddy reverse proxy](reverse-proxy.md).
- Set `FLUX_PUBLIC_ORIGIN` to exactly that origin, including a nonstandard port.
- **No subpath.** Flux is served from `/`: the manifest's `start_url` and `scope` are `/`
  and the service worker is `/sw.js` with scope `/`. The server refuses a
  `FLUX_PUBLIC_ORIGIN` with a path at startup ("must be an http(s) origin without a path").
  Give Flux its own host name, such as `flux.example.org`, instead of
  `example.org/flux`.
- The proxy must pass `/sw.js`, `/manifest.webmanifest`, `/icons/*` and `/offline.html`
  unchanged. Flux sends `Cache-Control: no-cache` for `/sw.js`; do not let the proxy or a CDN
  cache it longer, or people get updates late.

## 2. Turn on Web Push

Set both `FLUX_VAPID_PUBLIC_KEY` and `FLUX_VAPID_PRIVATE_KEY` ([install step 3](install-release.md),
[variables](configuration.md#web-push)); a source checkout's `./flux up` makes them.
`FLUX_VAPID_SUBJECT`, the contact the push services get, is optional: empty, it is your public
`https://` origin (`FLUX_PUBLIC_ORIGIN`), which Apple's push service accepts, so there is nothing
to set. Set it only to give a `mailto:` address at a real domain you own. With a `localhost`,
`.local` or `.test` contact, or an origin that is not `https`, Apple's push service answers 403
and iPhone and iPad notifications fail. The worker warns about this at startup, and again with
the fix whenever a push service refuses the contact (`403 BadJwtToken`). A `docker/.env` from
v0.2.0 that still holds `mailto:admin@localhost.localdomain` (what `./flux up` used to write) is
treated as empty. Back up the key pair with the other secrets ([backup](backup-restore.md)).
Restoring the same pair keeps every device's subscription.

## 3. Allow outbound HTTPS to the push services

The worker, not the browser, sends each notification. It needs outbound HTTPS (443) to:

| Browser | Push service host |
| --- | --- |
| Chrome and other Chromium browsers, Android | `fcm.googleapis.com` |
| Safari on macOS; Home Screen apps on iPhone and iPad | `*.push.apple.com` |
| Firefox | `*.push.services.mozilla.com` |
| Edge on Windows | `*.notify.windows.com` |

The worker refuses push endpoints that resolve to private, loopback or link-local addresses.
Inbound access is not needed for push.

## 4. What people do on their devices

| Device | Install | Notifications |
| --- | --- | --- |
| Android (Chrome) | Settings → Appearance → **Install Flux** when Chrome offers it; otherwise the browser menu's *Install app* or *Add to Home screen* (Flux shows that hint) | Settings → Notifications → **Turn on notifications** |
| iPhone and iPad (Safari) | Share → **Add to Home Screen** (Flux shows these steps in Settings) | Only in the Home Screen app, iOS/iPadOS 16.4 or later: open Flux from the Home Screen, then **Turn on notifications** |
| Computer (Chrome, Edge) | **Install Flux** in Settings, or the browser's install icon | **Turn on notifications** |

Flux asks for notification permission only after the person presses that button. If
permission is refused, or push is not set up, Settings says so and everything still
appears in the Inbox.

## 5. Check that it works

1. Sign in to Flux, then open `https://<your host>/api/v1/push/public-key` in the same
   browser. `{"status":"available",...}` means push is configured; `503 PUSH_UNAVAILABLE`
   means the API has no public key. Signed out, the address answers `401`: it needs a session.
2. On a phone, turn on notifications, then ask someone to send that person a direct message.
3. If nothing arrives, read the worker log (`docker compose logs worker`). Each delivery
   attempt logs the push service's status. 201 means accepted; 403 usually means a VAPID
   contact or key mismatch (`403 BadJwtToken` from Apple: the worker log says the contact was
   refused and what to set); 404 and 410 remove the subscription (the device must turn
   notifications on again); 429 and 5xx are retried up to five times.
4. A 201 means the push service accepted the message, not that the device showed it.
   Battery saving, Focus modes and notification settings on the device can delay or hide it.

The [device verification fixture](../development/mobile-push-verification.md) runs the same
path end to end in a disposable HTTPS session, for a maintainer who wants physical-device
evidence. It is optional.

## 6. Updates

A new Flux version installs its service worker in the background. Open apps show "A new
version of Flux is available" and switch only when the person taps **Reload**. Unsent drafts
stay ([mobile-pwa.md](../product/mobile-pwa.md#installation-offline-behavior-and-updates)).
No operator step is needed.
