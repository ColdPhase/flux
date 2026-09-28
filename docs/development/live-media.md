# Self-hosted live media: restrictive-network relay slice (#63)

The live backend in #61 uses LiveKit `v1.13.7` (image digest in
[`compose.live.yaml`](../../infra/compose.live.yaml)); the isolated browser proof
uses `livekit-client` `2.17.2` from a lockfile. Both versions must be reviewed
together before an upgrade. This page describes the TURN/TLS addition. It does
not certify call quality, k3s installation or real device support.

## Compose deployment

Layer `infra/compose.yaml`, `infra/compose.live.yaml`, then
`infra/compose.live.turn.yaml`. Set all base live variables plus:

| Variable | Operator value |
| --- | --- |
| `FLUX_LIVEKIT_TURN_DOMAIN` | Public DNS name dedicated to the TURN service; certificate SAN must match. |
| `FLUX_LIVEKIT_TURN_CERT_DIR` | Absolute host directory with trusted-CA `fullchain.pem` and `privkey.pem`, readable by the LiveKit container. Keep the private key outside the repo. |
| `FLUX_LIVEKIT_TURN_TLS_BIND` | Public IP dedicated to TCP/443 TURN/TLS; defaults to `0.0.0.0`, which conflicts with an HTTPS ingress on the same IP. |
| `FLUX_LIVEKIT_TURN_TLS_HOST_PORT` | Keep `443` for a direct public deployment. The isolated Docker test uses a separate host port while browsers reach container TCP/443. |
| `FLUX_LIVEKIT_METRICS_PORT` | Host loopback port for Prometheus metrics; defaults to `6789`. Scrape through a private monitor, not the public proxy. |

The API reaches LiveKit at `http://livekit:7880`; browsers receive the
operator's public `wss://` signaling origin. Terminate signaling HTTPS/WSS at
the operator's reverse proxy and route to host loopback TCP/7880. TURN/TLS
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
| TCP/7880 loopback only | Signaling/API behind HTTPS/WSS proxy. |

Keep the API key/secret in the operator's secret store or protected environment
file; rotate them together in API and SFU. Do not put them in public browser
configuration. This profile starts no recorder, egress, ingress, transcription,
or agent listener. The room has a 16-participant configured ceiling, which is
not a measured capacity. The existing service health probe checks signaling
readiness only; it does not prove media reachability. The overlay exposes
`/metrics` on loopback TCP/6789. Monitor the host's CPU/memory/network egress
and LiveKit logs, and test a real external client
after firewall, certificate or NAT changes. Upgrade by pinning a new digest in
one reviewed PR, testing against a preserved database and staging endpoint,
then rolling back to the previous digest/config if the call fails. A restart
interrupts current media; Flux's room-generation recovery is tested by
`scripts/check_live_sfu.sh` but quality/recovery time is still unmeasured.

For k3s, use host networking for SFU media ports or explicit L4 TCP/UDP
LoadBalancer services with a stable public media address. Terminate signaling
WSS at ingress; mount TURN TLS materials from a namespaced Kubernetes Secret,
and expose TCP/443 at L4 on the TURN DNS address. A generic HTTP Ingress alone
cannot expose the media or TURN ports. This is a topology requirement, not a
verified chart/install path; #63 still requires that deployment run.

## Local restrictive-network proof

Run `./scripts/check_live_turn.sh`. It builds the app and pinned Chromium SDK
in Docker, starts an isolated Compose project and database, creates a disposable
test certificate, and places the **client** container behind an egress rule
rejecting UDP to the SFU and direct TCP/7881. Two authorized browser clients
join the same Flux session, one publishes a generated Web Audio tone, and the
other subscribes.
The assertion reads the selected WebRTC candidate pair on both clients and
requires relay over TLS with received bytes. The temporary certificate is
accepted only by this test browser; it does not prove a real public CA or NAT.
The script removes its volumes, images and certificate on exit. It is a local
heavy check, not a per-push GitHub Action.

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

This proof does not cover four people, real microphones/screens/cameras,
14–16px receiver text, real weak-link loss/jitter, Android/iOS devices, or k3s. Those
remain required by [#63](https://github.com/ColdPhase/flux/issues/63).

## Receiver quality measurement slice

[`receiver-quality.ts`](../../apps/web/src/live/receiver-quality.ts) reads
receiver `getStats()` samples: selected ICE round-trip time; inbound audio/video
packets, interval bitrate and loss; audio jitter; and decoded video fps and
dimensions. A counter reset or absent report is unknown, never fabricated as
zero loss or good throughput. The module returns specific warning reasons for
the live interface in [#62](https://github.com/ColdPhase/flux/issues/62) to
present on demand; #62 has not yet wired it into UI on this branch.

These **provisional diagnostic thresholds** are test gates, not release quality
promises. Peer calibration against receiver recordings and real links is still
required before the final #63 acceptance run:

| Receiver metric | Warning | Poor |
| --- | ---: | ---: |
| Selected ICE round-trip time | >300 ms | >600 ms |
| Audio jitter | >30 ms | >80 ms |
| Interval audio/video packet loss | >3% | >10% |
| Decoded video frame rate, when receiving video | <10 fps | <5 fps |

The restrictive Docker test adds a fixed 450 ms outbound delay with `tc netem`
**after** both receivers connect. It checks that real received audio and video
remain visible in `getStats()` and that the measured RTT crosses the
warning threshold. A constant delay is reproducible but does not emulate
random loss, jitter, weak radio, device switching, screen readability or
four-person capacity. Those need separate profiles and real receivers.

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

## Sources and inference

Checked 2026-09-28: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
documents an embedded TURN server, trusted TLS certificate, dedicated TURN
domain and direct TCP/443 without a load balancer. [Ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
lists ICE/TCP, ICE/UDP mux, TURN/UDP and TURN/TLS separately. The split-address
Compose layout above is Flux's operator design derived from those requirements;
the local test result is separate implementation evidence.
[LiveKit's configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
documents default denial of private TURN peers and `allow_restricted_peer_cidrs`.
