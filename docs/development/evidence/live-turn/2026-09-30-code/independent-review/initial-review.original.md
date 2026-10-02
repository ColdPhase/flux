# Independent bounded #63 diagnostics review

Date: 2026-09-30. Verdict: **changes requested for the diagnostics delta**. This report is not approval or completion of issue #63.

Reviewed commit: `bf6bc398119141b0d398ef1578ae7889a4fea62c` in independent detached checkout `/tmp/flux63-diagnostics-review`. The author's checkout was preserved. No implementation files or GitHub records were edited. Issue #63 remains assigned to `PelikanFix16`; no PR currently exists for its branch.

The contract was read from issue [#63](https://github.com/ColdPhase/flux/issues/63), `docs/development/live-media.md`, `docs/agents/evaluation.md`, AGENTS.md and the review skill. The fetched issue-body snapshot is `/tmp/flux63-issue-contract.json`, SHA-256 `5364a26f70dbee9e9dc704cd9b2572aaca7e2c29a62522260ac648d6a8773f30`. Scope is the parent-requested on-demand diagnostic correction: truthful interval measurements, unavailable/reset/partial handling, intentional pause/mute, lifecycle history and existing product integration. Public deployment, physical devices, calibration, encryption and whole-issue acceptance remain unverified.

Exact source blob pins:

| Source | Git blob |
| --- | --- |
| `apps/web/src/live/diagnostics.ts` | `f51555a51ec720c7aa1da4ae300767c3f8b891f0` |
| `apps/web/src/live/receiver-quality.ts` | `3a648bc226f74636b72c5fb616b93e191ec91987` |
| `apps/web/src/live/media.ts` | `ded618761cde59cd78e70a1012fbda248267a8be` |
| `docs/development/live-media.md` | `690355d1655c187703255f4e523de7f2dd06c247` |
| `docs/agents/evaluation.md` | `a530da7e834e6b9c78a871a0418dab3ceac492ba` |

`git diff bf6bc398119141b0d398ef1578ae7889a4fea62c 7580d43947bf18427f332ccbb85234ada439306c -- apps/web/src/live/diagnostics.ts apps/web/src/live/receiver-quality.ts apps/web/src/live/media.ts tests/app/live-diagnostics.test.ts tests/app/live-receiver-quality.test.ts` is empty. That later head's test/profile changes were not independently executed here. Any subsequent production fix needs a fresh review.

## Criterion results

| Criterion | Result | Evidence and limits |
| --- | --- | --- |
| Interval video loss, bitrate and decoded FPS from complete receiver samples | Pass | Existing Docker unit cases show 15 decoded FPS, 80 kbit/s and 0% interval loss despite 50 lifetime lost packets; stale instantaneous FPS does not override decoded frames. No browser guarantee follows. |
| Production audio receiver packet flow/loss through the actual pinned SDK | Fail | F1: real SDK helper drops both RTP packet counters before the production formatter receives them. |
| Missing/reset/partial reports cannot create zero losses or `good` status | Fail | Missing reports, full resets, absent losses/concealment, invalid sender rates pass covered cases; F2: isolated missing/reset byte counter still yields `good`. |
| Intentional mute, quiet audio and hidden-video pause suppress flow warnings | Pass at core integration | Independent harness invokes production `diagnostics()` and actual SDK track prototypes: muted rows, hearing=false and streamState=paused have warning=null even when getStats rejects. Real app operation remains unverified. |
| Histories clear/prune after removal/disconnect | Fail | Synchronous clear/forget/retain unit cases pass; F3 reproduces a pending production stats read restoring cleared history. |
| Existing Connection details consumes shared logic | Pass structurally; runtime unverified | LiveProvider binds `LiveMediaConnection.diagnostics`; LivePanel's existing table ticks it every 2s; media imports TrackDiagnostics and uses it for received audio/video. I have not independently operated the running product UI. |
| Quiet/static screen does not imply a link failure solely from sparse frames | Unverified in actual capture | A complete synthetic sparse interval with 100 fresh packets, zero interval loss and one frame over 2s is `poor` with `Video receiving 0.5 fps`. Text is numeric, but classifier cannot establish why sparse frames occurred. The moving source profile cannot prove static capture behavior. Preserve provisional thresholds; reproduce genuine static capture before claiming the case passes. |
| CI, eligible GitHub review, public/device/whole #63 acceptance | Unverified | No current PR for the branch; no CI/review gate was exercised. No external NAT/k3s/physical-device checks were performed. |

## Material findings (3)

### F1 — Production voice cannot obtain interval packet loss or packet-flow status (P1)

Location: `apps/web/src/live/media.ts:358–361`, pinned `livekit-client` 2.17.2 `src/room/track/RemoteAudioTrack.ts::getReceiverStats`.

Expected: a healthy received voice track with available RTP counters can obtain a valid interval and measured loss; missing data must be an actual measurement limitation, not an adapter omission.

Observed: the pinned SDK helper copies bytes/jitter/concealment but omits `packetsReceived` and `packetsLost` from a real receiver report. Its TypeScript shared interface declares those optional members, hiding the omission. Every ordinary production voice interval therefore has undefined packet delta/loss and remains `unknown`, with `Receiver measurements unavailable; waiting for a valid interval` and `– % lost`, even when the raw report contains both counters. It also cannot distinguish a stalled audio counter using the new logic.

Reproduction: independent harness creates a RemoteAudioTrack from the actual pinned SDK prototype, provides receiver.getStats() with inbound packetsReceived=100, packetsLost=2, bytesReceived=10000 and jitter=.01, then invokes the **real** getReceiverStats and getRTCStatsReport methods. The former drops both counters; the latter retains them. Feed successive helper stats with advancing bytes into TrackDiagnostics: 40 kbit/s and 10ms jitter coexist with unknown loss/status. See `ACTUAL_SDK_AUDIO` in `/tmp/flux63-diagnostics-independent-cases.log` and extracted actual SDK source `/tmp/flux63-sdk-source.txt`.

Fix direction: use the actual per-track raw receiver report and safely select associated inbound RTP records, then verify a generated tone through the genuine product Voice row. The SDK's getRTCStatsReport delegates to that receiver's getStats. Receiver-scoped stats include its inbound RTP streams plus referenced objects; this is not a room-wide first-audio-record query. [W3C receiver stats selection](https://www.w3.org/TR/webrtc/#the-stats-selection-algorithm) establishes that scope. Filter inbound type/kind and correlate trackIdentifier where present with the track's MediaStreamTrack.id; preserve underlying stats identity across intervals or remain unknown on ambiguity/replacement. [W3C trackIdentifier](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-trackidentifier).

### F2 — Isolated byte resets and partial byte reports fabricate `good` (P2)

Location: `apps/web/src/live/receiver-quality.ts:141–143`, consumed by `apps/web/src/live/diagnostics.ts:35–47`.

Expected: an absent/reset required interval counter cannot produce good throughput/complete healthy status. Optional informational fields need not make quality unknown: codec, dimensions and concealment totals are displayed independently; missing concealment must still stay `–`, not zero. Current per-track RTT is also optional. Required measured core is valid interval packet flow/loss/bitrate plus audio jitter or decoded video FPS.

Observed: the classifier checks missing loss/FPS/jitter, but never missing bitrate. Start with bytes=10000, packets=100, lost=0 and frames=30. Two seconds later use packets=200, lost=0, frames=60 and either bytes=100 (reset) or bytes=undefined (partial report). The delta reader correctly returns unavailable bitrate, but the classifier returns `good`, warning=null, alongside `– kbit/s` and `0.0 % lost`.

Reproduction: `PARTIAL_BYTES` records in the independent log cover both byte-only reset and omission. The accepted unit covers only simultaneous/full reset and a partial report that also lacks loss/FPS, so it does not detect this case. Include valid elapsed time and required-byte measurement in the good-status completeness check; preserve known measurements while incomplete status remains unknown.

### F3 — A pending stats read resurrects history after removal/disconnect (P2)

Location: `apps/web/src/live/media.ts:303–305, 349–368`; `apps/web/src/live/diagnostics.ts:31–33`.

Expected: completion of an obsolete async read cannot restore a removed publication's history or return stale connected rows after disconnect.

Observed: diagnostics captures `keys` and track before await. While getReceiverStats is pending, forget/disconnect clears history and removes the publication. Resolving the read then calls receiver(), writes `in:screen` again, and retain(keys) retains that now-removed key. The returned result still says `Connected` and contains the removed screen although connection is `disconnected`.

Reproduction: independent harness invokes the actual production diagnostics/disconnect methods on a LiveMediaConnection prototype, with real RemoteVideoTrack prototype and stubbed transport/DOM dependencies. Delay its stats promise; call forget('screen') and disconnect; assert history is empty; resolve the pending read and await diagnostics; history now contains `in:screen` and returned rows contain Screen. See `RESURRECTED_HISTORY`. This is a core concurrency reproduction, not a browser screenshot or transport acceptance result.

Fix direction: invalidate reads on track/connection lifecycle changes, check that the publication still references the same track after await, and derive retained keys from currently live publications rather than obsolete pre-await references. Cover removal and disconnect while a read is pending, and replacement/overlapping reads.

## Independently executed checks

All application dependencies/tools ran in isolated offline Docker containers with `--cpus 1`; no host dependency install or heavy/full suite was run. Image was the available build from the author's test image, `flux-e2e:flux-live-turn-1790763993-691814`, immutable image ID `sha256:82fa1240faef9c4e908ad2b0d496b3a3e3a96ab0310fdda16c8940f06e819b9f`. The frozen review tree was copied over the container sources before checks; dependencies remain the locked image's, confirmed actual livekit-client=2.17.2.

1. Existing units: `node_modules/.bin/tsx --test tests/app/live-diagnostics.test.ts tests/app/live-receiver-quality.test.ts` — **9/9 pass**, `/tmp/flux63-diagnostics-review-base.log`.
2. Independent SDK/partial/lifecycle/static/error/pause probes: `node_modules/.bin/tsx --test tests/app/independent63-review-cases.test.ts` — **5/5 probes pass**, `/tmp/flux63-diagnostics-independent-cases.log`. Passing means each probe reproduces/asserts the stated observation; the first three assert bugs, not successful acceptance.
3. `node_modules/.bin/tsc --noEmit -p tsconfig.json`, same for `apps/web/tsconfig.json`, scoped eslint for diagnostics.ts/receiver-quality.ts/media.ts — **exit 0**, `/tmp/flux63-diagnostics-types.log`. An initial invocation using pnpm failed because this Playwright stage does not carry the pnpm executable; the equivalent installed binaries then ran successfully.
4. Scoped production-source `git diff HEAD^ HEAD --check -- apps/web/src/live/diagnostics.ts apps/web/src/live/receiver-quality.ts apps/web/src/live/media.ts` — **pass**. Whole commit diff check reports optional hygiene in `tests/app/support/live-turn.ts:137` (new blank line at EOF).
5. Review checkout `git status --short` — clean. Production sources and selected units unchanged through `7580d43947bf18427f332ccbb85234ada439306c`; test-only profile delta not certified.

The standalone harness is `/tmp/flux63-review-cases.test.ts`, SHA-256 `2f60f29ab5471f2755726124a4ca091f69a38c6cb21346b9d3aaed003fac7493`. Final independent log SHA-256 is `abdb5c2e204b38cdfa535a9ce6c356844169c35fed52ed14b3a8fc1f421150cb`.

Re-run the independent probes using:

```sh
docker run --rm --name flux63-diagnostics-independent --network none --cpus 1 \
  -v /tmp/flux63-diagnostics-review:/review:ro,z \
  -v /tmp/flux63-review-cases.test.ts:/independent.test.ts:ro,z \
  sha256:82fa1240faef9c4e908ad2b0d496b3a3e3a96ab0310fdda16c8940f06e819b9f \
  sh -ec 'cp -a /review/. /app/; cp /independent.test.ts /app/tests/app/independent63-review-cases.test.ts; node_modules/.bin/tsx --test tests/app/independent63-review-cases.test.ts'
```

Next action: the single implementation owner fixes F1–F3 on their owned branch, records the new exact head and re-runs affected units plus real product Voice/Screen diagnostics and static/error/pause/removal cases. Request fresh independent delta review. No required unverified #63 outcome is satisfied by this report.
