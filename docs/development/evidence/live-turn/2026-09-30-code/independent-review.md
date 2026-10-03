# Independent #63 diagnostics delta re-review

Date: 2026-09-30. **The three prior production findings are resolved in independently executed core/SDK reproductions. The glyph-width reference mismatch is also resolved in the revised a58 corpus.** This is a bounded source/regression and retained-pixel verdict, not approval or completion of #63. Running product UI and actual static-screen behavior remain unverified by this evaluator. The failed generic-font corpus remains recorded below.

Pinned checkout: `the original temporary independent checkout (not archived)`, detached at `bc02d25434d3fa8e8e5ef1580f3d73bd96de34e8`. Production fix commit: `7cfa12b60f1eec5a6eb5410b55b9894c095ac920`. The production Live source diff from 7cfa to bc02 is empty; source is also unchanged through the later test-only font fix `a58d9b9fcb496e655c751fa46308a24d8e3b86e0`. Author worktree was preserved and no implementation/GitHub mutation was made.

Source pins:

| File | Git blob |
| --- | --- |
| `apps/web/src/live/diagnostics.ts` | `8eb31568950085e67601f7888207ae97f872bf0d` |
| `apps/web/src/live/receiver-quality.ts` | `1cf81a1fa78b8bfdd5f550675429ce86dd205d32` |
| `apps/web/src/live/media.ts` | `ede32dfd65a91d6e1dcb42e26ceffa5b41250271` |

Contract and initial findings remain those pinned in `independent-review/initial-review.original.md`. No thresholds were lowered; optional informational fields still need not force quality unknown.

## Prior findings

| Finding | Result | Independent evidence |
| --- | --- | --- |
| F1: SDK audio helper omits packet counters | Resolved | Production diagnostics now calls the actual track's getRTCStatsReport, selects inbound type/kind/trackIdentifier, and retains raw RTP id. My fresh harness uses the actual ESM SDK RemoteAudioTrack prototype and actual LiveMediaConnection.diagnostics. The old summary still omits packets, proving the adapter boundary is exercised; the production Voice row now reports 0.0% loss and 0 total gaps without an unavailable warning on an advancing raw interval. Wrong track/kind and ambiguity are unknown. RTP-id replacement does not borrow the old baseline. |
| F2: byte-only partial/reset can be good | Resolved | Independently tested missing bytes and decreased bytes with advancing packets/frames for both audio and video: bitrate is `–`, quality unknown, unavailable warning; known zero loss remains an actually calculated interval value. Required bitrate is now part of good-status completeness. |
| F3: pending read resurrects removed history | Resolved | Fresh harness delays the actual SDK raw receiver read used by production diagnostics, then separately removes/forgets the publication or invokes real disconnect. On completion diagnostics returns [] and the history stays empty; the next replacement has no packet baseline. clear/forget increment an epoch and post-await checks reject obsolete reads. |
| Error, intentional mute, quiet and hidden-video pause | Pass in core integration | Actual SDK getStats rejection produces unavailable fields rather than zero loss. Muted publications, hearing=false and streamState=paused suppress warnings. No real product gesture/device/capture claim follows. |

Receiver-scoped selection is appropriate: it uses `track.getRTCStatsReport()` rather than choosing an unrelated record from a room-wide PC report. One matching track record wins; multiple matching records are unknown; a single matching-kind record with no trackIdentifier can be used because the underlying report belongs to this RTCRtpReceiver. Keeping the raw id ensures replacement/reset intervals remain unknown. The previous review's primary-source scope/trackIdentifier references still apply.

## Actual UI evidence reviewed, not independently operated

The author's retained `dbec` corpus and test source were inspected read-only: `diagnostic-failures/generic-font-dbec/focused-run.log`, `diagnostic-failures/generic-font-dbec/code-1440p-report.json`, summary/raw stats, original PNGs, and the production UI section in `tests/app/e2e/live-code-quality.e2e.ts` at bc02. It joins through the actual Flux UI with unchanged automatic ICE settings, opens the existing Connection details table, and reads its DOM rows after generated tone publication. It does not infer real speech quality.

The retained table rows include:

