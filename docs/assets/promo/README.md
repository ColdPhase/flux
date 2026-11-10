# README promo animation (not in use)

`scripts/promo/build_promo.py` draws a 16-second looping animation of Flux in the final design Prostota
([guide](../../design/final/README.md)): SVG shapes animated by CSS keyframes, with Geist's glyphs stored as paths, so GitHub
can show the file through `<img>` and it still animates ([#780](https://github.com/ColdPhase/flux/issues/780)).

**Nothing uses it now.** Its story is Flux v0.1's: one project, "Community garden sensors", a task numbered #12 and a Claude Code
agent. The v0.2 README replaced it with screenshots of the running application and a recording
([README screenshots](../readme/README.md), [demo](../demo/README.md)), and the two generated SVGs were deleted. The generator stays,
because it is a tool for a future animation: write the v0.2 story into the scenes first (agents in a space, Inbox, Map), then build.

```sh
./scripts/make_promo.sh      # in Docker: writes docs/assets/promo/flux-promo-{light,dark}.svg, each under 150 KB
./scripts/make_promo.sh run python3 scripts/promo/render_promo.py sheet docs/assets/promo/flux-promo-dark.svg sheet.png 3,7,10.9,14.5
```

Times in `build_promo.py` are seconds of the 16-second loop. Do not edit a generated SVG by hand.
