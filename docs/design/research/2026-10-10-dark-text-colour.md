# Dark-theme text colour and grey hierarchy (research note)

Date: 2026-10-10. Author: Claude (as Zamojski5). Refs #336.

Question (founder Maurycy): our dark theme's grey text on near-black reads
poorly. Not a WCAG-compliance question: what do the people who built leading
SaaS products and design systems say about text colour, grey hierarchy and dark
mode?

Our dark tokens (`app/apps/web/src/ui/tokens.css`): `--bg #111111`,
`--el #1c1c1c`, `--t1 #f0f0f0`, `--t2 #acacac`, `--t3 #8c8c8c`; Geist font;
`-webkit-font-smoothing: antialiased` set globally (`ui.css:8`). Light: `t1
#18181b`, `t2 #4a4a4a`, `t3 #6b6b6b`.

Evidence labels: **[primary]** fetched from the builder's own site this session;
**[primary, not re-fetched]** a primary source cited from prior knowledge and
not re-opened on 2026-10-10; **[community]**; **[inference]** our reasoning.
This note was produced under a hard time limit; items marked "not re-fetched"
should be re-opened before being quoted in a decision.

## What the builders say

1. **Linear: lighter text in dark mode, contrast as a theme variable.**
   "How we redesigned the Linear UI (part Ⅱ)", Karri Saarinen with Yann-Edern
   Gillet, Andreas Eldh and Romain Cascino, 2024-03-28. Themes are generated in
   LCH (perceptually uniform lightness) from base, accent and a *contrast*
   variable that can produce high-contrast themes. They improved content
   contrast by "making our text and neutral icons darker in light mode and
   lighter in dark mode". **[primary]**
   <https://linear.app/now/how-we-redesigned-the-linear-ui> (accessed 2026-10-10)
2. **Vercel Geist: secondary text is one step, `gray-900`.** The Geist colour
   page assigns `gray-900` to "Secondary text and icons" and `gray-1000` to
   primary text; the page serves only CSS variables, not hex. **[primary]**
   <https://vercel.com/geist/colors> (accessed 2026-10-10). The dark value of
   `gray-900` is `#a1a1a1` and `gray-1000` `#ededed` on `background-100
   #0a0a0a` **[primary, not re-fetched]**. `https://vercel.com/design.dark.md`
   was fetched and now describes a brand token set (`--vbg-text-primary`,
   `--vbg-text-secondary`, no tertiary text token) with values only in a
   stylesheet; it gives no hex values. **[primary]** (accessed 2026-10-10)
3. **Apple HIG: hierarchy by label level, dark labels are tinted, not grey.**
   Dark `label` is white; `secondaryLabel` is `#EBEBF5` at 60% and
   `tertiaryLabel` `#EBEBF5` at 30% (a faint blue-grey tint, alpha over the
   surface). Apple reserves tertiary for placeholder/disabled-like content, not
   for reading text. **[primary, not re-fetched]**
   <https://developer.apple.com/design/human-interface-guidelines/color>
4. **Material Design (2018 dark theme): opacity tiers over `#121212`.** High
   emphasis 87% white, medium 60%, disabled 38%; dark grey `#121212` rather
   than black, and elevation shown by lighter surfaces. Medium (60%) is the
   lowest tier intended for reading. **[primary, not re-fetched]** — the page
   was fetched on 2026-10-10 but served only a client-rendered shell.
   <https://m2.material.io/design/color/dark-theme.html>
5. **Radix Colors: only two text steps.** Step 11 is "low-contrast text",
   step 12 "high-contrast text"; steps 1–10 are backgrounds, borders and
   solids. Steps 11 and 12 "are guaranteed to Lc 60 and Lc 90 APCA contrast
   ratio on top of a step `2` background". There is no third text grey.
   **[primary]** <https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale>
   (accessed 2026-10-10). Dark gray 11 `#b4b4b4`, 12 `#eeeeee`, step 1
   `#111111` **[primary, not re-fetched]**.
6. **Stripe: build the system on perceptual lightness, then pick text levels
   with guaranteed contrast.** "Designing accessible color systems" (Daryl
   Koopersmith and Wilson Miner, 2019-10-15): "Perceptually uniform color
   spaces model colors based on factors that relate more to human vision";
   they rebuilt the palette so that "any two colors are guaranteed to have
   sufficient contrast for small text if they are at least five levels apart".
   **[primary]** <https://stripe.com/blog/accessible-color-systems>
   (accessed 2026-10-10)
7. **Refactoring UI (Adam Wathan, Steve Schoger): fewer greys, hierarchy by
   weight and colour together; tint the greys.** Use two or three text colours
   at most (dark for primary, grey for secondary, lighter grey for tertiary);
   do not use grey text on coloured backgrounds, pick a colour of the
   background's hue instead; "your greys don't have to be grey" — warm or cool
   saturation reads more intentionally. **[primary, not re-fetched]**
   <https://www.refactoringui.com/> (book, 2018) and
   <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>