```
code-publisher Voice 99 kbit/s · 0 ms jitter · 0.0 % lost · 0 gaps total
code-publisher Screen 2560×1440 · 2.0 fps · 74 kbit/s · 0.0 % lost · VP8
Video receiving 2.0 fps
code-second Screen 2560×1440 · 16.0 fps · 993 kbit/s · 0.0 % lost · VP8
```

This corroborates the SDK fix in author-run product evidence. The first screen's low-FPS warning is retained, not reclassified as a link failure or passing static-screen behavior. The moving calibration source cannot establish static-source behavior. The PNG `code-product-diagnostics.png` shows the panel and Connection details header at the bottom of its 800px viewport; numerical rows are below that captured fold, so this screenshot alone does not visually corroborate the table measurements. The report/DOM assertions supply the author's behavior evidence. **This evaluator has not independently operated that running app, so product UI and actual static/hidden-transition behavior remain unverified here.**

Author report SHA-256: `05677f781cbfc5780cfff93142e1d3b221b582820634cc5a88166ad0df4f9c6b`; diagnostics PNG SHA-256: `2bdb34c0dfd1b3359933f8b678b679529d94761200d0ba2ca806c3e7b8aa5762`. The report lacks a commit field; source/version association comes from the recorded invocation and unchanged production sources, not an embedded provenance claim.

## Initial calibration evidence finding (original corpus preserved)

**Reference raster differs materially from decoded raster (test/evidence issue, not a production diagnostic regression).** Original-pixel inspection of `code_4-viewer-2-code-2-decoded-natural.png` and `...-source-natural.png` confirms the same share 2/source-frame 223/title/rows but visibly different glyph widths. A separate read-only Chromium pixel audit measured bright-ink extents:

| Region | Decoded width | Reconstructed reference width |
| --- | ---: | ---: |
| Title | 379 px | 469 px |
| First 14px code row | 389 px | 466 px |
| First 16px terminal row | 374 px | 449 px |

The background pixel also differs: decoded RGB `[0,9,24]` versus reconstructed `[16,24,39]`. This establishes differing rasters only; it does not establish a codec, font, colorspace or scaling cause. The harness reconstructs a reference canvas in the receiver page using generic monospace. Thus its approximately 15dB crop PSNR cannot presently be attributed solely to media degradation; it mixes any source/reference rendering difference with the received result. No readability acceptance promise is justified by that number.

Next evidence action already started by the owner: explicit installed Liberation Mono for publisher/reference, source/reference glyph advances, equality assertions and a fresh focused profile, while preserving the generic-font corpus. That test-only `a58d9b9` source was not executed in this report; revised original pixels/reference correspondence remain unverified until received and inspected. Retaining the actual publisher raster for the audited frame would further strengthen provenance.

Read-only pixel audit: `independent-review/reference-integrity.ts` and `independent-review/reference-integrity.log`. No PNG was modified. I make no font-resolution or codec-quality inference from the audit.

## Executed verification and limits

All application tools ran in distinct offline Docker containers with `--cpus 1`, using retained `flux-e2e:flux-live-turn-1790765298-762312`, image ID `sha256:31a721eb636b1112e5188df24cefab00768417481f5483764a51ab95b5dfeaca`. Frozen bc02 sources were copied into each container before source checks; SDK is the locked actual 2.17.2. No host dependency installation, full/heavy suite, infrastructure or physical-device test was performed.

- Existing focused tests: `node_modules/.bin/tsx --test tests/app/live-diagnostics.test.ts tests/app/live-receiver-quality.test.ts` — **11/11 pass**, `independent-review/units.log`.
- Independent delta probes: `node_modules/.bin/tsx --test tests/app/independent63-delta.test.ts` — **4/4 pass**, `independent-review/delta-independent.log`. Harness copied from `independent-review/delta-independent.test.ts` in the container only. These now assert fixed behavior, including production methods and real SDK class identity. Its rapid synthetic reads are not actual network rate measurements.
- Root and web `tsc --noEmit`, scoped ESLint for the three production files — **exit 0**, `independent-review/types.log`.
- `git diff bf6bc398119141b0d398ef1578ae7889a4fea62c HEAD --check` — **pass**; independent checkout status clean.
- Original-pixel Chromium audit — **exit 0**, `independent-review/reference-integrity.log`; evidence difference established, cause unverified.

