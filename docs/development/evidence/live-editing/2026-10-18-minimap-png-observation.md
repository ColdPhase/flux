# Minimap native SVG PNG observation — 2026-10-18

Preimplementation method record for existing #228 / Draft PR #613, admitted by the
parent implementation coordinator before changing the test instrument. This is
not independent review or Gate 4 acceptance. No product geometry, rendering,
latency driver, sample denominator, cadence, threshold or collector changes.

The Canvas proposal did not preserve WebKit's native SVG raster. The replacement
uses native SVG marks with a shared affine frame and memoized native coordinates.
`70a25a7d` is that application change; subsequent commits through
`de9528338889b068ecc4160101bc11606a03aaca` changed only tests/documentation.

The retained WebKit checks at `32cf45b7` and `de952833` remain **FAIL** under their
then-current PNG → Image → Canvas → getImageData RGB observer. The latter's
one 500-thought method took 27.650 s and retained all four palette/DPR raster
pairs before reporting failure. Mixed native sizes and frozen interaction passed
at `32cf45b7`; these do not prove the pending 200-thought movement controls.

Direct, standard-library decoding of the original screenshot PNG IDAT bytes:

- DPR 1, light and dark: no differing pixels.
- DPR 2, each palette: two differing pixels out of 77,056, at (181,25),
  (182,25); alpha differences 5 and 17, sum 22, relative alpha error
  0.00001675683621792113. This is not pixel-exact.
- Maximum straight RGB difference with both alpha > 100 is 2 in the original
  PNGs; the browser PNG → Canvas roundtrip reports 3.
- The genuine alpha differences produce maximum composited RGB differences
  11.11765 over white for the light marks and 8.21569 over #1c1c1c for dark marks.
  Thus the proposed new all-pixel physical limit ≤ 2 was explicitly rejected.
  Those background colors were observed in the contextual PNG and agree with
  source tokens; computed backgrounds will also be recorded by the next fixture.

The original author-selected limits are retained, without increasing any number:
geometry and viewport reconstruction error < .001 CSS px; relative alpha error
< .03; straight RGB difference ≤ 2 where both alpha > 100. The latter was an
initial author heuristic, not a #228 contract requirement or a calibrated WebKit
roundtrip bound. Both deliberate negative raster controls (square corners and
removed minimum dimensions), palettes, DPR 1/2 and actual trusted movement /
frozen minimap interactions remain required.

The correction will decode ORIGINAL screenshot PNG bytes directly in Docker,
using a small fail-closed Python stdlib decoder (8-bit RGBA, non-interlaced;
validated chunks/CRC, bounded inflate, all five PNG row filters; unsupported or
malformed inputs fail). Dimensions and color-profile metadata must match.
The old roundtrip result remains recorded as diagnostic evidence; it is not
silently reinterpreted as a product failure or an old passing result.

PNG uses non-premultiplied alpha; finite precision conversions through the Canvas
premultiplied representation can lose information. These explain a possible
mechanism; the measured original/roundtrip numbers above establish the observed
difference, without claiming all native alpha differences came from conversion.
See [PNG alpha representation](https://www.w3.org/TR/2025/REC-png-3-20250624/#6AlphaRepresentation)
and [Canvas premultiplied alpha](https://html.spec.whatwg.org/multipage/canvas.html#premultiplied-alpha-and-the-2d-rendering-context).

Raw evidence is retained outside Git at
`/home/hubert/flux-evidence/228-minimap-svg-pixel-retention-webkit/` and the sibling
log; complete raw RGBA, premultiplied/composited differences and PNG SHA-256 values
are in `228-minimap-webkit-diagnostic-4618/raw-png-analysis.json`.
That JSON SHA-256: `53fd6243d79cf6455b3760bbb81ce11d91f5669d9219523e7a9b587afdf6c2d3`.

Next verification: two focused WebKit renderer methods, then Chromium's same two
methods plus existing minimap navigation, trusted full-text Copy and native IME
checks. Application bytes are unchanged by this instrument correction. The
parent's single 500/200 latency diagnostic remains separate from these controls.
