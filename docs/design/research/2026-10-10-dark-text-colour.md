# Dark-theme text colour and grey hierarchy (research note)

Date: 2026-10-10; revised 2026-10-11 after the changes-requested review at
`6e97de8e` (PelikanFix16). Author: Claude (as Zamojski5). Refs #336.

Question (founder Maurycy): our dark theme's grey text on near-black reads
poorly. Not a WCAG-compliance question: what do the people who built leading
SaaS products and design systems say about text colour, grey hierarchy and dark
mode?

## Token values: historical and current

- **Historical baseline (no longer on main).** Dark `--t2 #acacac` and
  `--t3 #8c8c8c` on `--el #1c1c1c`, as in `app/apps/web/src/ui/tokens.css` at
  `919dd883` (2026-10-10 13:42 +02:00), the commit before #439. This research
  branch was based on `05f89591` (2026-10-09), which had the same values. Do not
  read these as current.
- **Current (on main).** Dark `--t2 #bdbdbd` and `--t3 #a1a1a1` in both dark
  blocks of `app/apps/web/src/ui/tokens.css`, since `b14a1bf2` (#439, "raise
  dark-theme secondary and meta text contrast"). The design contract is
  `docs/design/final/README.md` (rows `--t2` and `--t3`), which also records the
  historical values.
- Light theme: `t1 #18181b`, `t2 #4a4a4a`; `t3` was `#6b6b6b` and is now `#636363` (#433): AA 4.5:1 on `--side`, `--sub` and `--hov` as well as `--bg` and `--el`.
- Surfaces: dark `--bg #111111`, `--el #1c1c1c`. Text is Geist.
  `-webkit-font-smoothing: antialiased` is set globally
  (`app/apps/web/src/ui/ui.css:8`).

Evidence labels: **[primary]** fetched from the source, with the date given;
**[primary, not re-fetched]** cited from prior knowledge and not reopened, so it
is unverified and appears only in the appendix; **[community]**; **[inference]**;
**[measured]** computed from the hex values above.

## What the builders say

1. **Linear: lighter text in dark mode, contrast as a theme variable.**
   "How we redesigned the Linear UI (part II)", Karri Saarinen with Yann-Edern
   Gillet, Andreas Eldh and Romain Cascino, 2024-03-28. Themes are generated in
   LCH from base, accent and a *contrast* variable. They improved content
   contrast by "making our text and neutral icons darker in light mode and
   lighter in dark mode". **[primary]**
   <https://linear.app/now/how-we-redesigned-the-linear-ui> (accessed 2026-10-10)
2. **Vercel Geist: secondary text is one step, `gray-900`.** The Geist colour
   page assigns `gray-900` to "Secondary text and icons" and `gray-1000` to
   primary text; the page serves only CSS variables, not hex. **[primary]**
   <https://vercel.com/geist/colors> (accessed 2026-10-10). The dark values
   (`gray-900` `#a1a1a1`, `gray-1000` `#ededed`) are **[primary, not
   re-fetched]** and appear only in the appendix.
3. **Apple HIG: hierarchy by label level; dark labels are tinted.** The HIG colour
   page (fetched 2026-10-10) describes secondary label as "a label of lesser
   importance than a primary label, such as a label used to represent a subheading
   or additional information", quaternary as "such as watermark text", and asks
   for custom colours to "supply light and dark variants, and an increased
   contrast option for each variant". **[primary]**
   <https://developer.apple.com/design/human-interface-guidelines/color>. The RGBA
   values (`label` white, `secondaryLabel` `#EBEBF5` at 60%, `tertiaryLabel`
   `#EBEBF5` at 30%) are **[primary, not re-fetched]**; the page body did not
   render on 2026-10-10.
4. **Material Design (2018 dark theme): opacity tiers over `#121212`.** High
   emphasis 87% white, medium 60%, disabled 38%. **[primary, not re-fetched]**;
   the page served only a client-rendered shell on 2026-10-10.
   <https://m2.material.io/design/color/dark-theme.html>
5. **Radix Colors: text is assigned to steps 11 and 12.** Step 11 is
   "low-contrast text", step 12 "high-contrast text"; steps 1 to 10 are
   backgrounds, borders and solid colours. Steps 11 and 12 "are guaranteed to Lc
   60 and Lc 90 APCA contrast ratio on top of a step `2` background from the same
   scale". **[primary]**, re-fetched 2026-10-11
   <https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale>.
   This guarantee applies to Radix's own scale on its own step 2 background. It
   says nothing about Flux surfaces. The dark hex values (gray 11 `#b4b4b4`,
   gray 12 `#eeeeee`, step 1 `#111111`) are **[primary, not re-fetched]**; a
   raw-CSS fetch on 2026-10-11 returned HTTP 404.
6. **Stripe: build the system on perceptual lightness, then pick text levels with
   guaranteed contrast.** "Designing accessible color systems" (Daryl Koopersmith
   and Wilson Miner, 2019-10-15): "Perceptually uniform color spaces model colors
   based on factors that relate more to human vision"; they rebuilt the palette so
   that "any two colors are guaranteed to have sufficient contrast for small text
   if they are at least five levels apart". **[primary]** (accessed 2026-10-10)
   <https://stripe.com/blog/accessible-color-systems>
7. **Refactoring UI (Adam Wathan, Steve Schoger): fewer greys; hierarchy by weight
   and colour together.** **[primary, not re-fetched]** <https://www.refactoringui.com/>
   (book, 2018). Advice only; not used as measured evidence here.
8. **`-webkit-font-smoothing: antialiased` on light-on-dark text.** MDN: the
   property is non-standard and macOS-only; `antialiased` smooths at pixel level.
   **[primary]** <https://developer.mozilla.org/en-US/docs/Web/CSS/font-smooth>
   (accessed 2026-10-10). Practitioners say the setting makes light-on-dark text
   slimmer (Dmitry Fadeyev, "Please Stop 'Fixing' Font Smoothing", 2012-11-05;
   Wealthfront engineering, "Webkit's -webkit-font-smoothing can make you fat").
   **[community]** macOS dropped subpixel anti-aliasing in Mojave (2018), so the
   effect on current Macs may be smaller than these posts show. Whether it makes
   Flux's `t2`/`t3` harder to read is **[inference, not measured]**.

## APCA levels (re-fetched 2026-10-11)

Source: <https://git.apcacontrast.com/documentation/APCAeasyIntro.html> **[primary]**.
The fetch tool returns an extracted rendering, so check wording against the page
before quoting it outside this note.

| Lc | Stated use (as extracted) |
| --- | --- |
| 90 | Preferred for fluent text and body columns with a font no smaller than 14px/400. |
| 75 | Minimum for body columns at 18px/400; "consider Lc 75 as a minimum for text where readability is important". |
| 60 | Minimum for content text that is not body, column or block text: 24px/400 or 16px/700. |
| 45 | Minimum for larger, heavier text: 36px/400 or 24px bold, such as headlines. |
| 30 | Absolute minimum for any text not listed above, including placeholder and disabled text. |

The same guide says: "Without considering the use case, size, thickness, etc.,
such ratios are not instructive." The Lc levels therefore mean something only
together with size, weight and use.

## Measured comparison on `--el #1c1c1c` [measured]

Computed on 2026-10-11 with WCAG 2 relative luminance and APCA 0.0.98G-4g (negative
Lc is light text on dark) from the published formulas. The script was a local
scratch file and is not committed.

| Flux token | Hex | WCAG on `#1c1c1c` | APCA Lc |
| --- | --- | --- | --- |
| t1 (main) | `#f0f0f0` | 14.95:1 | -96.5 |
| t2 historical (pre-#439) | `#acacac` | 7.51:1 | -55.8 |
| t3 historical (pre-#439) | `#8c8c8c` | 5.07:1 | -39.0 |
| t2 on main (#439) | `#bdbdbd` | 9.07:1 | -65.3 |
| t3 on main (#439) | `#a1a1a1` | 6.60:1 | -49.8 |

## What the evidence supports for Flux's 12–14px metadata

- On `--el`, #439 raised both greys: WCAG 7.51 to 9.07 for t2 and 5.07 to 6.60 for
  t3; APCA -55.8 to -65.3 and -39.0 to -49.8. **[measured]**
- Against the APCA levels above, t2 (Lc 65) clears the Lc 60 level, whose minimums
  assume 24px/400 or 16px/700 text. It does not reach the Lc 75 body-column minimum
  or the Lc 90 preferred level for fluent text at 14px/400. t3 (Lc 50) clears the
  Lc 45 level, which the guide assigns to 36px/400 or 24px bold headlines. It does
  not reach Lc 60.
- Flux's metadata is 12–14px, as stated in the review (size and weight not
  re-measured here). The guide's sized levels start at 14px/400, tied to Lc 90, and
  it gives no level for 12–13px text. For text at that size, APCA's levels are
  therefore not defined by the guide.
  **APCA therefore does not establish that t3 is readable for Flux's metadata, and it
  does not show that it is not.**
- `scripts/check_contrast.py` enforces `APCA_MINIMUM` t2 at 60 and t3 at 45 on
  `--bg`, `--el` and `--sub`. Those floors are the guide's levels for larger text.
  Applying them to 12–14px metadata is a gap to decide in review, not a verdict.
- Radix's Lc 60 guarantee is for its step 11 on its own step 2 background. It is not
  a measurement of Flux and is not used as one here.
- Vendor tier names ("secondary", "secondaryLabel", "medium emphasis") are semantic
  labels. They do not state a readability threshold for any size.
- WCAG 2 SC 1.4.3 sets 4.5:1 for normal text (prior knowledge, not re-fetched). Both
  #439 values pass it on `--el`. It does not depend on size, so it does not answer
  the metadata question.

**Not measured:** how the greys render at 12–14px in the running app, in both
themes, on macOS, with font smoothing as set and with it removed, at the same zoom.
That in-app check is the open item.

## Recommendation (limited to the evidence above)

1. Keep the #439 values on main. The measured comparison shows they have higher
   contrast than the historical pair on `--el`. By itself it does not establish
   readability at 12–14px.
2. In peer review, decide whether the APCA floors for metadata (t3 at 45) should be
   size-specific. The guide's levels for body-size text (Lc 90 at 14px/400, Lc 75 at
   18px/400) are higher than the current floors. This docs PR does not change
   `check_contrast.py` or the tokens.
3. Before changing `t3` again, render the metadata at 12–14px in the running app,
   both themes, on macOS with and without `-webkit-font-smoothing`, at the same
   zoom. Record the result. **[not measured]**
4. Treat the font-smoothing effect as a hypothesis until step 3 is done.
5. Long term, consider defining greys by perceptual lightness (OKLCH or LCH) with a
   contrast setting, as Linear describes. This is not needed for this change.

## Appendix: unverified reference values (not used above)

Reference values were composited or compared on Flux's `#1c1c1c` for comparability.
The vendors' own surfaces differ. None of these were re-fetched on 2026-10-11. The
figures were reproduced with the same script on 2026-10-11, so the arithmetic is
checked, but the source values are not.

| Reference | Hex | WCAG on `#1c1c1c` | APCA Lc |
| --- | --- | --- | --- |
| Vercel Geist gray-1000 (primary) | `#ededed` | 14.56:1 | -94.5 |
| Vercel Geist gray-900 (secondary) | `#a1a1a1` | 6.60:1 | -49.8 |
| Radix gray 12 dark | `#eeeeee` | 14.69:1 | -95.2 |
| Radix gray 11 dark | `#b4b4b4` | 8.22:1 | -60.2 |
| Material high (87% white) | `#e1e1e1` | 13.03:1 | -86.9 |
| Material medium (60% white) | `#a4a4a4` | 6.84:1 | -51.4 |
| Material disabled (38% white) | `#727272` | 3.54:1 | -26.7 |
| Apple label | `#ffffff` | 17.04:1 | -106.3 |
| Apple secondaryLabel (`#EBEBF5` at 60%) | `#98989e` | 5.94:1 | -45.3 |
| Apple tertiaryLabel (`#EBEBF5` at 30%) | `#5a5a5d` | 2.48:1 | -16.6 |

## Not done

- Rendered check of Flux's 12–14px metadata in the running app, both themes, with
  font smoothing on and off on macOS.
- Re-fetch of the Geist, Radix, Apple and Material dark hex values. The Radix raw
  CSS URL returned 404 on 2026-10-11; Material served a shell only on 2026-10-10.
- H2 2026 HN, X and Reddit discussion. Searches on 2026-10-10 found only 2012 to
  2025 sources.
- A size-specific APCA floor for metadata. This needs a review decision.