Independent probe harness SHA-256: `9ca4cfaaade8769b5b5ef5724040b424c47ca00651b200bb74f12971c3627efa`; independent log SHA-256: `f4934385708f8fe6d86fce9171508f5fa7a4b3c39ac12a29f491c7c39e1d9a41`.

The author's selected media/profile runs, revocation/signout and legacy/netem run were not repeated by this evaluator. No CI, eligible approval, real public NAT/k3s, actual desktop/mobile/PWA device matrix, speech/motion quality or whole #63 acceptance is certified.

## Revised reference/pixel review — a58 corpus

Reviewed the test-only font/reference delta at `a58d9b9fcb496e655c751fa46308a24d8e3b86e0`, and retained `.` report plus original decoded/reference PNGs and all ten native 14px/16px crops. Production remains the three blobs pinned above. The author executed the focused media/profile plus units and gate regressions; I did not repeat that media run. I separately ran the read-only Chromium original-pixel audit on all five decoded/reference pairs.

The harness explicitly uses installed Liberation Mono in the source and reconstructed reference and compares 14px/16px glyph advances to the publisher's recorded values. Both publishers and all five reconstructed pairs report 151.224609375 px / 172.828125 px for the probe. My independent bright-ink audit now finds exact horizontal agreement in each of the three sampled regions for all five pairs:

| Pair | Title widths | 14px first-row widths | 16px first-row widths |
| --- | --- | --- | --- |
| two peers, viewer 2, code 1 | 469 / 469 | 483 / 483 | 457 / 457 |
| four peers, viewer 2, code 1 | 469 / 469 | 466 / 466 | 450 / 450 |
| four peers, viewer 2, code 2 | 469 / 469 | 466 / 466 | 449 / 449 |
| four peers, viewer 4, code 1 | 469 / 469 | 466 / 466 | 450 / 450 |
| four peers, viewer 4, code 2 | 469 / 469 | 466 / 466 | 449 / 449 |

The originally reported generic-font width mismatch is **resolved for this new corpus**. The original dbec corpus remains failed on this reference check and is not reclassified. At natural pixel size, all ten retained crops show readable row numbers, identifiers, quotes/brackets and command arguments; I found no material text-legibility problem in these specific crop images. This is a limited retained-image observation, not a universal code-sharing quality threshold, dynamic reading test, whole Fit view, device result or accessibility certification.

Background colors still differ: code 1 decoded `[15,25,37]` versus reference `[16,24,39]`; code 2 decoded `[0,9,24]` versus `[16,24,39]`. The cause is unverified. Corresponding crop PSNR is approximately 35–39dB for code 1 and 24dB for code 2; it remains a descriptive pixel statistic including color differences, not an attributable codec metric or acceptance promise. No extra production fix follows from this limited observation.

The revised author-run UI report again exposes Voice: `99 kbit/s · 3 ms jitter · 0.0 % lost · 0 gaps total`. Its first screen still has a numeric 3fps warning after Back to work; the actual static/hidden-transition behavior remains unverified by this evaluator. This source/reference correction does not close those runtime or wider #63 gates.

Revised report SHA-256: `8c15a9221e2ef0b63cf6d5ec960077905f919dbe35c35aebd8f9f4403828d584`. Independent pixel audit `independent-review/reference-integrity-a58.ts` SHA-256: `614fee79871dff2815854748e717fbe736437db4c5603963427b50230602fb87`; log `independent-review/reference-integrity-a58.log` SHA-256: `33720d3dd7bd11d5a8b5a663576446be0bc417a96f69bf9a8503b206e035ddc5`. Audit exited 0 in its own offline, one-CPU Docker container and changed no PNGs.

Next action: preserve this exact bounded production review and revised pixel evidence; independently reproduce required product/static/hidden-transition behavior at a frozen head and continue the open public, device, quality-calibration and release-candidate #63 acceptance gates. No GitHub approval or merge was performed.
