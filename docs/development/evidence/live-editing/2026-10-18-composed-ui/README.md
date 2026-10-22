# Composed author UI attempts, 2026-10-18

These retained author attempts are **not whole-issue acceptance**. Each keeps its
actual source, runtime inventory, failed assertions/errors and raw log hash.
The later minimap/native-SVG repair and trusted-Copy observer need their own
checks; they cannot relabel the outcomes below. No independent review was
submitted in these author iterations.

| Source | Actual engine/stage | Methods | Passed | Failed | Errors | Time |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `a093e221` | Docker build | 0 | 0 | — | — | — |
| `078690b2` | Chromium | 6 | 2 | 4 | 0 | 35.106s |
| `3cb39da1` | Chromium | 4 | 2 | 2 | 0 | 49.762s |
| `4618e319` | WebKit | 6 | 3 | 2 | 1 | 49.335s |

All four runner exits are 1; there are no skips. The build-only failure is the
new JS reference helper's missing browser-global declarations, subsequently
corrected. It ran no API/browser check and has no runtime inventory.

## Observations and unresolved failures

- Chromium at `078690b2`: existing minimap pointer navigation and phone layout pass.
  The new renderer comparison wrongly demanded 1e-7 CSS-pixel agreement from
  serialized styles/DOMMatrix; measured differences are below 0.001 CSSpx and
  the actual recorded raster difference is zero. Both new renderer methods
  fail before completing their intended controls. The first clipboard observer
  races unsupported/unpermitted copy/paste access; IME's new witness incorrectly
  demands trusted CDP composition-end events although the actual end is untrusted.
- Chromium at `3cb39da1`: mixed-size native marks, both themes, DPR1/2 and frozen-frame
  navigation pass; full 99,999/100,000 text, concurrent own-undo and quota refusal
  pass. The 500/200 method gets pixel-identical recorded raster comparisons but
  misattributes screenshot-harness style reads (6 versus an assumed 3) to the
  product; this is a FAIL. The native CDP IME preedit/commit runs in both cases,
  but the boundary assertion inspects the peer's virtualized beginning rather
  than reaching its end; that method is a FAIL. The successor `4618e319` fixes those
  observation assumptions; it does not change application source versus `3cb39da1`.
- WebKit at `4618e319`: existing minimap pointer navigation, phone layout and the full
  IME method pass. The IME journey uses native GTK Simple input through XTEST
  on an isolated headed display, with trusted preedit/commit witnesses for both
  the small document and 100,000-character boundary, exact shared public heads
  and unchanged saved history. This proves native GTK Unicode composition,
  not a physical Japanese/iOS keyboard or kana candidate UI. Chromium keeps its
  original kana/CDP path; its observed untrusted end is not claimed as native-end
  proof. The `1b497379` historical WebKit IME error is not retroactively cleared.
- WebKit at `4618e319`: the 500 small-mark Canvas raster differs from the SVG image
  reference by 0.16033 relative alpha despite exact reconstructed geometry;
  the mixed-size DPR2 comparison also exceeds its 2-channel color cap. These
  are genuine failures of the proposed equivalence evidence, pending actual
  native-renderer diagnosis. The clipboard API raises `NotAllowedError`, so
  the quota/undo method remains unverified on WebKit. No raster cap was raised.

The later trusted-Copy payload candidate at `9507a385` reads the real trusted,
handled `text/plain` event after CodeMirror's handler, with a fresh nonce and
sentinel; it changes no editor content or event. It still needs actual checks
and verifies the user Copy output, not operating-system clipboard/paste access.
A native-SVG affine/memoized renderer is now the application candidate after
these failures. Its source and subsequent runtime results must be recorded
separately; no passing minimap latency is claimed here.

[Attempts and raw hashes](author-attempts.json), the three `*-runtime.json`
actual running API/DB/UI inventories and the compressed logs retain source
pins. Inventories include only allowlisted environment fields, container/image
IDs and actual Python/Playwright versions. The plain [native input control](native-ime-plain-control.json)
ran against a textarea only; it establishes native event feasibility, not Flux
acceptance. [Cleanup](cleanup.json) observes zero containers, volumes, networks
and project-tagged images for all four finished owned projects. User demo/Qwen
services and another owned, currently running author check were not modified.
The two temporary dependency/input diagnostic image tags were also removed.

Original screenshots and logs remain under `/home/hubert/flux-evidence/228-*`.
The previous canonical failure remains p95 220.806 ms > 200 ms at `dfe3d7f7`, all 2160 rows,
COMPLETE 3231-record queue. No full nine-cohort rerun occurred in these attempts.
Final original AC-1–AC-5/Gate-1–Gate-4, native renderer/copy checks, integrated
functional/visual evidence and eligible independent approval remain required
before the same whole-issue PR can merge or #228 can close.
