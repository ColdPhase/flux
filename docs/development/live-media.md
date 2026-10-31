# Self-hosted live media: restrictive-network relay slice (#63)

The live backend in #61 uses LiveKit `v1.13.7` (image digest in
[`compose.live.yaml`](../../docker/compose.live.yaml)); the isolated browser proof
uses `livekit-client` `2.17.2` from a lockfile. Both versions must be reviewed
together before an upgrade. This page describes the TURN/TLS addition. It does
not certify call quality or real device support.

## Founder direction 2026-10-30: a simulated public host

**Founder direction (Hubert, PelikanFix16), 2026-10-30.** The requirement of [#63](https://github.com/ColdPhase/flux/issues/63)
for "a public host with DNS, trusted TLS, NAT and TURN on 443" may be met by a faithful simulation that the agents
build and verify themselves, instead of rented infrastructure. Faithful means: a separate "internet" network, NAT
routers in front of the client networks, a DNS server for the Flux and TURN names, TLS from one CA the clients trust,
Flux behind the documented reverse proxy on 443, TURN/TLS on 443 and TURN/UDP on 3478 at the advertised public
media address, and clients that can reach only the public side. Real browsers must connect through it. The
simulation does not prove a public ACME certificate, real Internet paths, carrier NAT or physical devices; results
say so. See [Simulated public host](#simulated-public-host-63-2026-10-30).

## Compose deployment

Layer `docker/compose.source.yaml`, `docker/compose.live.yaml`, then
`docker/compose.live.turn.yaml`. Set all base live variables plus:

| Variable | Operator value |
| --- | --- |
| `FLUX_LIVEKIT_TURN_DOMAIN` | Public DNS name dedicated to the TURN service; certificate SAN must match. |
| `FLUX_LIVEKIT_TURN_CERT_DIR` | Absolute host directory with trusted-CA `fullchain.pem` and `privkey.pem`, readable by the LiveKit container. Keep the private key outside the repo. |
| `FLUX_LIVEKIT_TURN_TLS_BIND` | Public IP dedicated to TCP/443 TURN/TLS; defaults to `0.0.0.0`, which conflicts with an HTTPS ingress on the same IP. |
| `FLUX_LIVEKIT_TURN_TLS_HOST_PORT` | Keep `443` for a direct public deployment. The isolated Docker test uses a separate host port while browsers reach container TCP/443. |
| `FLUX_LIVEKIT_MEDIA_CIDR` | The address (as `/32`) or network of the SFU's media interface, when its host or container has more than one interface. Applies to `compose.live.yaml` too. Default `0.0.0.0/0` keeps every IPv4 interface. Without it, LiveKit maps every interface to `node_ip` and may answer from the wrong one; the [simulated public host](#simulated-public-host-63-2026-10-30) showed TURN relays then never connect. |

The API reaches LiveKit at `http://livekit:7880` on the internal
`livekit-signal` network. Browsers signal through Flux's public `/media` gate,
which rechecks the cookie session, admission and current access (#128); the
SFU's TCP/7880 is neither published nor reachable from the media network.
Terminate Flux HTTPS/WSS at the operator's reverse proxy. TURN/TLS
terminates in LiveKit itself on TCP/443; an HTTP reverse proxy cannot carry
it. Use a separate public IP or a layer-4 TCP load balancer. The LiveKit `node_ip`
must be the publicly reachable media address; with NAT, forward the following
ports to this host and test candidates from outside its LAN:

| Inbound | Purpose |
| --- | --- |
| TCP/443 on TURN address | Embedded TURN/TLS, trusted cert and dedicated DNS. |
| UDP/3478 | Embedded TURN/UDP and STUN. |
| UDP/7882 | SFU ICE UDP mux. |
| TCP/7881 | SFU ICE TCP fallback. |
| TCP/7880 internal only | SFU signaling/room service, reachable only by the Flux API. |

Keep the API key/secret in the operator's secret store or protected environment
file; rotate them together in API and SFU. Do not put them in public browser
configuration. This profile starts no recorder, egress, ingress, transcription,
or agent listener. The room has a 16-participant configured ceiling, which is
not a measured capacity. The existing service health probe checks signaling
readiness only; it does not prove media reachability. The overlay exposes
`/metrics` on SFU TCP/6789 bound to its internal signaling interface and loopback;
it is not published. An operator can inspect it with `docker compose exec -T
livekit wget -q -O - http://127.0.0.1:6789/metrics` using the same Compose layers,
or attach a private monitor to the signaling network. Media clients cannot scrape
it. Monitor the host's CPU/memory/network egress
and LiveKit logs, and test a real external client
after firewall, certificate or NAT changes. Upgrade by pinning a new digest in
one reviewed PR, testing against a preserved database and staging endpoint,
then rolling back to the previous digest/config if the call fails. A restart
interrupts current media; Flux's room-generation recovery is tested by
`scripts/check_live_sfu.sh` but quality/recovery time is still unmeasured.

Kubernetes (k3s, Helm) is not supported yet: Docker Compose is the only supported install (founder decision,
2026-10-31). The earlier k3s chart values and their render check were removed.

What each hop encrypts, which parties can read media, and the DTLS evidence
are recorded in [live-media-encryption.md](live-media-encryption.md). Media is
encrypted in transit and decrypted in the SFU; it is not end-to-end
encrypted.

## Local restrictive-network proof

Run `./scripts/check_live_turn.sh`. It builds the app and pinned Chromium SDK
in Docker, starts an isolated Compose project and database, creates a disposable
test certificate, and places the **client** container behind an egress rule
rejecting UDP to the SFU and direct TCP/7881. Two authorized browser clients
join the same Flux session, one publishes a generated Web Audio tone, and the
other subscribes.
Browser contexts carry each person's own Flux cookie and use the same public
origin forwarder and session-bound signaling gate as the current SFU tests.
The test obtains metrics inside the SFU container and retains them as artifacts;
it never opens the internal signaling network to browsers. The existing real-SFU
revocation and sign-out cases also run under the restrictive relay profile.
The assertion reads the selected WebRTC candidate pair on both clients and
requires relay over TLS with received bytes. It also requires completed DTLS
with an SRTP profile and the signaled certificate on every transport that
carried RTP. A negative control with a tampered fingerprint must fail DTLS
(see [live-media-encryption.md](live-media-encryption.md#automated-evidence)). The temporary certificate is
accepted only by this test browser; it does not prove a real public CA or NAT.
The script removes its volumes, images and certificate on exit. It is a local
heavy check, not a per-push GitHub Action.

The suite also starts a **separate Xvfb display** and headed Chromium to call
the actual browser `getDisplayMedia()` from a clicked button on a localhost
page. Browser flags select that virtual display and supply fake camera and
microphone devices; the test publishes all three tracks through the Flux room
and checks received screen/camera video and microphone RTP over TURN/TLS.
It never connects to the operator's Wayland/X11 desktop, webcam or microphone.
This is an isolated browser API and transport check, not a physical-device,
human picker, system-audio or #62 UI result. A failed capture is a failed test;
do not replace it with `canvas.captureStream()` or count the existing synthetic
screen test as its substitute. [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
documents the secure-context, user-activation and per-invocation picker rules;
the isolated test uses localhost and a real click to meet the first two.
The 2026-09-30 current-main run passed this case; source settings and receiver
frames remain distinct from physical-device and measured receiver-fps evidence.
See the [pinned five-case report and original artifacts](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/development/evidence/live-turn/2026-09-30/README.md).

Set `FLUX_LIVE_TURN_ARTIFACT_DIR` to retain browser screenshots and the SFU
resource trace at a chosen path (otherwise the script prints a new `/tmp` path).
`livekit-container-stats.jsonl` records timestamped Docker container CPU,
reported memory usage and cumulative receive/transmit network traffic roughly every two
seconds; `livekit-phases.jsonl` marks `four_connected`, `four_media_active` and
`four_media_verified`. The test summarizes samples inside the media-active
interval and fails if fewer than two were captured or the SFU transmitted no
bytes. It reports mean/peak CPU percentage, peak memory and network byte deltas;
the raw samples remain the measurement record. These are local-container
measurements, not public-link capacity or a four-person service limit. Keep
raw trace files with the tested commit when reporting performance results.

The test overlay alone allows TURN to relay to Docker's `172.16.0.0/12`
bridge network, because the SFU's test ICE address is private. LiveKit denies
restricted TURN peers by default. Production keeps that denial with the public
`node_ip`; an operator using a private SFU peer must design a narrow allowed
CIDR and document that network boundary, rather than copy the test exception.

**Observed 2026-09-28, local Docker run:** `./scripts/check_live_turn.sh` exited
0 (1/1 browser test). The disposable CA verified TURN/TLS 1.3 SNI and hostname;
SFU metrics returned HTTP 200. Both authorized clients' selected ICE pairs
were `candidateType=relay`, `protocol=udp`, `relayProtocol=tls`, `succeeded`.
The publisher's pair sent/received 1945/1216 bytes, the receiver's
1310/1655 bytes; the receiver subscribed and its audio `inbound-rtp` reported
at least three received packets. Client firewall counters recorded 12 rejected
UDP packets and three rejected direct TCP/7881 packets. Those are local bridge
measurements, not external-network or hardware quality results.

The initial two-person proof does not cover four people, real microphones/screens/cameras,
14–16px receiver text, real weak-link loss/jitter, or Android/iOS devices.
The later four-person synthetic-screen proof below extends only the local
media and text evidence. The remaining conditions are tracked in
[#63](https://github.com/ColdPhase/flux/issues/63).

## Receiver quality measurement slice

[`receiver-quality.ts`](../../app/apps/web/src/live/receiver-quality.ts) reads
receiver `getStats()` samples: selected ICE round-trip time; inbound audio/video
packets, interval bitrate and loss; audio jitter; and decoded video fps and
dimensions. A counter reset, absent report or short interval without fresh
packets is unknown, never fabricated as zero loss or good throughput. An
expected receiver with no new packets over a sampled interval of at least 1.5
seconds (the diagnostics panel samples every two seconds, and its interval timer
can fire a few milliseconds early) is poor even if its cumulative packet count
and ICE round-trip time look healthy. The
module returns specific warning reasons for
the live interface in [#62](https://github.com/ColdPhase/flux/issues/62) to
present on demand. #62's integrated LivePanel already displays diagnostics and
LiveStage provides selected-screen Fit/1:1/zoom. The #63 calibration slice now
uses the same receiver interval reader/classifier in those diagnostic rows;
missing samples and counter resets remain unknown. Intentional quiet/hidden
track pauses do not warn as failed expected media flow.

These **provisional diagnostic thresholds** are test gates, not release quality
promises. Peer calibration against receiver recordings and real links is still
required before the final #63 acceptance run:

| Receiver metric | Warning | Poor |
| --- | ---: | ---: |
| Selected ICE round-trip time | >300 ms | >600 ms |
| Audio jitter | >30 ms | >80 ms |
| Interval audio/video packet loss | >3% | >10% |
| Decoded video frame rate, when receiving video | <10 fps | <5 fps |
| Expected receiver track with no fresh packets | — | ≥2 seconds |

The restrictive Docker test adds a fixed 450 ms outbound delay with `tc netem`
**after** both receivers connect. It checks that real received audio and video
remain visible in `getStats()` and that the measured RTT crosses the
warning threshold. A constant delay is reproducible but does not emulate
random loss, jitter, weak radio, device switching or screen readability.
Those need separate profiles and real receivers.

**Observed 2026-09-28, isolated Docker rerun:**
`./scripts/check_live_turn.sh` exited 0 (1/1). Before impairment, receiver
audio was 97.8 kbps, 2 ms jitter and 0% interval loss; decoded video was
640×360 at 16 fps and 73.1 kbps. With a fixed 450 ms client outbound delay,
selected ICE RTT measured 450 ms, audio continued at 88.7 kbps, and decoded
video continued at 320×180, 10 fps and 40.7 kbps. The classifier returned
`warning` with “Network round trip 450 ms”. Both browsers still selected
TURN/TLS relay candidate pairs; the client firewall rejected 60 UDP packets
and three direct TCP/7881 packets. These values are one local synthetic-media
observation, not code-text readability or network/device acceptance.

The same two-client test also applies a second `tc netem` profile after the
fixed-delay phase has cleared: 350 ms mean delay with 80 ms variation and
15% configured random outbound packet loss. The installed `iproute2` cannot
seed the random sequence. Reproduction therefore fixes the parameters and
checks the observed kernel drop counter, receiver warning/degradation and
recovery, not an exact count, percentage or bitrate. TURN/TLS uses TCP on the
client hop: TCP retransmission can turn a dropped network packet into delay
without incrementing receiver RTP `packetsLost`. The test removes the qdisc,
then requires fresh audio RTP, fresh decoded video frames and selected ICE RTT
below the warning threshold. This is a bounded local recovery observation;
it does not measure real Wi-Fi loss, microphone intelligibility or external
NAT behavior.

**Observed 2026-09-28, final local Docker rerun:**
`./scripts/check_live_turn.sh` exited 0 (2/2 E2E and full Compose cleanup).
The first fixed-delay phase warned at 450 ms selected ICE RTT. A clean sample
between profiles returned to 0 ms RTT and decoded nine video frames in one
second. Under the 350±80 ms/15% random-loss profile, `tc -s qdisc` recorded
19 dropped outbound packets. The receiver measured 304 ms selected ICE RTT,
37 ms audio jitter and 7.2 decoded video frames/s, yielding `warning` with
specific RTT, jitter and video reasons. RTP interval loss remained 0%; this
does not contradict the network drop counter because the client used TURN/TLS
over TCP. After removing the profile, within about 2.0 seconds the receiver
measured 0 ms RTT, fresh audio packets and 16 newly decoded video frames in a
one-second sample. The selected pair remained a TLS relay candidate. These
are one local generated-media observation, not quality targets or a promise
of recovery timing on other links/devices.

## Four-person, two-screen local evidence

**Observed 2026-09-28, isolated Docker rerun:**
`./scripts/check_live_turn.sh` exited 0 (2/2 E2E, full Compose cleanup).
Four authorized Chromium clients joined the same LiveKit room under the
restrictive firewall. Two participants published separate 960×540, 10 fps
canvas screen tracks containing 12 lines each of code and release checklist
text in 16 px monospace; one also published generated audio. Both observers
decoded both screens at 960×540 and displayed them at 960×540 (1:1), with
fresh packets for both video tracks and audio over a two-second interval.
All four clients selected `relay` candidates with `relayProtocol=tls`.
OpenSSL verified the test TURN certificate hostname/SNI. The two full-page
receiver screenshots are retained at
[viewer 3](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/development/evidence/live-turn/receiver-3.png) and
[viewer 4](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/development/evidence/live-turn/receiver-4.png).

At the measured observer samples, both videos decoded at 10 fps with 0%
interval packet loss; received audio was about 98.8 kbps with 0 ms reported
jitter and 0% interval loss. The screenshot text is visually readable at
original pixels, but the publishers use `canvas.captureStream()` marked as
`screen_share`, not browser `getDisplayMedia()`. This is desktop Chromium on a
local Docker bridge. It is not evidence that #62's final screen-selection/zoom UI,
real device capture, tablets, or external restricted networks
meet #63's acceptance criteria. The existing integrated diagnostic surface is now wired to the shared
receiver measurement/classifier by #63; release quality calibration remains open.

## High-resolution calibration

Select `FLUX_LIVE_TURN_PROFILE=code-1440p ./scripts/check_live_turn.sh` for the
bounded [1440p code calibration protocol](live-code-calibration.md). The default
`legacy` profile preserves the earlier cases. Both profiles also run the current
revocation and sign-out regressions and receiver/diagnostic units. See that
protocol for source kinds, production publish settings, raw frame audit and
remaining acceptance limits.
The [dated high-resolution checkpoint](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/development/evidence/live-turn/2026-09-30-code/README.md)
contains actual two/four-peer decoded dimensions and frame intervals, original
pixels and resource windows, with production/harness pins and retained failures.
Raw receiver reports now supply the existing audio/video diagnostic rows;
the locked SDK audio projection's missing packet fields are not synthesized.

## Platform rows and direct-path DTLS (#63 AC-3, AC-4; 2026-10-10)

Scope: emulated browser rows and a direct-path DTLS assertion in Docker. No
physical device, public host, real network or receiver-quality
calibration is covered here; those remain open in #63.

### Direct-path DTLS

`app/tests/app/e2e/live-sfu-direct-dtls.e2e.ts` runs in `check_live_sfu.sh`
(listed in the `live-sfu-test` command of `docker/compose.live.test.yaml`). Two
authorized Chromium clients reach the pinned SFU on its own ICE candidates with
no UDP restriction. The positive case waits for real RTP (owner outbound RTP
bytes and member inbound RTP packets), then requires every selected pair to be
a non-relay candidate with no `relayProtocol`, and every transport that carried
RTP to complete DTLS with the signalled fingerprint (`dtlsSrtpViolations`). The
negative control tampers with the signalled fingerprint on the same path; DTLS
fails and no RTP is received. Candidate-pair byte counts are not used as media
evidence: they include non-RTP DTLS traffic (a first attempt failed on exactly
that and was corrected).

Observed 2026-10-10, `./scripts/check_live_sfu.sh` with
`FLUX_LIVE_TEST_PORT=19235` and the ICE ports `19236`–`19238`:

```
✔ direct path: both clients complete DTLS-SRTP with the signalled certificate on a non-relay pair (3336.701293ms)
✔ negative control, direct path: a tampered SFU fingerprint fails DTLS and carries no media (16112.746674ms)
✔ Flux revocation retires the real SFU room, rejects original and refreshed grants, and rejoins a remaining member (2586.189335ms)
✔ sign-out ends the signed-out session media, refuses its grants at the gate and leaves others connected (13203.638423ms)
✔ reconciliation retires a participant connected with a pre-#128 grant and keeps an admitted one (24019.098677ms)
✔ real SFU restart rotates a lost room; old original and refreshed tokens remain unusable (8111.323545ms)
```

Not covered: Firefox or WebKit DTLS, TURN-credential residual risk, and any
run on the real host.

### Emulated platform rows

`app/tests/ui/test_live_platforms.py` is LIVE-only. Run it with
`FLUX_LIVE_UI_PATTERN=test_live_platforms.py ./scripts/check_live_ui.sh` and
the `FLUX_LIVE_UI_*` ports (UI, mailpit, ICE TCP, ICE UDP and TURN UDP; all five must be set, distinct). Each row joins a session that a
desktop Chromium participant starts. Engines come from the pinned Playwright
image `mcr.microsoft.com/playwright/python:v1.62.0-noble`, which ships Chromium,
Firefox and WebKit.

Capability sources, checked 2026-10-10:

- [MDN browser-compat-data, `api/MediaDevices.json`](https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json)
  (the file carries no date): `getDisplayMedia` is unsupported in `chrome_android`,
  `firefox_android` and `safari_ios`, and supported in `chrome`, `firefox` and `safari`.
- Observed in the engines (probe in the same image, before any emulation):
  `navigator.mediaDevices.getDisplayMedia` is a function in Chromium 151.0.7922.34,
  Firefox 153.0 and WebKit 26.5 even under device emulation. Playwright's Linux builds
  do not reproduce the mobile limit, so each mobile row removes the function explicitly.
  The result is a documented capability state, not a device.

Result of the final run on the committed test file (`Ran 4 tests in 60.520s`, `OK`, 2026-10-10):

| Row | Engine (version) | Device profile | Before → after emulation | Received host screen (decoded width) | Camera denial | Microphone track level |
| --- | --- | --- | --- | --- | --- | --- |
| Android Chrome | Chromium 151.0.7922.34 | Pixel 7 descriptor (mobile, touch) | function → undefined | 2560 | verified: instrumented call; strip reads "blocked by the browser" | instrumented, live |
| Android Firefox | Firefox 153.0 | Pixel 7 viewport and user agent; no touch (`maxTouchPoints` 0, `coarsePointer` false); no `is_mobile` | function → undefined | 2560 | verified (same) | instrumented, live |
| iPhone Safari | WebKit 26.5 | iPhone 13 | function → undefined | 2560 | verified: the prototype hook counts the call | instrumented, live |
| iPad Safari | WebKit 26.5 | iPad (gen 7), tablet layout | function → undefined | 2560 | verified (same) | instrumented, live |

Every row also checks: no screen-share control in the strip; the session panel
says "This browser cannot share its screen"; microphone publishes; the desktop
host's shared screen decodes; "Back to work" and the camera control are reached
by a pointer click (Playwright's hit-target check, no fallback); a viewport
rotation keeps the session with no horizontal overflow; a dispatched
`visibilitychange` keeps the session; the row leaves. The rotation and visibility
steps are a viewport change and a dispatched event, not an operating-system
rotation or suspension.

Capture counts are observed before they are used. `INSTRUMENT` (instance hook,
`test_live_sessions.py`) and `PROTOTYPE_INSTRUMENT` (on `MediaDevices.prototype`,
which WebKit's capture calls reach) write the same counters. Each row asserts that
its denied camera request was counted (`0 → 1`) and that at least two captures
were counted before the rotation step, so the "no new capture" equality compares
real counters.

Negative controls on this test file (2026-10-10):

- (a) Prototype hook removed. Android Chrome and Android Firefox pass; both WebKit
  rows fail at `0 not greater than 0 : the camera request reached the instrumented
  getUserMedia` (`Ran 4 tests in 75.545s`, `FAILED (failures=2)`).
- (b) A real `getUserMedia({ audio: true })` injected between the before and after
  readings. All four rows fail at `3 != 2 : rotation and visibility return request
  no capture` (`Ran 4 tests in 79.988s`, `FAILED (failures=4)`).
- Earlier, on the pre-merge head `cec9cf43` and not rerun on the merged head:
  `canPublishScreen()` forced to return `true` (temporary edit to
  `app/apps/web/src/live/capture.ts`, reverted with git) gave `Ran 4 tests in
  130.891s`, `FAILED (failures=4)`.

Firefox join. The Join → Live wait passed in each of six runs here, including one
with Firefox first on a fresh stack (`Ran 4 tests in 70.839s`, `OK`). A reviewer's
run on another host reported the same wait failing. That host's log is not
available here, so the failure is not reproduced in this harness and is not
classified. The row now writes `joinDiagnostics` (region text, sockets and their
states, console and page errors) into `live-platform-rows.json` when the wait
fails, so a recurrence can be classified. Firefox is verified in this harness
only.

Findings from the review, status on the merged head:

1. **Stage "Back to work" by pointer.** Reachable in all four rows at 412, 390 and
   810 px after main's stacking change to `live.css` (see the next section). The
   test now requires the pointer click; the earlier Escape fallback is removed.
2. **Tablet camera control.** Reachable by pointer on the iPad row after the same
   change. The DOM-click fallback is removed.
3. **WebKit camera denial.** Verified through `PROTOTYPE_INSTRUMENT`. Negative
   control (a) shows the instance hook alone records nothing in WebKit.
4. **WebKit microphone track.** Verified through `PROTOTYPE_INSTRUMENT`
   (`liveMicrophoneTracksInstrumented` 1 and live in both WebKit rows).

Not covered by these rows: physical devices (optional under
[#266](https://github.com/ColdPhase/flux/issues/266) item 10); real lock, background
or suspension; headphone and Bluetooth changes (`devicechange` is not dispatched);
offline and rejoin (Playwright's `set_offline` does not cut WebRTC UDP, so no media
cut is claimed); service-worker update; the desktop Fedora/Wayland, Windows and
macOS rows; real screen publication in Firefox or WebKit; system audio; the
reviewer's Firefox join failure (above). Playwright's Firefox does not emulate
`is_mobile` or touch, so the Firefox row is viewport and user agent only.

## Device change, update reload and rejoin on the platform rows (#63 AC-3; 2026-10-30)

`test_live_platforms.py` now covers three more steps in each of the four emulated rows
(Android Chrome, Android Firefox, iPhone Safari, iPad Safari), after the rotation and
visibility checks:

- **Headphones or a Bluetooth headset.** The test dispatches `devicechange` on
  `navigator.mediaDevices`. The session stays Live, the microphone stays on, and no capture
  is requested. No device actually changes, so this shows only that the event alone does
  not end the session, mute or reacquire. A real device switch is **device** only.
- **A Flux update.** Applying an update reloads the page once (`UpdatePrompt` → Reload,
  `pwa/register.ts`), so the test reloads. The reloaded page requests no capture (0 camera
  or microphone calls) and shows no microphone on. **Join** returns the person to the open
  session. A control on the same reloaded page shows its counters work: turning the
  microphone on counts a capture.
- **Rejoin.** Join after the reload reaches Live again with the host still sharing.

Observed 2026-10-30 at this branch, with Playwright 1.62 engines (Chromium 151.0.7922.34,
Firefox 153.0, WebKit 26.5). The command was
`FLUX_LIVE_UI_PATTERN=test_live_platforms.py ./scripts/check_live_ui.sh` with
`FLUX_LIVE_UI_*` ports 34120–34124, and the result was `Ran 4 tests in 81.435s`, `OK`.

Still not covered on these rows:

- network loss and recovery of the media path (Playwright's offline mode does not cut
  WebRTC; the SFU restart is covered by `live-sfu-restart.e2e.ts`);
- the Windows, macOS and Fedora/Wayland desktop rows in Firefox and WebKit;
- real screen publication outside Chromium;
- system audio;
- the public host.

## Simulated public host (#63, 2026-10-30)

Under the [founder direction of 2026-10-30](#founder-direction-2026-10-30-a-simulated-public-host),
`./scripts/check_public_sim.sh` builds a public self-hosted install in Docker and drives the real Flux web app
through it from browsers that can reach only the public side. Files: [`docker/public-sim/`](../../docker/public-sim/)
(Compose overlay, routers, DNS, Caddyfile, client image and the driver) and the script. It is a heavy local check
(about 10 minutes, one at a time: its subnets are fixed), not a PR Action.

### Topology

| Piece | Simulated as | Faithful to |
| --- | --- | --- |
| The Internet | Docker network `203.0.113.0/24` (TEST-NET-3), `internal`: no route to the host or the real Internet | A public network between people and the server |
| DNS | dnsmasq at `203.0.113.53`, the only resolver of every client and of the driver: `flux.sim.test` → `203.0.113.10`, `turn.sim.test` → `203.0.113.20`, nothing else | The operator's A records |
| TLS | One local CA signs `flux.sim.test` and `turn.sim.test`. Clients install only the CA certificate: Chromium's NSS database, the system store (WebKit pages, Node) and, since 2026-10-31, each Firefox profile's certificate database (`firefox-ca`). WebKit's TURN/TLS cannot be given it ([platform rows](#platform-rows-over-the-simulation-ac-3)) | A publicly trusted certificate (**not** ACME: no issuance is tested) |
| Flux origin | Caddy 2.11.7 at `203.0.113.10:443`, the [documented whole-origin proxy](../operations/reverse-proxy.md#public-hostname-and-streaming), `FLUX_PUBLIC_ORIGIN=https://flux.sim.test`, `FLUX_TRUSTED_PROXIES` set to the proxy's one address | The operator's reverse proxy |
| Media | The operator layers unchanged: `compose.source.yaml`, `compose.live.yaml`, `compose.live.turn.yaml`. LiveKit holds `203.0.113.20` itself (`node_ip`), with TURN/TLS on TCP/443, TURN/UDP on 3478 and ICE on 7881/7882; no host ports are published | A media host with its own public address, as the TURN overlay requires. A Docker port-forwarded SFU is **not** simulated |
| Restrictive client network | `10.213.1.0/24` behind router A: NAT (masquerade); only TCP/443 and DNS to the resolver leave | A strict office or hotel network |
| Open client network | `10.213.2.0/24` behind router B: NAT, everything leaves | A home router |
| People | One Playwright 1.62 server per client network (Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5), reachable by the driver only through its router's forwarded TCP/3000 | A person's computer |

The script first checks the public side: both names resolve, `curl` reaches `/api/v1/health` through Caddy with the
CA, `openssl` verifies TURN/TLS 1.3 for `turn.sim.test`, client A cannot open TCP/7881 and resolves no internal
name, and client B cannot reach the proxy's internal network. The API logged requests from `203.0.113.101` and
`203.0.113.102`, the routers' public addresses, so the trusted-proxy setting resolves the real client address.

### What the browsers do

Ada (behind router A) opens a wiki page, chooses **Together** and turns her microphone and camera on; Jonas (behind
router B) chooses **Join** and turns his microphone on. The driver reads `getStats()` from every peer connection the
page creates. Then, per run: a 15-second cut of every path through router A, `tc netem` delay 40 ± 20 ms with 5 %
loss both ways at each router for 20 s, a restart of the SFU container, a restart of the API container, and the
one receiver on a slow lossy link (400 kbit/s, 60 ms, 3 % loss), and the access checks. A person's actions are the app's buttons only; after a reconnect that left a device off, the driver
presses the microphone button again, as the app asks.

### Observed 2026-10-30

`./scripts/check_public_sim.sh` exited 0 at `4ca85493e` (seven runs; load average 15 before, 23 after) and again at
`2d57e7dba` with the weak-receiver phase added (seven runs, 6 min 17 s; load average 1 before, 17 after). The figures
below are from the first; the second agreed within 1.1 s on every timing (join 2.9 to 4.0 s, drop recovery 1.0 to
1.5 s, Live 1.8 to 3.1 s, SFU restart Live in 20.2 s). Linux x86_64 host shared with other agents' Docker work. Ada is always behind the restrictive router A, Jonas behind the open router B.

| Case | Ada (A) / Jonas (B) | Result |
| --- | --- | --- |
| Join through the restrictive network | Chromium / Chromium | Audio both ways 2.9 to 3.0 s after **Together**. Ada's selected pair: local `relay`, `relayProtocol=tls`, from `turns:turn.sim.test:443?transport=tcp`, to the SFU's `host` 203.0.113.20:7882 |
| Join through the open network | same | Jonas's pair: local `prflx` 203.0.113.102 (his router's public address), direct UDP to 203.0.113.20:7882, no relay |
| Network drop, 15 s | same | Ada's bar said "Reconnecting…" during the cut. Media flowed again **1.8 s** after the path came back and both bars said Live after 3.1 s, with no action |
| 5 % loss, 40 ± 20 ms, over TURN/TLS | same | 0 RTP packets lost (TCP retransmits on the TLS hop; the counter even moved back by 6), audio jitter up to 15 ms, selected-pair RTT 293 ms; audio continued |
| 5 % loss, 40 ± 20 ms, direct UDP | same | Audio 35 of 945 packets lost (3.7 %), video 24 of 473, 374 frames decoded in 20 s, jitter 11 ms, RTT 102 ms; audio and video continued |
| One weak receiver | Chromium / Chromium, separate run of `connect,weak` at this branch, exit 0 | Jonas's link at 400 kbit/s, 60 ms, 3 % loss both ways while Ada sends camera and microphone. Jonas received audio at 72 kbit/s with 1.7 % loss (74.8 kbit/s, 0 % before) and Ada's camera at 10 fps instead of 20, 3.7 % loss, still 320×180 (the size the app asks for with the camera stage closed); his bar stayed Live. Ada kept sending at 224 kbit/s (222 before). She heard Jonas with 3.3 % loss, his own impaired uplink. Six seconds after the link was restored, Jonas received 154 kbit/s of video with no loss |
| SFU restart | same | No media flowed by itself. Both bars said Live again after **20.2 s** (the app rejoined a new room) with microphone and camera off, as designed: "Reconnected. Your microphone, camera and screen stay off until you turn them on." Audio flowed 0.5 s after the microphone was turned on again |
| API restart | same | Media never stopped (the SFU path does not pass through the API); both bars said "Reconnecting…" and were Live again 2.0 s after the API was healthy |
| Outsider | every run with access | Lee, a workspace member without access to the project: the project's live sessions and the join both answered `404 PROJECT_NOT_FOUND` |
| Access removed during the call | Chromium, WebKit or Firefox as Jonas | Ada set Jonas's grant to `denied`: his peer connections closed **0.09 to 1.21 s** later; his join and list answered 404 |
| Issued-token replay | same | Jonas's join token, captured from the app's own join, at the public gate after removal: `/media/rtc/validate` 401, the WebSocket refused |
| AI and processors | same | The session's participants were the two people only; the stack has no egress, ingress or agent service (checked from `docker compose config --services`) |
| WebKit 26.5 on the open network | Chromium / WebKit | Joined in 4.5 s, direct UDP (`srflx` 203.0.113.102); after the 15 s drop, media in 2.0 s and Live in 3.1 s |
| Firefox 153.0 on the open network | Chromium / Firefox | Joined in 3.1 s, direct UDP (`prflx`; Firefox redacts the address); after the drop, media in 1.3 s and Live in 2.6 s |
| WebKit behind router A with TURN/UDP allowed | WebKit / Chromium | Relayed: local `relay` from `turn:203.0.113.20:3478` (WebKit reports no `relayProtocol`); joined in 3.6 s; after the drop, media in 2.3 s and Live in 3.3 s |
| Firefox behind router A with TURN/UDP allowed | Firefox / Chromium | Relayed: local `relay`, `relayProtocol=udp`; joined in 4.7 s; after the drop, media in 1.5 s and Live in 2.3 s |
| WebKit or Firefox behind router A, TURN/TLS only | development run `engines1` | **Not passed, not counted.** Firefox reported ICE error 701 for `turns:turn.sim.test:443` 16 ms after it began; WebKit gathered no relay candidate. Router A counted one TCP connection from each to 203.0.113.20:443. Neither browser can be made to trust the simulation's CA here: Playwright's Firefox ignored `policies.json` (next to its binary and in `/etc/firefox/policies`) and the enterprise-roots preferences, and loaded pages only with certificate errors ignored; WebKit trusts the system store for pages, but its TURN client evidently does not use it. **Inference, not verified:** with a publicly trusted certificate both would relay over TLS as Chromium does. *Superseded 2026-10-31:* Firefox relays over TLS with the CA in its profile; WebKit's TURN/TLS checks only libwebrtc's compiled-in roots ([platform rows](#platform-rows-over-the-simulation-ac-3)) |

Not measured on 30 October, added on 31 October in [the next section](#measured-profiles-platforms-and-operations-on-the-simulated-public-host-63-2026-10-31):
refreshed tokens, CPU, memory and egress of the SFU, four people, screens, and quality at the receiver.

### Two defects the simulation found, both fixed in this change

1. **The operator media profile could not relay on a multi-homed SFU.** LiveKit maps every local interface to
   `node_ip` and keeps one socket per address; it answered TURN-relayed checks from its signaling interface
   (`192.168.x`), so the TURN server dropped them ("No Permission or Channel exists for 192.168.112.2:7882") and
   every relayed join failed. The Compose test overlay had worked around it with `rtc.ips.includes`; the operator
   layers had not. `compose.live.yaml` and `compose.live.turn.yaml` now take `FLUX_LIVEKIT_MEDIA_CIDR` (default
   `0.0.0.0/0`, the old behaviour); the simulation sets `203.0.113.20/32`. Whether a Docker port-forwarded SFU
   needs more than this is not simulated; host networking or a dedicated media address is the documented topology.
2. **WebKit refused LiveKit's TURN URLs.** Playwright's WebKit 26.5 throws "SyntaxError: Invalid TURN URL query
   string" for any TURN URL with `?transport=`, which LiveKit always sends, so a WebKit person could not join any
   deployment with TURN. The app now drops `?transport=udp` from `turn:` and `?transport=tcp` from `turns:` URLs,
   the transports [RFC 7065 §3](https://www.rfc-editor.org/rfc/rfc7065#section-3) gives them by default, before
   they reach `RTCPeerConnection` (`app/apps/web/src/live/ice-servers.ts`). Whether shipping Safari has the same
   check was not verified (no Apple device); the change is correct either way.

## Measured profiles, platforms and operations on the simulated public host (#63, 2026-10-31)

Same simulation, extended in [`docker/public-sim/`](../../docker/public-sim/) (`profiles.py`, `resources.py`,
`screen-source.sh`, `firefox-ca.sh`) and `scripts/check_public_sim.sh`. Two more client computers (C behind router A,
D behind router B) carry the third and fourth person. Every client has synthetic media made at start: a
1920×1080, 30 fps camera file (`testsrc2`, motion over the whole frame), 40 s of continuous synthetic speech
(espeak-ng, 48 kHz), a PulseAudio microphone playing the same speech, and an X display (1920×1080) that
`screen-source` fills with a moving pattern. A presenter's browser runs headed on that display with its window
off-screen and shares it through the app's own **Share a window, tab or screen** button: real `getDisplayMedia`,
not Chromium's fake display (Xvfb runs without RandR, because Chromium's X11 capturer otherwise refuses the
"Entire screen" source).

### Measured profiles and calibrated thresholds (AC-2)

Phase `profiles`, with two people (Ada behind router A over TURN/TLS, Jonas behind router B, direct UDP) and then
four (Mia also behind A and sharing a second screen, Tom behind B and only receiving). Every window is 15 s of
`getStats()` deltas at every receiver and sender; each inbound video track is mapped to the element showing it
(its accessible name says whose screen or camera). Latency is an **estimate**: half the selected pair's RTT plus the
jitter-buffer delay per emitted sample; it is not glass-to-glass. Windows: speech and camera; motion (Ada shares
`testsrc2` at 1920×1080, 60 fps); with four people, two simultaneous shares (Tom watches Ada's, Jonas Mia's);
1:1 on the receiver's stage; with four people, Tom alone at 400 kbit/s, 60 ms, 3 % loss both ways (router B, his
address only), then 8 s after the link returns; last, 5 % loss with 40 ± 20 ms both ways at router A (the weak
window runs first so that the loss window's after-effects on the TCP relay do not confound it).

**Calibration.** Three runs with `FLUX_SIM_CALIBRATE=1` (record only) on 2026-10-31, at the branch, on a Linux host
shared with other agents' Docker work (load average 7 to 15). The thresholds below sit outside every calibration
observation with margin; they are gates for this simulation that catch regressions, not promises for other
networks or devices. They are enforced by default (`profiles.THRESHOLDS`). Peer review of the thresholds is
**not** done (no independent evaluator in this session).

**Enforced runs (2026-10-31).** `./scripts/check_public_sim.sh` with the default runs at `67083f94d` (17 runs): 15
passed, including the two-person profiles (46 checks, no failure); the four-person profiles failed on gates that the
following commit changed (capture fps 20 under load; speech behind the lossy router; others' frame rate in a weak
window that followed the loss window), and the Firefox screen run measured before the receiver had decoded a frame.
At `5c2163113` the four-person profiles (156 checks), the two-person profiles (44 checks) and
the Firefox screen run passed (`FLUX_SIM_RUNS` with those three runs, exit 0).

| Profile | Observed in calibration (2 / 4 people) | Threshold (fails the check when not met) |
| --- | --- | --- |
| Speech, clean, every receiver and track | 55 to 95 kbit/s; 0 % loss; concealed 0 % (two) and up to 2.05 % (four, with two shares); jitter ≤ 1 ms; latency estimate 18 to 152 ms | ≥ 20 kbit/s, ≤ 1 % loss, ≤ 3 % concealed, ≤ 30 ms jitter, ≤ 500 ms (250 ms until a later calibration run measured 410 ms in a clean window), speech energy present |
| Camera (Jonas, 1920×1080 30 fps source) | The app captures 1280×720 at 30 fps. The camera stage shows tiles (284 px wide at 1440×900), so automatic quality sends the 320×180 layer: 17.6 to 20 fps, up to 1.92 s frozen per 15 s with four people | Receiver ≥ 180 rows, ≥ 12 fps, ≤ 3 s frozen, ≤ 1 % loss; capture ≥ 1080 rows (720 before cameras captured 1080p) at ≥ 15 fps (sender `media-source`; the first enforced four-person run measured 20 fps there, Chromium lowering capture under load) |
| Motion screen (1920×1080, 60 fps source) | Received 1920×1080 at 8.9 to 10.6 fps (Chromium sender, target bitrate 3.5 Mbit/s, no quality limitation reported), 12.1 fps for the second share; up to 2.8 s frozen with four people; latency estimate ≤ 79 ms. A Firefox sender reached 15 fps (the app's cap) | ≥ 1080 rows, ≥ 7 fps, ≤ 4 s frozen, ≤ 1 % loss, ≤ 400 ms |
| 1:1 | The stage shows the received 1920 px at 1920 display pixels | shown width = received width |
| 5 % loss, 40 ± 20 ms, at the presenters' router | TURN/TLS turns loss into delay: no RTP loss at receivers on the clean network, speech concealed 0 to 5.7 %, latency estimate 0.4 to 1.7 s; the screen keeps 1920×1080 but falls to 1.0 to 2.6 fps with 3 to 12 s frozen. Behind the lossy router itself, Mia's received speech was 2.8 to 3 % concealed in one run and **51 to 58 %** in the next | Receivers outside router A: speech ≤ 15 % concealed (12 % until a later calibration run measured 12.5 %) and ≥ 16 kbit/s; screen ≥ 1080 rows and ≥ 0.5 fps. What people behind the lossy router receive is recorded, not gated |
| One weak receiver of four | Tom: best speech track 11.5 to 48 kbit/s with up to 29 % concealed; Ada's screen about 0.5 fps (it is one 1080p layer, maintain-resolution, so the SFU cannot thin it for him). With the weak window first (enforced run): Ada sent at 134 % of her clean frame rate, the others received 100 to 103 % of theirs with no concealment. In calibration, where the weak window followed the loss window, the others received 57 to 59 %. 8 s after the link returned Tom received the screen at 14.8 to 15 fps | Ada's sending ≥ 80 % of clean; others ≥ 50 % of clean fps and ≤ 3 % concealed; Tom's speech ≥ 10 kbit/s; Tom ≥ 5 fps after |
| Smooth motion (later, 2026-10-31) | 1280×720 at 59.5 to 59.7 fps of a 1920×1080, 60 fps capture; ≤ 2 ms latency estimate ([details](#smooth-motion-ac-2-motion-profile)) | ≥ 720 rows, ≥ 45 fps, ≤ 2 s frozen, ≤ 1 % loss, ≤ 300 ms |
| Camera shown large (later, 2026-10-31) | 1920×1080 at 29.7 to 30.1 fps ([details](#a-larger-camera-ac-2-camera-profile)) | ≥ 1080 rows, ≥ 20 fps, ≤ 2 s frozen, ≤ 1 % loss |

What the thresholds do **not** claim, from the same data:

- **Motion at 60 fps is not met.** The app captures screens at up to 15 fps (`media.ts`, chosen for code
  readability), and in this environment Chromium's software capture and encoding delivered 9 to 12 fps. Reaching
  the #59 starting target needs a product decision (a motion mode or content-dependent frame rate), not a test change.
  *Later the same day:* [Smooth motion](#smooth-motion-ac-2-motion-profile) delivers 60 fps (at 1280×720).
- **Camera at 1080p is not delivered.** The app captures 1280×720, and the current stage shows cameras as tiles, so
  receivers ask for the smallest layer. #59's "up to 1080p30, smaller for thumbnails" holds only in its second half.
  *Later the same day:* cameras capture 1080p30 and [a camera shown large](#a-larger-camera-ac-2-camera-profile)
  arrives at 1920×1080 and 30 fps.
- **Loss on the TCP relay is a slideshow, and can silence the people behind it.** A person whose own network loses
  5 % over TURN/TLS heard up to 58 % of the others' speech concealed in one run. Over TURN/TLS, 5 % loss gives a screen at 1 to 3 fps and audio up to
  1.7 s late; after the loss ends the jitter-buffer delay stayed high for the rest of the run (0.2 to 1.2 s on
  tracks relayed from router A). Direct UDP under the same profile (30 October) kept frames flowing.
- **One weak receiver loses the screen.** Screens are a single 1080p layer, so a 400 kbit/s receiver gets about
  0.5 fps of it; speech stays intelligible with gaps (up to 29 % concealed).
- One weak receiver does not slow the others: with the weak window first, everyone else kept their clean frame rate
  and speech. The 40 % drop seen in calibration came with the weak window right after the loss window on Ada's
  and Mia's TCP relay (Mia's own sending fell from 12 to 7 fps on an untouched network); the order now keeps them apart.
- Tom's best speech track was 11.5 kbit/s in the enforced run against a 10 kbit/s gate: a narrow margin.

Resources (`resources.jsonl`, `docker stats` every ~4 s; `resources-summary.json` per window). In the four-person
two-share window the SFU used 7.8 % CPU on average (9.7 to 11.3 % peak, one core = 100 %), 80 to 83 MB memory, and
sent 9.1 to 9.4 Mbit/s to the four people while receiving 4.3 to 4.6 Mbit/s (two runs); two people with one share: 4.5 %, 64 MB, 2.5 Mbit/s out.
The API, which carries every person's signalling WebSocket through the `/media` gate, used 7 to 11 % CPU and
300 MB. These are local container figures, not a capacity.

### Platform rows over the simulation (AC-3)

| Row | Run | Result (2026-10-31) |
| --- | --- | --- |
| **Firefox 153.0 behind router A, TURN/TLS only** | `firefox:chromium:connect,drop,access` | **Relayed over TLS** (`relayProtocol=tls` from `turns:turn.sim.test:443`); drop recovery (two runs): media 1.5 to 1.8 s, Live 2.3 s; access removal closed its connections in 0.07 to 0.09 s. The CA is now in Firefox's trust store: `firefox-ca` imports it into the fresh profile's certificate database with `certutil` (as Settings → Certificates → Import does) before Firefox starts. Firefox pages no longer ignore certificate errors |
| **WebKit 26.5 behind router A, TURN/TLS only** | `webkit:chromium:turn-tls-probe` | **Unattainable in software here.** WebKit sends a TLS ClientHello to turn.sim.test:443 (captured on router A), the SFU answers, WebKit aborts, and LiveKit logs `TLS handshake failed: remote error: tls: unknown certificate authority`. The same with the CA in the system store (which WebKit pages trust) and with the media address added to the certificate (`FLUX_SIM_TURN_IP_SAN=1`). Playwright's Linux WebKit runs WebRTC through libwebrtc with BoringSSL linked in, and its library carries a compiled-in root list (GlobalSign, DigiCert, Baltimore, COMODO, Go Daddy, Starfield, USERTrust names; no ISRG/Let's Encrypt), matching [libwebrtc's `rtc_base/ssl_roots.h`](https://webrtc.googlesource.com/src/+/main/rtc_base/ssl_roots.h) (checked 2026-10-31). **Inference:** its TURN/TLS trusts only that list, so no locally installed root can be tested; whether it accepts a publicly issued certificate depends on that list (a Let's Encrypt chain would likely fail). Safari on Apple platforms uses a different stack and is not covered. WebKit relays over TURN/UDP (below) |
| WebKit 26.5 behind router A with TURN/UDP | `webkit@turn-udp:chromium:connect,drop` | Relayed; drop: media 1.0 s, Live 3.1 to 3.6 s |
| **WebKit 26.5 behind router A with ICE/TCP** (UDP blocked, no TLS) | `webkit@ice-tcp:chromium:connect,drop` | See [WebKit rows, 2026-10-31 (later)](#webkit-rows-2026-10-31-later) |
| **Screen publication in Firefox** | `firefox:chromium:connect,screen` | Ada shared her real X screen through the app's button; Jonas received 1920×1080 at 15.0 fps, 2.4 Mbit/s (Firefox's own "You are sharing your entire screen" bar is visible in the received frame) |
| **Screen publication in WebKit** (superseded 2026-10-31, below) | `webkit@turn-udp:chromium:connect,screen` | First observed as unattainable: headless WebKit rejects `getDisplayMedia` (`NotAllowedError`), and under Xvfb the call never settled. The later finding: headed, WebKit was waiting for its own prompt, not for a desktop portal. See [WebKit rows, 2026-10-31 (later)](#webkit-rows-2026-10-31-later) |
| **Media-path loss on phone rows** | `chromium+pixel7:chromium:connect,drop` (Android Chrome emulation, TURN/TLS), `webkit+iphone13@turn-udp:chromium:connect,drop` (iPhone emulation, TURN/UDP) | 15 s cut of every path through router A: media back by itself in 1.0 to 1.8 s (Pixel 7) and 1.0 to 2.0 s (iPhone 13); the phone strip shows Live again (its status word is for assistive technology only on a phone) |
| iPad (WebKit) on the open network | `chromium:webkit+ipad:connect,access` | Joined in 3.1 s; access removal closed its connections in 0.14 to 0.15 s; issued and refreshed tokens refused |

### Operations and access (AC-1, AC-4)

- **SFU update and rollback** (`sfu-update`): with a call in progress the SFU was recreated on the candidate
  `livekit/livekit-server:v1.13.11` (digest `25cd902d…`), then rolled back to the pinned v1.13.7 digest, as the
  [Compose deployment](#compose-deployment) section describes. Each step (two runs): Live again after 20.0 to 20.2 s (the app
  rejoins a new room), microphones off as designed, audio 0.5 s after the person turned it on. The Flux API image
  is updated and rolled back by [docs/operations/upgrade.md](../operations/upgrade.md) and its own check; here an
  API restart left media flowing (1.0 s) and both bars Live in 3.3 s.
- **Refreshed-token replay**: the driver keeps every JWT the SFU sends over the signalling WebSocket (LiveKit's
  refresh). In every `access` run (Chromium, Firefox, WebKit, iPad) a refreshed token for the same room with a later
  expiry was captured; after access was removed both the issued and the refreshed token were refused at the public
  gate (`/media/rtc/validate` 401, WebSocket refused).
- **A call with workspace AI off** (`ai-off`): Ada turned AI off for the workspace (`PUT …/ai-policy`, state
  `blocked`, version 2) before the call. The call joined over TURN/TLS, audio flowed both ways, recovered from the
  drop, and the session's participants were the two people only.

## Smooth motion, a larger camera and WebKit (#63, 2026-10-31, later)

Founder decision of 2026-10-31: finish the rest of #63 before the release. Product details are agent decisions
within Prostota, recorded in [live collaboration §7](../product/live-collaboration.md#7-quality-that-can-be-checked).

### Smooth motion (AC-2 motion profile)

While sharing, the sharing line under the strip ("You are sharing your screen…") offers **Sharp text · Smooth
motion** (a radio group; arrow keys move it; the choice is remembered for the next share on that browser). Sharp text
is unchanged: up to 2560×1440, 15 fps, 3.5 Mbit/s, one layer that keeps its resolution. Smooth motion captures up to
1920×1080 at 60 fps with `contentHint: motion` and sends **one layer** at up to **10 Mbit/s** that keeps its frame
rate (`maintain-framerate`). Switching publishes the same capture again (no new picker, the receiver's stage keeps the
screen in place; the UI test checks that no second `getDisplayMedia` call happens).

How the settings were chosen, all in `check_public_sim.sh` with the presenter behind router A (TURN/TLS), Chromium
151, its real X screen showing a scrolling SMPTE pattern drawn at a true 60 fps (`screen-source gst:…`; the earlier
ffplay source drew about 30 fps on Xvfb, so no capture could exceed that):

| Smooth motion variant (calibration run) | Captured at the sender | Received (fitted stage, 1440×900) |
| --- | --- | --- |
| Three simulcast layers 640×360 at 15, 1280×720 at 30, 1920×1080 at 60; 6 Mbit/s (`cal5`) | 1920×1080 at 59 to 60 fps | 720p layer at 22 fps; at 1:1 the 1080p layer at **10.4 to 12.2 fps** |
| Two layers 640×360 at 15, 1920×1080 at 60 (`cal6`) | 1920×1080 at 59 to 60 fps | 1080p at **12.5 to 12.7 fps** |
| One layer, 6 Mbit/s (`cal7`) | 1920×1080 at 60 fps | **1280×720 at 59.6 to 59.7 fps**, sender limited by `bandwidth` at the 6 Mbit/s cap |
| One layer, 10 Mbit/s (`cal8`, `full1`; shipped) | 1920×1080 at 59 to 60 fps | **1280×720 at 59.4 to 59.7 fps**, 9.9 Mbit/s, latency estimate ≤ 2 ms, no freeze (two and four people) |
| Sharp text on the same scrolling content (`cal5`) | 1920×1080 at 15 fps | 1920×1080 at 2.6 to 4.3 fps |

A loopback probe outside the app (same image and source, no SFU) encoded one VP8 1080p layer at 59.4 fps; with
three simulcast layers the source itself fell to 15 fps. **Inference:** Chromium's software VP8 encoder handles
simulcast layers far more slowly than one layer, so simulcast would cost Smooth motion its purpose on machines
without a hardware encoder. **Not met:** 1920×1080 *and* 60 fps together at the receiver for a frame that moves
everywhere; at 10 Mbit/s the encoder keeps 60 fps and lowers the resolution to 1280×720 (its own choice under
`maintain-framerate`). The loopback probe reached 1920×1080 at 59 fps at 6 Mbit/s without an SFU, so the size the
encoder picks depends on its rate control in the call, not only on the cap; a real desktop with a hardware encoder
was not available. The thresholds gate what was measured: ≥ 720 rows and ≥ 45 fps.

Cost: one 1080p60 layer has no smaller layer for a weak receiver. With four people and Smooth motion, Tom on
400 kbit/s received 1.6 to 8.5 kbit/s of speech, 84 to 98 % concealed (`cal7`, `cal8`, `full1`); with Sharp text the same
window gave him 8 to 18 kbit/s, 68 to 86 % concealed (`cal4` to `cal8`; the 30 October figure "up to 29 %" did not
recur). The other three people were untouched in both modes (no concealment, clean frame rates). LiveKit's
`congestion_control.allow_pause: true` was tried (`cal8`) and did not change this, so it was not kept. Sharp text
stays the default; Smooth motion is the presenter's explicit choice for a demo.

### A larger camera (AC-2 camera profile)

Cameras capture up to 1920×1080 at 30 fps with LiveKit's default simulcast (320×180, 640×360, 1920×1080) and
`balanced` degradation. On the camera stage each tile is its own toggle, "Show Jonas Berg’s camera large": the
camera then fills the stage and its tile says "Shown large"; pressed again, every camera is a tile. During a screen
share cameras stay a side column (screens are primary, #59). Automatic quality asks for the layer the element
shows, so the 1080p layer is sent only while someone shows a camera large (dynacast).

Measured (`camera-large` window, seven calibration runs `cal2` to `cal8` and the enforced run `full1`, two and four people): Ada received Jonas's
camera at **1920×1080, 29.7 to 30.1 fps**, 2.9 to 3.0 Mbit/s, no freeze, no loss; as a tile the same camera arrives
at 320×180 and 20 fps. Thresholds: ≥ 1080 rows, ≥ 20 fps, ≤ 2 s frozen.

**Enforced run.** `./scripts/check_public_sim.sh` with the default runs and thresholds at `c240a4282` (`full1`,
17 runs, 2026-10-31): 16 passed, including the two-person profiles (67 checks) and the four-person profiles (234
checks) with no failure, Firefox and WebKit screen publication and every Chromium, Firefox, WebKit and phone row.
The one failure was `webkit@ice-tcp:chromium:connect,drop` (row below); the default now runs it without the drop.
Run directories (`cal2` … `cal8`, `full1`, `wk1`) are local artifacts of `FLUX_SIM_ARTIFACT_DIR`, not committed.
The UI journey (`./scripts/check_live_ui.sh`, `test_live_sessions.py` test_01) now also switches a shared screen to
Smooth motion and back by click and arrow key (no second `getDisplayMedia`, the receiver keeps decoding) and shows a
camera large and back; it passed. Its test_02 fails at the Quiet step (the More popover stays open after Escape, so
two "Microphone off" buttons match); the same failure was recorded on the branch's base before this change.

### WebKit rows (2026-10-31, later)

| Row | Run | Result |
| --- | --- | --- |
| **WebKit 26.5 behind router A, UDP blocked, ICE/TCP allowed** (no TURN, no TLS) | `webkit@ice-tcp:chromium:connect,drop` (router A also lets TCP/7881 to the media host out) | Joined in 3.3 to 3.7 s in all five runs; selected pair local `prflx` **tcp** to the SFU's 203.0.113.20:**7881**. After the 15 s drop, media came back by itself in 2.3 to 2.5 s (Live in 3.1 to 3.3 s) in **three of five** runs (`cal2`, `wk1`); in the other two WebKit stayed "Reconnecting…" for the 120 s the driver waited while the Chromium peer rejoined (`full1`, `wk1`). Recorded as a WebKit ICE/TCP recovery defect, not a pass; the default run keeps `webkit@ice-tcp:chromium:connect`. With TURN/UDP (above), whose drop recovery passed, this covers WebKit on networks that block UDP but allow outbound TCP |
| **WebKit over TURN/TLS** | — | Still **unattainable in software here**: libwebrtc's compiled-in TURN/TLS roots ([`rtc_base/ssl_roots.h`](https://webrtc.googlesource.com/src/+/main/rtc_base/ssl_roots.h), checked 2026-10-31) cannot include a local CA. LiveKit's own TURN offers only `turns:` over TCP (TLS) and `turn:` over UDP, so plain TURN over TCP is not a path a Flux deployment offers. Safari on Apple platforms uses its own TLS stack and was not tested |
| **Screen publication in WebKit** | `webkit@turn-udp:chromium:connect,screen` | **Met, simulated (mock source).** Headed on the client's X display, WebKit 26.5 shows its own info bar "UserMedia request — Allow access to display device?" with No and Yes; `allow-display` presses Yes as the person would (xdotool). WebKit then shares Playwright's mock screen source ("Mock screen device 1", 1920×1080, `displaySurface: monitor`), not the X display, so the path through the app's button, WebKit's encoder, the SFU and a Chromium receiver is real but the picture is synthetic. Jonas received **1920×1080 at 9.5 fps**, 587 kbit/s (`cal4`, Sharp text). The desktop portal was not involved: a probe with a stub `org.freedesktop.portal.ScreenCast` service on D-Bus and PipeWire saw no ScreenCast call. The earlier "never settles" was this unanswered prompt |

## #63 acceptance table (2026-10-31)

Status of each part of [#63](https://github.com/ColdPhase/flux/issues/63)'s criteria. "Simulated" means met on
`check_public_sim.sh` under the founder direction above, not on a rented host. "Unattainable in software here"
names an engine limit observed in Docker with its source. Founder decision of 2026-10-31: finish the rest of #63
before the release; rows that software cannot reach here are closed as unattainable with dated sources. Updated
later on 2026-10-31 (smooth motion, larger camera, WebKit, k3s dropped).

| Criterion | Part | Status | Evidence, or what remains (unblock) |
| --- | --- | --- | --- |
| AC-1 | DNS, TLS, public address, NAT, TURN on 443 and 3478, UDP-blocked fallback | **Met, simulated** | [Simulated public host](#simulated-public-host-63-2026-10-30). Not covered: ACME issuance, a Docker port-forwarded SFU, carrier-grade NAT |
| AC-1 | Explicit ports, firewall and proxy behaviour, secret handling | **Met** | [Compose deployment](#compose-deployment); the simulation uses only those ports; keys stay in the environment |
| AC-1 | k3s topology | **Dropped (founder decision, 2026-10-31)** | Kubernetes (k3s, Helm) is not supported yet; Docker Compose is the only supported install. The chart values, render check and k3s evidence were removed |
| AC-1 | Pinned versions, health, metrics, room limit | **Met** | Digest-pinned LiveKit 1.13.7 and `livekit-client` 2.17.2; health probe; `/metrics` inside; 16-participant configured ceiling (a setting, not a measured capacity) |
| AC-1 | Restart, update, rollback | **Met, simulated** | SFU restart and SFU update to v1.13.11 then rollback to the pinned digest during a call: Live again in 20.0 to 20.2 s each, devices off; API restart: media unbroken, Live in 3.3 s. [Operations](#operations-and-access-ac-1-ac-4) |
| AC-1 | CPU, memory, egress | **Met, simulated** | Per measured window in `resources-summary.json`: SFU 7.8 % CPU, 83 MB, 9.1 Mbit/s egress with four people and two shares. Local containers, not a capacity |
| AC-1 | Recording, egress and external inference off | **Met, simulated** | No egress, ingress or agent service in the stack; only the people in the session |
| AC-2 | Reproducible profiles with measured results | **Met, simulated** | [Measured profiles](#measured-profiles-and-calibrated-thresholds-ac-2): speech, camera, motion, two shares, 1:1, loss and jitter, one weak receiver; code/text at 2560×1440 in the [calibration](live-code-calibration.md) |
| AC-2 | Motion 1080p60, camera 1080p30, continuous speech | **Met, simulated, with a recorded limit** | Speech met. **Camera:** shown large, 1920×1080 at 29.7 to 30.1 fps received ([larger camera](#a-larger-camera-ac-2-camera-profile)). **Motion:** Smooth motion captures 1920×1080 at 60 fps and delivers **59.5 to 59.7 fps at 1280×720** at its 10 Mbit/s cap for a frame that moves everywhere ([smooth motion](#smooth-motion-ac-2-motion-profile)); 1080p *and* 60 fps together at the receiver was not reached with Chromium's software encoder in Docker (target is "up to") |
| AC-2 | Two then four participants, two screens | **Met, simulated** | Two, then four people with two simultaneous real screen shares, enforced thresholds |
| AC-2 | Weak receiver, loss, jitter, UDP-blocked TURN | **Measured, simulated; quality limits recorded** | Gates pass. Recorded limits: a TCP relay under loss gives a 1 to 3 fps screen and late audio; a 400 kbit/s receiver of a one-layer screen loses the screen and most of its speech (Sharp text 68 to 86 % concealed, Smooth motion 84 to 98 %), while the other people are untouched. Simulcast screen layers were measured and rejected (they cut Smooth motion to 10 to 13 fps); LiveKit's `allow_pause` did not help |
| AC-2 | Calibrated pass/fail thresholds, peer-recorded | **Calibrated and enforced; independent peer review not done** | Recalibrated on 2026-10-31 (calibration runs `cal2` to `cal8` and the enforced default run below) and enforced (`profiles.THRESHOLDS`). The coordinator did not ask for an independent threshold review in this change; it remains for the release-candidate review |
| AC-3 | Chromium, Firefox, WebKit desktop rows | **Met, simulated; WebKit TURN/TLS unattainable in software here** | Chromium and Firefox over TURN/TLS. WebKit relays over TURN/UDP and connects over ICE/TCP with UDP blocked ([WebKit rows](#webkit-rows-2026-10-31-later)); over ICE/TCP it recovered from a 15 s drop in only three of five runs (recorded defect). **WebKit over TURN/TLS: unattainable in software here** (libwebrtc's compiled-in roots, [`ssl_roots.h`](https://webrtc.googlesource.com/src/+/main/rtc_base/ssl_roots.h), checked 2026-10-31; `unknown certificate authority`). Engines run on Linux; Windows, macOS and Fedora/Wayland are engine rows, not those systems |
| AC-3 | Emulated Android, iPhone, iPad rows: viewports, touch, fake media, visibility, rotation, device change, update, rejoin | **Met (emulated)** | [Platform rows](#emulated-platform-rows) and [device change, update and rejoin](#device-change-update-reload-and-rejoin-on-the-platform-rows-63-ac-3-2026-10-30); physical devices optional (#266) |
| AC-3 | Network loss and recovery of the media path | **Met, simulated** | Desktop engines (30 October) and now phone rows: Pixel 7 over TURN/TLS and iPhone 13 over TURN/UDP back in 1.0 to 2.0 s after a 15 s cut |
| AC-3 | Denied or revoked permissions, no silent reactivation | **Met** | Camera denial on the platform rows; after an SFU restart or update the app rejoined with devices off |
| AC-3 | Screen publication outside Chromium, system or tab audio | **Met, simulated** | Firefox: real X screen, 1920×1080 at 15 fps received. **WebKit:** through its own permission prompt (answered Yes), Playwright's mock screen source, 1920×1080 at 9.5 fps received ([WebKit rows](#webkit-rows-2026-10-31-later)). System or tab audio is not offered: the app requests none (`audio: false`), a recorded product scope, not a gap |
| AC-4 | Outsider non-discovery, active access removal, issued-token replay | **Met, simulated** | 404 for a workspace member without the project; removal closes the connections in 0.07 to 0.15 s on all three engines; issued token refused at the public gate |
| AC-4 | Refreshed-token reconnect | **Met, simulated** | SFU-refreshed token (same room, later expiry) captured from the signalling socket and refused after removal, in Chromium, Firefox and WebKit |
| AC-4 | Encryption boundary, key distribution, downgrade | **Met** | [live-media-encryption.md](live-media-encryption.md): DTLS-SRTP to the SFU, not end-to-end |
| AC-4 | AI receives no media by default; human calls with AI off | **Met, simulated** | No agent or processor in the room or stack; a call with workspace AI blocked joined, carried audio and recovered |
| AC-4 | One release-candidate commit with the real journey and independent reviews | **Open** | Unblock: an independent review of this change and the release-candidate pass |

Left on #63: an independent review of the thresholds and of this change, and the release-candidate pass (AC-4's
last row). Everything else is met, simulated, dropped by founder decision (k3s) or recorded as unattainable in
software here with a dated source (WebKit TURN/TLS; 1080p and 60 fps together at the receiver with a software
encoder).

## Pointer reachability and camera state on phone and tablet (#63; 2026-10-10)

Two stacking faults put conversation content over live controls on phone and tablet widths:

- The screen stage (`.lv-stage`) was at z-index 5, under the open thread sheet (`.thread--sheet`, `--z-panel`). "Back to work" could not be clicked on a 390 px phone (a thread message on top) or an iPad (`div.thread__head` on top). In the four-person test at desktop width, a wiki frame's Download button covered it.
- The strip (`.lv-bar`, z-index 2) formed its own stacking context, so the session popover inside it stayed below the thread sheet. On an iPad the camera control was under `div.thread__in`.

The fix in [live.css](../../app/apps/web/src/live/live.css) uses the existing layer tokens: the stage is `--z-scrim` (30) and the strip `--z-overlay` (40). The popover now paints above the thread sheet and the stage, and still below portalled overlays, which share the layer but come later in the DOM. Strip tooltips (`data-tip`) are inside that stacking context, so they now paint above the stage too; this follows from the stacking rules and was not tested separately. The [final design](../design/final/README.md) does not define z-token semantics.

[`test_live_reachability.py`](../../app/tests/ui/test_live_reachability.py) runs with `FLUX_LIVE_UI_PATTERN=test_live_reachability.py ./scripts/check_live_ui.sh`. Each control gets `elementFromPoint` at its centre and then a real click or tap. On unmodified main three cases fail with the covering elements above. With the fix all four pass, including the phone sheet painting above the strip. On unmodified main the same suite's `test_live_sessions` `test_02` and `test_03` fail on this interception; with the fix both pass.

**WebKit camera state (iPad, gen 7 emulation).** After a tap the strip reads "Camera on", while the instance-level `getUserMedia` hook in the test instrumentation records 0 calls. A probe on `MediaDevices.prototype.getUserMedia` records 1. The host's `video.lv-cam__video` decodes kai's camera at 1280×720. So a capture request reached the browser, and "on" is backed by a published track that the host decodes; this is not a product defect. The WebKit call reaches the prototype without going through the instance's own-property hook. The mechanism is not established. The instrumented track list (`window.__live.tracks`) therefore cannot see WebKit captures. The platform rows in the section above observe WebKit camera and microphone calls through `PROTOTYPE_INSTRUMENT` in `test_live_platforms.py`; this section's reachability suite still uses the instance hook only.

**Known and unrelated:** `test_live_sessions` `test_01_two_people_blocker_join_show_screen_result_leave` fails at line 365, waiting for the Map sketch link "Why are night frames black". It fails the same way on unmodified main and with the fix. It was not investigated here.

**Unverified here:** physical devices, real networks and NAT, Firefox rows, WebKit microphone capture, system audio, and Windows, macOS and Wayland desktop rows.

## Sources and inference

Checked 2026-09-28: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
documents an embedded TURN server, trusted TLS certificate, dedicated TURN
domain and direct TCP/443 without a load balancer. [Ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
lists ICE/TCP, ICE/UDP mux, TURN/UDP and TURN/TLS separately. The split-address
Compose layout above is Flux's operator design derived from those requirements;
the local test result is separate implementation evidence.
[LiveKit's configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
documents default denial of private TURN peers and `allow_restricted_peer_cidrs`.