8. **`-webkit-font-smoothing: antialiased` thins light-on-dark text on macOS.**
   MDN: the property is non-standard, macOS-only; `auto` uses subpixel AA
   where available, `antialiased` smooths at pixel level. **[primary]**
   <https://developer.mozilla.org/en-US/docs/Web/CSS/font-smooth> (accessed
   2026-10-10). Practitioners explain the trade-off: subpixel rendering made
   light-on-dark text look "overly bold", so `antialiased` was used to thin
   it, but applied site-wide it makes text "more slender" (Dmitry Fadeyev,
   "Please Stop 'Fixing' Font Smoothing", usabilitypost, 2012-11-05;
   Wealthfront engineering, "Webkit's -webkit-font-smoothing can make you
   fat"). **[community]** macOS dropped subpixel AA by default in Mojave
   (2018), so on current Macs the difference is smaller than these older posts
   show (Michael Tsai, "macOS 10.14 Mojave Removes Subpixel Anti-aliasing").
   **[community]** Our reading: grey text on near-black already has little
   contrast, and thinner strokes reach full brightness on fewer pixels, so
   the global rule can make `t2`/`t3` look fainter. **[inference, not
   measured]** A web search on 2026-10-10 for 2026 discussion of this topic
   returned no 2026 sources; H2 2026 HN/X/Reddit threads were not found in
   this session.

## Comparison on our `--el #1c1c1c`

Computed with a local script (WCAG 2 relative luminance; APCA 0.0.98G-4g
constants; negative Lc = light text on dark). Alpha tokens are composited on
`#1c1c1c`.

| Token | Hex on `#1c1c1c` | WCAG | APCA Lc |
| --- | --- | --- | --- |
| Flux t1 | `#f0f0f0` | 14.95:1 | -96.5 |
| **Flux t2 (current)** | `#acacac` | 7.51:1 | -55.8 |
| **Flux t3 (current)** | `#8c8c8c` | 5.07:1 | -39.0 |
| Flux t2 (separate PR) | `#bdbdbd` | 9.07:1 | -65.3 |
| Flux t3 (separate PR) | `#a1a1a1` | 6.60:1 | -49.8 |
| Vercel Geist gray-1000 | `#ededed` | 14.56:1 | -94.5 |
| Vercel Geist gray-900 (secondary) | `#a1a1a1` | 6.60:1 | -49.8 |
| Radix gray 12 dark | `#eeeeee` | 14.69:1 | -95.2 |
| Radix gray 11 dark | `#b4b4b4` | 8.22:1 | -60.2 |
| Material high (87% white) | `#e1e1e1` | 13.03:1 | -86.9 |
| Material medium (60% white) | `#a4a4a4` | 6.84:1 | -51.4 |
| Material disabled (38% white) | `#727272` | 3.54:1 | -26.7 |
| Apple label | `#ffffff` | 17.04:1 | -106.3 |
| Apple secondaryLabel (`#EBEBF5` 60%) | `#98989e` | 5.94:1 | -45.3 |
| Apple tertiaryLabel (`#EBEBF5` 30%) | `#5a5a5d` | 2.48:1 | -16.6 |

Observations **[inference]**:

- Our current `t3 #8c8c8c` (Lc 39) sits below every system's *reading*
  secondary tier (Geist 49.8, Material 51.4, Radix 60.2) and is close to
  Apple's secondaryLabel only because Apple's secondary is meant for short
  labels on a black surface, not body copy. APCA's published levels (Myndex, not
  re-fetched) put Lc ~45 as a floor for large/bold non-body text and ~60 for
  body text, and Radix guarantees Lc 60 for its low-contrast text step, so `t3` at 39 is
  in "non-reading" territory while we use it for metadata people read.
- Our `t2 #acacac` (Lc 56) is in line with Geist/Material secondary; the
  systems that care most about reading (Radix) go lighter, to Lc ~60.
- The proposed values (`t2 #bdbdbd` Lc 65, `t3 #a1a1a1` Lc 50) make `t3`
  equal to Geist's secondary and `t2` slightly above Radix step 11, i.e. a
  two-and-a-half-level hierarchy consistent with the references.
- No reference system has a *third* readable grey: Radix has two text steps,
  Geist one secondary, Material and Apple put the third tier at disabled /
  placeholder contrast.

## Recommendation

1. Adopt the separate PR's dark values (`t2 #bdbdbd`, `t3 #a1a1a1`); they move
   both greys into the range every reference uses for readable text.
2. Treat `t3` as metadata only (timestamps, counts, hints). Body and list text
   use `t1`/`t2`; express hierarchy also with weight/size (Refactoring UI),
   not only by dimming.
3. Keep the dark surfaces at `#111111`/`#1c1c1c` (Material and Radix both use
   dark grey rather than black), but consider a slight cool or warm tint for
   greys (Apple `#EBEBF5`, Refactoring UI) in a later visual review.
4. Test removing global `-webkit-font-smoothing: antialiased` for the dark
   theme only (or scoping it to large display text) and compare screenshots on
   macOS at the same zoom; record the result before changing the default.
5. Long term, define greys by perceptual lightness (OKLCH/LCH) with a
   contrast setting, as Linear and Stripe describe, so light and dark stay
   balanced when we tune them.

## Not done in this session

- Re-opening the Apple, Material (did not render), Refactoring UI pages and
  the Geist/Radix dark hex tables on 2026-10-10 (those values are cited from
  prior knowledge and marked "not re-fetched").
- Finding H2 2026 HN/X/Reddit discussions on dark-mode grey text and font
  smoothing (one search on 2026-10-10 returned only 2012–2025 sources).
- Rendered macOS comparison of font smoothing on and off.
