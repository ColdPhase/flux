# Live sessions at the work (#62)

**Status:** implemented on `claude-maurycy/62-live-ux` for
[#62](https://github.com/ColdPhase/flux/issues/62), on the #61 server slice
([PR #109](https://github.com/ColdPhase/flux/pull/109)). It follows the
[live collaboration contract](../../product/live-collaboration.md) and the accepted
[O-003 C direction](../direction.md). The supplied
[interaction reference](../references/live/README.md) stays outside the app bundle; its
palette, demo data and single-file script were not copied.

## What a person sees

- **Where the work is.** An open task in Details shows **Work on this together** under its
  blocker, with who can join ("Ada, Jonas and Kai can join · nothing turns on until you
  choose"). The project header has a quiet **Together** button for the current place: the
  open task, map, doc or conversation. When a session already runs there, the button becomes
  **Join** with the faces of the people in it. Sessions at other places in the project
  appear under **Live now**. There is no wizard, no ringing, no answer/reject takeover and
  no missed-call state.
- **Invitations.** Inviting someone creates one ordinary inbox item ("Nia Okafor invited
  you to work together · On “…” in Gesture lamp"). Opening it goes to the work itself, where
  one card offers **Join**, **Later** (nobody is told) and **Reply in text** (the ordinary
  conversation; nothing is sent for you). The recipient controls it under *Invitations to
  work together* in notification settings. Email is off by default.
- **The strip.** A single row in the page flow, between the view tabs and the work. It shows
  Live, Quiet or Reconnecting, the anchor (it links back), the faces of the people present
  (a green ring while someone speaks, a small slashed microphone when muted), and these
  controls: **Show this**, the screen viewer, **Microphone**, **Camera**, **Screen**,
  **More** and **Leave**. Because the strip is in the flow, it never covers the composer,
  result actions or the focused material. A second quiet line appears only for what someone
  shows, following, or your own screen share.
- **Devices are truthful.** Joining requests nothing. Each device turns on only from its own
  button. A button is solid only while its track is really captured and published. Turning
  a device off unpublishes and stops it, so the browser's recording light goes out. A
  refusal, missing hardware, a device in use, a withdrawn permission or an unplugged device
  each gives one calm sentence. A missing device is detected before any prompt. Sound
  blocked by the browser shows **Turn on sound** instead of claiming the person can hear.
- **Quiet.** *Work quietly* stops the microphone, camera and screen and what you hear, and
  ends following. You stay in the session. **Return** resumes listening only; nothing is
  sent until you turn it on.
- **Show this / View / Follow.** **Show this** publishes the object on screen as an
  identifier: the open task, a result, the doc at the exact version you are reading, or the
  map with its selected thoughts. Recipients get one quiet line ("Nia Okafor is showing
  “Low-light test protocol” · doc · version 1") and are never moved. **View** opens it once.
  **Follow** is opt-in. It ends as soon as you navigate yourself or work in the content
  (typing, dragging), and a toast says so. Private navigation never publishes anything.
- **Screens and cameras.** Screen sharing always goes through the browser's own picker.
  Your own screen is not previewed back to you, to avoid a mirror loop. Instead a red line
  says you are sharing and offers **Stop sharing**; stopping from the browser is noticed.
  Viewers open the stage over the work area. With two screens they choose which one to
  focus, then **Fit**, **1:1** (one screen pixel per display pixel), or zoom with ± (keys
  + − 0 1) and drag to pan. Camera tiles are optional, sorted by join time so they never
  reshuffle, and can be hidden. **Back to work** or Escape returns to the same place.
- **More.** Opens as a popover on desktop and a sheet on phones. It holds:
  - who is here and each person's real state;
  - who can join, with **Invite**;
  - your devices, *Work quietly*, and **Show …**;
  - **Help and privacy**: personal assistants are not used in live sessions and never hear
    the room or see cameras and screens; audio notes are not available; phones may pause
    media in the background;
  - **Connection details**: measured resolution, fps, bitrate, loss, jitter, RTT and
    quality-limitation reasons from WebRTC statistics, refreshed every two seconds while
    open.
- **Reconnect and endings.** A dropped connection is shown as Reconnecting. Flux rejoins
  through the API, which checks access again and may issue a fresh room generation. After a
  full rejoin every device is off, and a toast says so. Joining in another window stops this
  one with a calm notice. An ended or revoked session ends the strip; saved work is never
  touched. Leaving as the last person says the session closes shortly.
- **Phone and tablet.** The strip is one 52 px row: the anchor, microphone, **More** and
  **Leave**. Every target is at least 44 × 44 px. Everything else is in the sheet. When a
  browser cannot publish its screen (Android and iOS browsers have no `getDisplayMedia`),
  Flux shows no screen button. It says so in the sheet and still lets the person view
  screens and **Show this**. Drafts persist while you navigate with the session open.
- **Updates.** A waiting PWA update says that reloading leaves the live session, and that
  saved work and drafts stay.

## Placement decisions

- **Strip in the flow, not a floating dock.** The reference's fixed mobile strip covered the
  work. A normal-flow row reserves its own height, so the composer, the virtual keyboard and
  safe areas behave as they do without a session.
- **Stage over the pane, not a new route.** Screens need the width of the work area. A
  stage over the pane keeps the route, drafts and scroll underneath intact, so **Back to
  work** is exact.
- **One status colour.** `--ok` marks "live" and "sending"; the screen-share state uses
  `--danger` because it exposes the most; the accent stays for "needs you" and the primary
  **Join**. Nothing relies on colour alone: every state is also in text or a label.

## Not offered, and why

- **Showing a single message.** A presentation reference carries only a message ID. There
  is no authorized endpoint that locates a message's conversation, so a recipient could not
  open it. Messages are shown by showing their conversation's task, result or doc instead.
- **A wiki text anchor.** The #61 reference has a doc ID and version but no section
  anchor. A shown doc opens at that exact version, from the top.
- **Personal-assistant help and audio consent.** They depend on O-008/#68 and a later scoped
  audio task. They are stated as unavailable, not simulated.

## Screenshots

These are local renders with Chromium's fake camera, microphone and screen. The pattern is
the fake device's test card, not real content. Captured by `scripts/check_live_ui.sh`.

| File | State |
| --- | --- |
| `live-desktop-1440-blocked-task.png` | A blocked task in Details with **Work on this together** and its audience |
| `live-desktop-1440-panel.png` | The session's **More** panel: people, invite, devices, quiet, help |
| `live-desktop-1440-inbox.png` | The invitation as one ordinary inbox item |
| `live-desktop-1440-invitation.png` | The invitation card at the task: Join · Later · Reply in text |
| `live-desktop-1440-shown-fragment.png` | A recipient seeing “Nia is showing …” with View / Follow, not moved |
| `live-desktop-1440-stage-one-screen.png` | One screen at 1:1 zoomed to 125% |
| `live-desktop-1440-stage-two-screens.png` | Two simultaneous screens with explicit focus, two camera tiles |
| `live-desktop-1440-four-people.png` | Four people at a doc, back at the work |
| `live-desktop-1280-four-people.png` | The same session at 1280 × 800 |
| `live-phone-390-strip.png` | Phone: one compact row above the conversation and composer |
| `live-phone-390-sheet.png` | Phone: the session sheet |
| `live-phone-390-stage.png` | Phone: viewing a shared screen |
| `live-tablet-820-session.png` | Tablet portrait in a session |
