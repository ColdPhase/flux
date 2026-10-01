# Self-hosted live media: restrictive-network relay slice (#63)

The live backend in #61 uses LiveKit `v1.13.7` (image digest in
[`compose.live.yaml`](../../docker/compose.live.yaml)); the isolated browser proof
uses `livekit-client` `2.17.2` from a lockfile. Both versions must be reviewed
together before an upgrade. This page describes the TURN/TLS addition. It does
not certify call quality, k3s installation or real device support.

## Compose deployment

Layer `docker/compose.source.yaml`, `docker/compose.live.yaml`, then
`docker/compose.live.turn.yaml`. Set all base live variables plus:

| Variable | Operator value |
| --- | --- |
| `FLUX_LIVEKIT_TURN_DOMAIN` | Public DNS name dedicated to the TURN service; certificate SAN must match. |
| `FLUX_LIVEKIT_TURN_CERT_DIR` | Absolute host directory with trusted-CA `fullchain.pem` and `privkey.pem`, readable by the LiveKit container. Keep the private key outside the repo. |
| `FLUX_LIVEKIT_TURN_TLS_BIND` | Public IP dedicated to TCP/443 TURN/TLS; defaults to `0.0.0.0`, which conflicts with an HTTPS ingress on the same IP. |
| `FLUX_LIVEKIT_TURN_TLS_HOST_PORT` | Keep `443` for a direct public deployment. The isolated Docker test uses a separate host port while browsers reach container TCP/443. |

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

For k3s, follow the separate
[operator deployment contract](live-media-k3s.md). It records inputs, port
ownership, security and external validation gates. This is a topology
requirement, not a verified chart/install path; #63 still requires a real
deployment run.

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
requires relay over TLS with received bytes. The temporary certificate is
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
See the [pinned five-case report and original artifacts](evidence/live-turn/2026-09-30/README.md).

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
14–16px receiver text, real weak-link loss/jitter, Android/iOS devices, or k3s.
The later four-person synthetic-screen proof below extends only the local
media and text evidence. The remaining conditions are tracked in
[#63](https://github.com/ColdPhase/flux/issues/63).

## Receiver quality measurement slice

[`receiver-quality.ts`](../../app/apps/web/src/live/receiver-quality.ts) reads
receiver `getStats()` samples: selected ICE round-trip time; inbound audio/video
packets, interval bitrate and loss; audio jitter; and decoded video fps and
dimensions. A counter reset, absent report or short interval without fresh
packets is unknown, never fabricated as zero loss or good throughput. An
expected receiver with no new packets for at least two seconds is poor even
if its cumulative packet count and ICE round-trip time look healthy. The
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
[viewer 3](evidence/live-turn/receiver-3.png) and
[viewer 4](evidence/live-turn/receiver-4.png).

At the measured observer samples, both videos decoded at 10 fps with 0%
interval packet loss; received audio was about 98.8 kbps with 0 ms reported
jitter and 0% interval loss. The screenshot text is visually readable at
original pixels, but the publishers use `canvas.captureStream()` marked as
`screen_share`, not browser `getDisplayMedia()`. This is desktop Chromium on a
local Docker bridge. It is not evidence that #62's final screen-selection/zoom UI,
real device capture, tablets, external restricted networks or k3s deployment
meet #63's acceptance criteria. The existing integrated diagnostic surface is now wired to the shared
receiver measurement/classifier by #63; release quality calibration remains open.

## High-resolution calibration

Select `FLUX_LIVE_TURN_PROFILE=code-1440p ./scripts/check_live_turn.sh` for the
bounded [1440p code calibration protocol](live-code-calibration.md). The default
`legacy` profile preserves the earlier cases. Both profiles also run the current
revocation and sign-out regressions and receiver/diagnostic units. See that
protocol for source kinds, production publish settings, raw frame audit and
remaining acceptance limits.
The [dated high-resolution checkpoint](evidence/live-turn/2026-09-30-code/README.md)
contains actual two/four-peer decoded dimensions and frame intervals, original
pixels and resource windows, with production/harness pins and retained failures.
Raw receiver reports now supply the existing audio/video diagnostic rows;
the locked SDK audio projection's missing packet fields are not synthesized.

## Sources and inference

Checked 2026-09-28: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
documents an embedded TURN server, trusted TLS certificate, dedicated TURN
domain and direct TCP/443 without a load balancer. [Ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
lists ICE/TCP, ICE/UDP mux, TURN/UDP and TURN/TLS separately. The split-address
Compose layout above is Flux's operator design derived from those requirements;
the local test result is separate implementation evidence.
[LiveKit's configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
documents default denial of private TURN peers and `allow_restricted_peer_cidrs`.
