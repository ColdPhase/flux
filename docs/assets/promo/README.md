# README promo animation

`flux-promo-light.svg` and `flux-promo-dark.svg` lead the README ([#780](https://github.com/ColdPhase/flux/issues/780)).
They are a 16-second loop in the final design Prostota ([guide](../../design/final/README.md)): a drawn Flux
window (sidebar, the project "Community garden sensors", the conversation, the Wiki panel, the Map) and a phone,
in the design tokens, Geist and Kreska, with no accent colour. It is a stylised drawing, not a screenshot. A slow
camera moves over the window:

1. Kreska draws itself, the "flux" wordmark appears, and both settle into the window's sidebar.
2. Jonas asks: "Should we measure soil moisture first?" The pointer makes it a task: the message lifts into
   #12, "Measure soil moisture first".
3. Ada accepts the decision "Measure moisture before buying sensors".
4. Claude Code (Kreska, as an agent, with its Agent tag) waves and picks up #12. Its status line types "Reading
   soil data from 12 beds…", then "Writing the result in the Wiki…".
5. The result lands in the Wiki and turns **Positive**; #12 is Done.
6. The Map links the message, the task, the decision and the result; the result lights up.
7. A phone slides in with the same work in the Inbox ("Needs you"), then: "People and agents, one project.
   Open source · self-hosted · your own agents".

**How it is built.** `scripts/promo/build_promo.py` writes both SVGs: SVG shapes animated by CSS keyframes inside
the file, with no script and no external font. Geist's glyphs (`app/apps/web/src/ui/fonts`, SIL OFL) are shaped
by HarfBuzz and stored once each as paths, so GitHub can show the file through `<img>` and it still animates.
The README picks the theme with `<picture>` and `prefers-color-scheme`. With reduced motion the animation stops
on the end line. Each SVG stays under 150 KB.

```sh
./scripts/make_promo.sh      # in Docker: both SVGs
./scripts/make_promo.sh run python3 scripts/promo/render_promo.py sheet docs/assets/promo/flux-promo-dark.svg sheet.png 3,7,10.9,14.5
```

To change the story, edit the scenes and the camera in `build_promo.py` (times are seconds of the 16-second loop)
and run the command again; do not edit the SVGs by hand.
