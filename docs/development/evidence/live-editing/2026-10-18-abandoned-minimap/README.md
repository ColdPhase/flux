# Abandoned minimap renderer experiment — 2026-10-18

Existing #228 / Draft PR #613. This experiment was reverted in `6ac818c6`:
`SketchMap.tsx` and `sketch.css` are byte-identical to `dfe3d7f7`; the earlier
thought-content memo remains. Neither Canvas nor grouped SVG is a completed
optimization or an accepted visual change. No independent review was claimed.

Canvas failed native WebKit SVG fidelity. A bounded screenshot diagnostic showed
both a genuine Canvas/native SVG raster difference and an additional SVG-image /
Canvas conversion difference. CPU Canvas, opacity and path variants did not
establish equivalence. The fallback retained native SVG with a shared affine
frame, constant minimum-size CSS expressions and memoized native-coordinate leaves.

Four actual WebKit application attempts, each with recorded immutable API/UI image
and container IDs (inventories alongside this report; raw logs remain outside Git):

| Application/test head | Methods / seconds | Actual result |
| --- | --- | --- |
| `ab0af2ef` | 4 / 32.136 | FAIL: 2 renderer helper-installation errors; phone and trusted 100k Copy passed. |
| `32cf45b7` | 2 / 32.308 | FAIL: mixed sizes/palettes/DPR and frozen interaction passed; 500 marks failed RGB2 after PNG→Canvas conversion. |
| `de952833` | 1 / 27.650 | FAIL retained: all palette/DPR PNGs saved before existing assertions; DPR2 RGB3 after conversion. |
| `c500230f` | 4 / 46.645 | FAIL: mixed renderer and 2 decoder controls passed; camera-prepared 500-mark frame failed ORIGINAL-PNG RGB4. No 200-movement control passed. |

Direct decoding clarified the DPR2 observation: two of 77,056 original pixels
really differed (alpha sum 22; raw RGB2), while the PNG→Canvas observer reported
RGB3. The preimplementation [instrument record](../2026-10-18-minimap-png-observation.md)
kept all original numeric bounds; the new stdlib decoder was checked against all
five row filters and malformed inputs. This did not turn old failed runs into passes.

The later camera-prepared frame at `c500230f` differed at 766/19,264 pixels:
relative alpha 0.0043752014, raw RGB4 > 2, geometry error 0.000018248 CSS px.
Thus even native grouped SVG did not satisfy every original raster control.
All PNGs, including deliberate square/no-minimum controls, remain outside Git.
No Chromium rerun was made for the rejected renderer.

Separately, the parent's single 500/200 diagnostic at `251d9d5e` used identical
application bytes: 240/240 valid observations, no input/socket/timeouts, p95
215.7676259521395 ms > 200. It was not Gate 4 acceptance: unchanged collector
honestly rejected the one-case plan (`closed marker binding invalid`). Raw:
`/home/hubert/flux-evidence/228-svg-map200-251d9d5e-latency/` and sibling run log.

All four application runners exited and removed their own containers, volumes,
networks and two per-run images; cleanup was checked before the heavy slot was
returned. The unrelated demo and Qwen services were preserved. `attempts.json`
pins raw log/runtime hashes and exact sources. Full raw PNG hashes/differences are
in `/home/hubert/flux-evidence/228-minimap-webkit-diagnostic-4618/`; the application
PNGs are in the attempt-specific sibling directories named by the inventories.
