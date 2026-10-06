# DTLS-SRTP evidence, 2026-10-05

**Tested commit:** `deafe9e0c78b2c67e8d9a3518627bde31918cb3c` on branch
`claude-maurycy/63-live-boundary`, based on `main` `698313b3`. Owner:
`claude-maurycy`; independent review pending. It supports the
[encryption boundary record](../../../live-media-encryption.md).

## Command and result

The run used macOS with Docker Desktop and isolated ports 19570–19575:
`FLUX_LIVE_TURN_ARTIFACT_DIR=… ./scripts/check_live_turn.sh`, default
`legacy` profile. It exited 0.

- The image build includes build, type check and lint.
- Browser cases passed 4/4 in `live-turn-relay.e2e.ts`: the two-person relay
  with the DTLS assertion, the new negative control, four persons with two
  screens, and isolated display capture.
- Receiver-quality and diagnostics units passed 11/11.
- Real-SFU revocation and sign-out passed 2/2 under the same restrictive
  profile.
- The SFU resource summary was produced.

See [`check-live-turn-results.txt`](check-live-turn-results.txt).

The client container rejected all UDP except DNS and direct ICE-TCP/7881. Each
selected pair was a TURN relay over TLS. OpenSSL verified the disposable TURN
certificate, negotiating TLS 1.3 ([`turn-tls.txt`](turn-tls.txt)). That
certificate comes from a local test CA, not a public one.

An earlier run at `f620819f` passed the same 17 tests. Its final resource
summary failed: on macOS, `date +%3N` prints a literal `3N`, so no sample
fell inside the four-person interval. Commit `deafe9e0` fixed the sampler's
timestamp, and the run above passed. No assertion was changed.

## DTLS-SRTP observations

[`dtls-observations.json`](dtls-observations.json) lists the transports that
carried RTP. The publisher has one; the receiver has one. Locked
`livekit-client` 2.17.2 used a single peer connection in each browser.

| Browser | `dtlsState` | `tlsVersion` | `dtlsCipher` | `srtpCipher` | `dtlsRole` | Signaled fingerprint matches remote certificate |
| --- | --- | --- | --- | --- | --- | --- |
| Publisher (owner) | connected | `FEFD` (DTLS 1.2) | `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` | `SRTP_AES128_CM_HMAC_SHA1_80` | server | yes (`sha-256`) |
| Receiver (member) | connected | `FEFD` (DTLS 1.2) | `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` | `SRTP_AES128_CM_HMAC_SHA1_80` | server | yes (`sha-256`) |

Chromium negotiated DTLS 1.2 with the pinned SFU, and an AES-CM/HMAC-SHA1
SRTP profile rather than AEAD-GCM. The assertion requires DTLS 1.2 or 1.3 and
any SRTP profile; it does not require a particular profile.

## Negative control

A participant with the same grant, gate, firewall and TURN/TLS path had every
`a=fingerprint` byte inverted in the remote description. Its state sequence
on its only peer connection:

```text
dtls new → ice checking → connection connecting → dtls connecting
→ ice connected → dtls failed → connection failed → dtls closed
```

- ICE connected, so the network path worked.
- DTLS then failed, and the connection never reached `connected`.
- Captured at the failure, the transport showed `dtlsState: failed` and
  `iceState: connected`, with no SRTP profile and 0 inbound RTP bytes.
- The LiveKit client reported `could not establish pc connection`.
- The positive check's predicate rejected the page.

The browser enforced the signaled fingerprint, and the positive assertion is
not vacuous.

## Limits

This is one local run with the Chromium bundled in Playwright 1.63.0 (its
version number was not recorded). The following are not covered:

- the direct UDP or ICE-TCP path;
- Firefox and Safari;
- a public certificate, DNS or NAT;
- the SFU's handling of plaintext;
- a compromised signaling path.

[`livekit-resource-summary.json`](livekit-resource-summary.json) records the
four-person interval of the same run: 4 samples over 8.1 s, mean/peak SFU CPU
7.3%/8.88%, peak memory 114.3 MiB. These are local container figures, not a
capacity statement.
