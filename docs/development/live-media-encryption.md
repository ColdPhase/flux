# Live media encryption boundary (#63)

**Status 2026-10-05:** record of what the current self-hosted live stack
encrypts, for [#63](https://github.com/ColdPhase/flux/issues/63) AC-4 (T63-a).
It applies to the Compose layers in [live-media.md](live-media.md) and the k3s
values in [live-media-k3s.md](live-media-k3s.md). It is not an end-to-end
encryption (E2EE) claim; Flux makes none.

**In one sentence:** media is encrypted on every network hop and decrypted in
the SFU. The SFU, whoever operates it, and whoever controls Flux signaling can
read the audio, video and screens of a session.

Labels: **standard** (RFC or W3C text), **vendor** (LiveKit documentation),
**source** (pinned LiveKit v1.13.7 or Flux code), **observed** (the automated
check below), **inference** (Flux's conclusion from the others).

## Boundary by path

| Path | Protection | Plaintext available to | Basis |
| --- | --- | --- | --- |
| Browser ↔ SFU media: direct UDP/7882, ICE-TCP/7881, or relayed by TURN | DTLS-SRTP, negotiated between the browser and the SFU. RTP payload encrypted, RTP header authenticated only. | Sender, the SFU (it decrypts and re-encrypts for each receiver), receivers | standard, observed, inference |
| Same packets on the network | — | Observers on direct paths see RTP headers: SSRC, sequence, timestamps and header extensions, including the per-packet audio level | standard |
| Browser ↔ TURN, UDP/3478 | TURN framing in clear; the relayed payload is the DTLS-SRTP above | TURN sees client address, allocation, peer, packet sizes and timing | standard |
| Browser ↔ TURN, TLS/443 | TLS (LiveKit requires at least 1.2; the local run negotiated 1.3) around TURN and DTLS-SRTP | The TURN service, embedded in the SFU process: the SFU trust domain | source, observed |
| Browser → Flux `/media` signaling | WSS: the operator's TLS proxy, then the Flux API | Proxy, Flux API, SFU. Carries SDP with the DTLS fingerprints, ICE credentials, identities and track metadata | source |
| Flux API ↔ SFU signaling and room service (7880) | None. Plain WebSocket/HTTP on a private network: Compose `livekit-signal` (`internal: true`), or the k3s private bind address and Service | Anyone on that private network | source |
| SFU → Flux API webhooks | None in transit (private HTTP). A JWT in `Authorization` carries a SHA-256 of the body | Anyone on that private network; integrity is protected | vendor, source |
| SFU metrics (6789) | None; bound to the private address and loopback | Private network | source |

### Key establishment and its trust anchor

The browser and the SFU each send their DTLS certificate's fingerprint in the
SDP, which travels over signaling (RFC 5763, RFC 8842). The browser completes
DTLS only with the certificate whose fingerprint it received. RFC 8827 §4.3:
"Even if HTTPS is used, the signaling server can potentially mount a
man-in-the-middle attack unless implementations have some mechanism for
independently verifying keys." Flux uses no identity provider (RFC 8827 §7).

**Inference:** the media keys are only as trustworthy as the signaling path:
the operator's TLS proxy, the Flux API process, and the private API–SFU hop.
TURN and network observers cannot substitute their own certificate: the
negative control below shows that DTLS then fails and no media flows. A
compromised Flux API or SFU host can read or alter media.

### Tokens

- The API issues a LiveKit JWT (HS256, signed with the LiveKit API secret)
  per admission. It lives 90 seconds and names the participant
  `u_<user>.<admission>` and one room generation. It grants publish and
  subscribe only: no data, metadata, admin, list or record
  ([`media.ts`](../../app/apps/server/src/live/media.ts)). source
- The SFU refreshes tokens for connected clients. Refreshed tokens last 10
  minutes or the remaining lifetime of the original, whichever is longer.
  vendor
- The LiveKit client sends the token as the `access_token` query parameter.
  It is therefore readable by the TLS proxy and the API, and can appear in
  their request logs. **Inference:** a logged token alone does not open
  media. The gate also requires the cookie session that obtained it, an
  unrevoked admission and current access; the SFU's signaling port is
  private. Operators should still keep `/media/` query strings out of logs.
- TURN credentials are separate. LiveKit derives them per participant from
  the API secret. A new allocation needs an unexpired credential (300 s by
  default), but an existing allocation can still be refreshed after expiry.
  source

### Revocation

Revocation ends media through the SFU and the signaling gate, not through the
token. It is described in [live sessions](live-sessions.md#media-admission-and-session-end-128).
An ended session or lost access revokes the admission. The API then closes
that admission's proxied sockets, drops its SFU permissions, and removes the
participant. A project access change also deletes the room generation. The
gate refuses the original and the SFU-refreshed token afterwards (`401`, no
SFU frame). `e2e/live-sfu-revocation.e2e.ts` and `live-sfu-signout.e2e.ts`
prove this against the pinned SFU, and `check_live_turn.sh` reruns both under
the restrictive TURN/TLS profile. LiveKit states that self-hosted removal does
not invalidate an issued token. vendor

**Remaining after revocation:** the TURN credential is not revoked. Until it
expires, a removed client can open a relay allocation, and it can keep
refreshing an existing one. That gives no Flux media: the participant, its
DTLS session and the room generation are gone. The relay can still forward to
public peers. LiveKit denies private and loopback peers by default, and allows
at most 12 allocations per participant credential. source. This is a relay
resource concern rather than a confidentiality gap. #63 tracks it with the
TURN profile.

## Not end-to-end encrypted

The SFU must read RTP to forward, select layers and measure quality, so it
holds each participant's DTLS-SRTP keys. LiveKit offers E2EE: the client
encrypts each frame with an application-supplied key, a shared room key or a
per-participant key provider, using the browser's encoded-transform API. In
LiveKit's words, "It is your responsibility to securely generate, store, and
distribute encryption keys". Signaling and API calls stay readable by the
server. vendor

Flux does not enable it. The `Room` in
[`web/src/live/media.ts`](../../app/apps/web/src/live/media.ts) has no
encryption option, no key provider and no E2EE worker. Adopting E2EE later
would need decisions this record does not make:

- who distributes keys without the Flux API (and with it the operator)
  becoming a holder;
- key rotation on revocation;
- what happens to adaptive quality and diagnostics;
- the explicit decrypting recipient that
  [optional audio notes](../product/live-collaboration.md#5-personal-ai-help-and-optional-audio-notes)
  would require.

Until then, product text must say "encrypted in transit", not "end-to-end".

### Downgrade behavior

- Browsers cannot send unencrypted media. RFC 8827 §6.5: "Media traffic MUST
  NOT be sent over plain (unencrypted) RTP or RTCP"; "DTLS-SRTP MUST be
  offered for every media channel"; SDES must not be offered or accepted.
  RFC 8996 forbids DTLS 1.0. standard
- The assertion below therefore requires, for every transport that carried
  RTP: DTLS 1.2 (`FEFD`) or 1.3 (`FEFC`), a cipher suite, an SRTP protection
  profile, and the signaled certificate.
- If TURN/TLS is blocked, the client can fall back to TURN/UDP or a direct
  path. Media keeps the same DTLS-SRTP. Only the outer TLS layer is lost: on
  that hop, network observers then see RTP headers and TURN framing.
- Without E2EE there is no end-to-end protection to downgrade from. Product
  §5 requires any future E2EE to fail closed, never to silently fall back.

## Automated evidence

`./scripts/check_live_turn.sh` (default profile) runs
[`live-turn-relay.e2e.ts`](../../app/tests/app/e2e/live-turn-relay.e2e.ts) in
Chromium. A client firewall rejects UDP and direct ICE-TCP, so media relays
over TURN/TLS.

- **Assertion (first case).** It uses `dtlsTransports` and
  `dtlsSrtpViolations` in
  [`support/live-turn.ts`](../../app/tests/app/support/live-turn.ts). For the
  publisher and the receiver, it reads W3C `RTCTransportStats` and the remote
  `RTCCertificateStats` of every transport that carried RTP. It requires
  `dtlsState: "connected"`, a DTLS version of 1.2 or 1.3, `dtlsCipher` and
  `srtpCipher`. The remote certificate's fingerprint must equal an
  `a=fingerprint` of the remote description delivered through `/media`.
- **Negative control (second case).** A separately authorized participant
  takes the same gate, firewall and TURN/TLS path. A page hook inverts every
  byte of each `a=fingerprint` before the browser applies the remote
  description. The case requires all of the following:
  - ICE reaches the SFU;
  - the DTLS transport becomes `failed`;
  - no connection ever completes;
  - no SRTP profile and no inbound RTP bytes;
  - the assertion's predicate rejects that browser.

  This shows the assertion is not vacuous. It also shows that the media key is
  bound to the signaled fingerprint.

**Observed 2026-10-05, local Docker run:** see
[evidence](evidence/live-encryption/2026-10-05/README.md) for the exact commit,
the cipher suites and DTLS version reported, and the negative-control state
sequence.

The check does not prove:

- the direct UDP or ICE-TCP path (not separately asserted; the browser applies
  the same rule);
- Firefox or Safari;
- a public CA, DNS or NAT;
- what the SFU process does with plaintext;
- that the operator's proxy, API host or private network is uncompromised.

## Sources

All fetched 2026-10-05. Standards have fixed publication dates. LiveKit pages
are living documents rendered on the fetch date; code is pinned.

- RFC 8827, *WebRTC Security Architecture*, Jan 2021 (Standards Track): §4.3
  signaling and fingerprints, §6.5 mandatory DTLS-SRTP, no SDES, §7 identity.
  RFC 8826, *Security Considerations for WebRTC*, Jan 2021.
- RFC 3711, *SRTP*, Mar 2004: encrypted portion is the payload; the header is
  authenticated only. RFC 6464, Dec 2011: audio levels are "visible on a
  packet-by-packet basis to an attacker passively observing the audio
  stream". RFC 9335 (cryptex), Jan 2023, defines header-extension
  encryption; not asserted here.
- RFC 5763 and RFC 5764, May 2010 (DTLS-SRTP framework and extension);
  RFC 8842, Jan 2021 (SDP for DTLS); RFC 9147, Apr 2022 (DTLS 1.3);
  RFC 8996, Mar 2021 (BCP: "MUST NOT negotiate DTLS version 1.0");
  RFC 8656, Feb 2020 (TURN).
- W3C [*Identifiers for WebRTC's Statistics API*](https://www.w3.org/TR/webrtc-stats/),
  Candidate Recommendation Draft, 25 Sep 2025: `RTCTransportStats` (`dtlsState`,
  `tlsVersion` as four hex digits, `dtlsCipher`, `srtpCipher`,
  `remoteCertificateId`) and `RTCCertificateStats` (`fingerprint`,
  `fingerprintAlgorithm`). [*WebRTC*](https://www.w3.org/TR/webrtc/),
  Recommendation, 13 Mar 2025. [*WebRTC Encoded Transform*](https://www.w3.org/TR/webrtc-encoded-transform/),
  Working Draft, 25 Jun 2026.
- LiveKit (vendor):
  - [encryption overview](https://docs.livekit.io/transport/encryption/):
    signaling "encrypted in transit using TLS, but the LiveKit server can
    still read them"; keys are the application's responsibility;
  - [E2EE setup](https://docs.livekit.io/transport/encryption/start/);
  - [tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/):
    refresh lifetime, and that self-hosted removal does not invalidate
    tokens;
  - [webhooks](https://docs.livekit.io/home/server/webhooks/): signed JWT
    with a SHA-256 of the payload.
- LiveKit v1.13.7 source:
  [`pkg/service/turn.go`](https://github.com/livekit/livekit/blob/v1.13.7/pkg/service/turn.go)
  (TLS minimum 1.2, credential derivation and TTL, restricted-peer denial,
  per-participant allocation limit);
  [`pkg/config/config.go`](https://github.com/livekit/livekit/blob/v1.13.7/pkg/config/config.go)
  (TURN defaults).
- Flux code at the tested commit:
  - [`media.ts`](../../app/apps/server/src/live/media.ts);
  - [`signal-gate.ts`](../../app/apps/server/src/live/signal-gate.ts);
  - [`webhook.ts`](../../app/apps/server/src/live/webhook.ts);
  - [`web/src/live/media.ts`](../../app/apps/web/src/live/media.ts);
  - Compose [`compose.live.yaml`](../../docker/compose.live.yaml).
