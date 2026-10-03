# 1440p Live calibration checkpoint — 2026-09-30

This is bounded #63 calibration and diagnostic-integration evidence, not whole
issue or release acceptance. The production source is
`7cfa12b60f1eec5a6eb5410b55b9894c095ac920`; the tested high-resolution harness is
`a58d9b9fcb496e655c751fa46308a24d8e3b86e0`. That harness uses the ordinary
**Back to work** action before opening diagnostics and pins the reference font.
Production source and
settings were unchanged. [metadata.json](metadata.json) pins source/test hashes,
actual image IDs, versions, Compose project and ports. Later documentation and
legacy-test edits do not change this measured application image.

The first publisher used real `getDisplayMedia()` on a separate 2560×1440 Xvfb
display containing known scrolling 14px code and 16px terminal text. The second
used synthetic `canvas.captureStream()`. Both used one VP8 layer, the production
15fps target/3.5Mbit/s ceiling, maintain-resolution and no simulcast. Both source
and reconstruction use installed Liberation Mono, with matching14/16 px probe
advances asserted for every pair. Source
settings are recorded separately from measured encoded/sent/decoded frames.
Generated audio was a tone, not speech or physical microphone capture.

Four disposable Flux accounts used actual project grants, same-origin cookies
and the current `/media` admission gate. Calibration SDK peers explicitly used
relay-only ICE. The test firewall refused client direct media UDP and TCP7881;
DNS/API traffic remained available. Test-only RTC interface filtering aligned
the SFU's candidates with its TURN allocation interface, while private signaling
binding stayed intact. Every selected calibration candidate was `relay` with
`relayProtocol=tls`. The separate actual Flux UI rejoin used its unchanged
automatic ICE policy, with no policy proxy, API-response mock or access override.

## Observed checks and measurements

[focused-run.log](focused-run.log) records exit 0: the high-resolution case,
11 receiver/diagnostics unit cases and both unchanged real revocation/sign-out
regressions passed. The source's fresh Docker build, TypeScript and ESLint
completed before the earlier stage/popover failure in
[the original source run](source-build-and-stage-overlap-failure.log).
[diagnostics-static-and-unit.log](diagnostics-static-and-unit.log) records the
locked SDK audio boundary and actual pending-read/disconnect regression.
The updated harness's TypeScript/ESLint run passed; its successful silent output
is [retained](harness-static.log).

Chromium 153.0.8010.12 on pinned Playwright 1.63.0 and LiveKit client 2.17.2 talked
to the repository's digest-pinned LiveKit 1.13.7. From first/last raw samples in
each stage (about 10 s), actual received video was:

| Stage | Received dimensions | Decoded interval fps | Video bitrate | Interval RTP loss |
| --- | --- | --- | --- | --- |
| Two people, one share | 2560×1440 | 14.96 | 860 kbit/s | 0% |
| Four people, two shares | 2560×1440 for all six receiving streams | 14.98–15.08 | 621–1318 kbit/s | 0% |

[code-1440p-summary.json](code-1440p-summary.json) derives these values from
[timestamped raw reports](code-1440p-stats.jsonl), retaining encoded and sent
frame counters separately. Missing/reset counters remain null. The longer
before/after receiver windows and decoded marker events are in
[code-1440p-report.json](code-1440p-report.json). Source markers progressed;
four-peer maximum callback gaps were 103–160 ms. Same-host source-draw/callback
median age was 146–235 ms and p95 was 176–280 ms. These include capture/encoding,
relay, decoding, compositor and callback scheduling; they are not synchronized
remote or physical glass-to-glass measurements. First auditable callback was
928ms after initiating capture/publication, including initial attachment.

[The SFU resource summary](livekit-resource-summary.json) covers separately
marked active windows. Two-peer CPU mean/peak was 2.2/3.93%, peak memory 112.1 MiB;
four-peer was 5.6/7.45%, peak memory 126.8 MiB. Four-peer container transmit counters
advanced 12.26 MB across the sampled portion of a 15.96 s window. These are Docker
container observations, not capacity limits or media-only bandwidth estimates.
[Raw samples](livekit-container-stats.jsonl),
[phase markers](livekit-phases.jsonl), [metrics](livekit-metrics.prom) and
[verified local TLS handshake](turn-tls.txt) are retained.

## Original pixels and actual product path

Each of the five receiver/source pairs has an actual decoded natural-resolution
PNG, a source reconstruction from that frozen image's binary marker, and two
1000×220 text crops taken from the same frozen decoded canvas:

- [Two-peer decoded image](code_2-viewer-2-code-1-decoded-natural.png) and
  [source](code_2-viewer-2-code-1-source-natural.png).
