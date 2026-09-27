# Supplied live-collaboration reference

`flux-live.html` is the standalone design demonstrator supplied by Hubert on
2026-09-27 for [issue #59](https://github.com/ColdPhase/flux/issues/59). It is
preserved byte for byte from `/home/hubert/Downloads/flux-live.html` (42,796
bytes; SHA-256
`1f32429c9091881a1663ea88b948fe7dd48ad699669e46fa9884a2ba63259f27`).
That Downloads path records the local handoff, not an upstream project or a
repeatable download address. The checked-in file and hash are the durable
reference. The local `flux-ux-v8.html` link in the supplied file is resolved by
the adjacent relative symlink to the existing root prototype; the source HTML
itself has not been edited.

This reference shows an interaction idea for joining people at existing work,
sharing a selected Flux fragment, working quietly, returning to the shared
context, and leaving durable changes in a conversation, task, or wiki. Its
layout, words, color, and monolithic JavaScript are prototype evidence, not a
production contract or code to import. See #59 and the product/design decision
records for accepted behavior and implementation boundaries.

## Rendered evidence

All four screenshots were captured at 100% browser zoom and device scale 1 in
container Chromium (Playwright 1.62), on 2026-09-27. They show this exact
checked-in HTML. The joined views are captured after the temporary toast
disappears.

| State | Viewport | Screenshot |
| --- | --- | --- |
| Before joining | 1440 × 900 desktop CSS pixels | [Desktop](flux-live-desktop.png) |
| Joined with devices off | 1440 × 900 desktop CSS pixels | [Desktop joined](flux-live-desktop-joined.png) |
| Before joining | 390 × 844 phone CSS pixels | [Phone](flux-live-phone.png) |
| Joined with devices off | 390 × 844 phone CSS pixels | [Phone joined](flux-live-phone-joined.png) |

In the same isolated container, the HTML and its v8 link returned HTTP 200.
Desktop and phone joins left all media tracks off. A fake Chromium microphone
track became live only after a click and stopped on entering quiet mode. A
typed result appeared in the task view after submission from conversation;
leaving ended the local session. No page errors occurred. The microphone was a
browser fake device, not a physical device or another participant.

## Limits of this evidence

The second person, invitations, shared focus, following, and AI suggestions are
scripted local state. Some content persists only in this browser's
`localStorage`; there is no backend, authentication, authorization, or
multi-user synchronization. Microphone, camera, and display controls can
request a **local** media preview where the browser permits it. This file has
no WebRTC connection or media server and sends no media to a receiver. The
screenshots and interaction run establish neither call quality, 1440p/60 fps,
mobile device capture, accessibility conformance, nor real Android/iPhone/iPad
behavior. Those require separate application and device tests.
