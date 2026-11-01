# README promo animation

`flux-promo-light.svg` and `flux-promo-dark.svg` lead the README ([#780](https://github.com/ColdPhase/flux/issues/780)).
They are a 12-second loop, drawn in the final design Prostota ([guide](../../design/final/README.md)):
monochrome Soft-volume cards, Geist, Kreska, no accent colour. It is a stylised sketch, not a screenshot:

1. Kreska draws itself and the "flux" wordmark appears.
2. Jonas asks: "Should we measure soil moisture first?"
3. The message lifts into task #12, "Measure soil moisture first", which keeps its source.
4. A decision, "Measure moisture before buying sensors", is accepted.
5. Kreska, as the agent Claude Code, waves, then picks up #12 (In progress).
6. The result turns **Positive** and #12 is Done.
7. "People and agents, one project."

**How it is built.** `scripts/promo/build_promo.py` writes both SVGs: SVG shapes animated by CSS keyframes inside
the file, with no script and no external font. Geist's glyphs (`app/apps/web/src/ui/fonts`, SIL OFL) are shaped
by HarfBuzz and stored once each as paths, so GitHub can show the file through `<img>` and it still animates.
The colours are the design tokens of each theme; the README picks the theme with `<picture>` and
`prefers-color-scheme`. With reduced motion the animation stops on the last frame (the end line).

`flux-promo.webp` is the animated fallback for places that do not play SVG animation: the light SVG captured
frame by frame (Playwright Chromium, each animation seeked to the frame's time) at 12 frames per second,
800 × 450, lossy WebP.

```sh
./scripts/make_promo.sh      # in Docker: both SVGs, then the WebP
./scripts/make_promo.sh run python3 scripts/promo/render_promo.py sheet docs/assets/promo/flux-promo-dark.svg /w/sheet.png 1,4,6.5,9.8
```

To change the story, edit the scenes in `build_promo.py` (times are in seconds of the 12-second loop) and run
the command again; do not edit the SVGs by hand.