- Four-peer viewer2: [share1 decoded](code_4-viewer-2-code-1-decoded-natural.png)
  and [source](code_4-viewer-2-code-1-source-natural.png);
  [share2 decoded](code_4-viewer-2-code-2-decoded-natural.png)
  and [source](code_4-viewer-2-code-2-source-natural.png).
- Four-peer viewer4: [share1 decoded](code_4-viewer-4-code-1-decoded-natural.png)
  and [source](code_4-viewer-4-code-1-source-natural.png);
  [share2 decoded](code_4-viewer-4-code-2-decoded-natural.png)
  and [source](code_4-viewer-4-code-2-source-natural.png).

The corresponding `text-14px.png`/`text-16px.png` files and harness Fit/1:1/2×
screenshots are beside them. Crop PSNR observations range 24.1–39.1 dB; no
arbitrary PSNR threshold certifies readability. The corrected reference's 18-glyph
probe advances are 151.224609375 px at 14 px and 172.828125 px at 16 px, identical for
both sources and all five reconstructed references. The received/source color
difference remains an observation; this does not identify its pipeline cause.

The same receiver then rejoined through actual Flux, selected one of two
screens, received 2560×1440, exercised [1:1](code-product-one-to-one.png)
(rendered width × devicePixelRatio equals natural width), and
[200% zoom](code-product-zoom-two.png). After **Back to work**, ordinary pointer
actions opened [actual diagnostics](code-product-diagnostics.png). Voice now
measured 99 kbit/s, 3 ms jitter, 0.0% interval loss and 0 gaps total through raw
RTCRtpReceiver reports; the locked SDK's audio summary omits packet counters.
One hidden-screen transition produced a measured 3 fps warning, while the other
screen row showed 14.5 fps. This is observed visibility behavior, not a claim that
every stream sustains healthy performance after its view closes.
The diagnostics screenshot shows the panel/header; numeric rows are below its
captured fold. The actual DOM assertions and raw report establish the measured
author-run path. The image alone cannot corroborate those numerical values.

## Retained failures and open criteria

[Diagnostic logs](diagnostic-failures/) preserve initial type/build failures,
the capture/content-geometry mismatch, restrictive Docker-DNS setup failures,
and selected `prflx` candidates. Those candidates were never relabeled as passing
relay evidence. Their raw reports remain beside the logs. The source run at 7cfa
also records the existing stage/popover stacking problem: the stage intercepts
the Connection details pointer click. The passing path uses a real control to
return to work; simultaneous stage/popover interaction remains unresolved.
The first temporary cached-image runner attempt used an old image-tag reference
and failed before runtime; its diagnostic is retained separately.

The previous [generic-font corpus](diagnostic-failures/generic-font-dbec/metadata.json)
is also retained unchanged: actual decoded glyphs were materially narrower than
some reconstructed source images. Independent inspection confirmed that its
approximately 15 dB comparisons could not support a codec-quality inference.
The font was pinned before the revised run; no numeric acceptance criterion
was weakened and the actual remaining color differences were preserved.

An additional default legacy-profile regression found an initial RTP-stream
change invalidating its old fps assumption; two other media cases passed. The
legacy harness now waits for a bounded valid same-stream decoded-frame interval,
without restoring an instantaneous-fps fallback. The final
[legacy run](legacy-regression/run.log) passed exit 0: all three media cases,
11 units and both gate regressions. Its [metadata](legacy-regression/metadata.json)
pins harness `bc02d25434d3fa8e8e5ef1580f3d73bd96de34e8`, the unchanged 7cfa
application image and the ordinary automatic ICE policy. It preserves the
existing lower-resolution fixed/variable netem delay, loss and recovery checks;
those observations are not high-resolution impairment evidence.

The [independent re-review](independent-review.md) resolved all three production
diagnostic findings in four independent SDK/core probes and 11 existing units,
with separate TypeScript/lint checks. It audited all five revised original-pixel
reference pairs: sampled ink widths match exactly, and all ten retained native
text crops have no material legibility finding in that limited image scope.
The unchanged original report is [preserved](independent-review.original.md),
SHA256 `267c2c9c21165f6d06766621f77e7b352f23f7bd1b93fb471bc31f9d694cf7ad`;
the readable copy normalizes temporary paths only. The original generic-font
failure and remaining color differences are retained.

The evaluator did not independently operate the running product UI or verify
static/hidden-transition behavior. Thresholds remain provisional until broader
peer calibration. This profile
did not verify speech intelligibility, camera/motion, physical captures/devices,
weak individual receivers, public restrictive networks, k3s, or high-resolution
impairment/recovery windows. Earlier legacy degradation/recovery evidence is
separate and cannot be attributed to this 1440p corpus. Required #63 outcomes
remain open. The [protocol](../../../live-code-calibration.md) and
[k3s evidence](../../live-k3s/2026-09-30/ARCHIVE.md) describe their respective limits.
