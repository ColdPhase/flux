# Flux #134 independent visual review

Date: 2026-09-30. Verdict: **acceptable in the inspected visual scope; no material visual problem identified**. This is a screenshot review, not approval of the complete functional issue.

The reviewed capture/runtime commit is `8cff7ed999e7b8510c767e0e4e0ce88e66b87b2f`, runtime image `sha256:cf2c82b3e6ecb6dbe6f70e00cacc514a54aab3894a26f6c5c19e85cae8bb7cb0`. The final assessment uses the immutable `/tmp/flux134-evidence-8cff7ed` corpus. All 17 PNGs were opened individually at original resolution, and their hashes were independently checked against `manifest.json`. Browser zoom is 100% as supplied in the neutral brief; enlarged phone text is the supplied 28 px state. The manifest's test result is capture provenance, not a test performed or certified by this reviewer.

I used the independent visual review skill, repository foundation and shared design guidance, the neutral brief, PNGs and their manifest. I did not inspect implementation code, implementation history or the change author's rationale; did not edit application code; and did not post a GitHub comment or review. The earlier `bb4b241` image corpus was also inspected before the current corpus was supplied, but it does not support this final verdict.

## User job and comparison

A collaborator reads sensing/design thoughts nested three to four levels deep, recognizes a relationship to a separate shallow or top-level thought, follows an exact named destination, and sees a route back to the source. Personal list grouping organizes the display over existing graph relationships; a screenshot cannot establish the persistence or meaning of that organization.

The four refined deep-map references establish subdued hierarchy guides, named relations, bounded phone indentation and nearby actions. The original map-list and search/map references establish the calm connected workspace and restrained content/navigation hierarchy. Their different content prevents a direct row-count comparison; they are visual references, not templates or evidence about application behavior.

## Visible assessment and elements to preserve

- **Hierarchy and graph relationships are visibly distinct.** Bold thought titles, incremental indentation, disclosure markers and quiet vertical guides carry list organization. Links sit below the title, start with “Related to” and use underlined destination names. No crossing wires run over the text. “Quiet hours · a separate direction” remains at the root indentation while related to the deeper selected thought; the relation does not visually present it as another child of that thought. Each observed thought has one main row; repeated names appear as relation labels rather than duplicate thought rows.
- **The selected thought is the focus of the working surface.** Its soft full-row accent and check mark distinguish it from surrounding rows beyond color alone. Edit, Add thought and Group in list… sit beneath the selected thought's information instead of requiring a scan to the opposite end of each row. More relations and Path · level… provide quiet progressive entry points. Actual keyboard focus is not shown by these screenshots and remains unverified.
- **The scale supports reading long titles.** At 1440×900 the chain through level 4 and the start of the separate root are visible; at 1280×800 the same deep title, relationships and local actions fit, with the next root below the viewport. At 390×844, the selected long title wraps over three lines, and level 3 and level 4 use the same bounded content start rather than continuing to narrow the title. The 820×1180 tablet view provides room for the deep chain, separate root and additional thoughts. The supplied views are scrolled states, so offscreen map-level controls are not evidence that those controls are absent.
- **Enlarged text retains the reading lane.** At the supplied 28 px phone state, the selected title, numeric path entry and a named relation wrap within the available width without text colliding with the guide or check mark. Less content fits, as expected. This is evidence about those visible text blocks only; it does not establish full reflow or access to controls outside the capture.
- **Return context is explicit.** In `map-outline-phone-related-follow-back.png`, “Back to ‘Quiet hours · a separate direction’” names the source. The selected destination's complete three-line title is visible at the bottom of the viewport. Its metadata and actions require further scrolling. The edge placement is a live-testing watch point, not a material visual defect in this image, because the exact destination name and return route are both visible.
- **The six light/dark Mint, Iris and Sky states are coherent.** The accent changes links, the soft selection surface and its check mark while title, metadata and guide hierarchy retain the same visual roles. The restraint and readable title weight suit the v11 direction. These observations do not certify contrast ratios or accessibility.

## Material problems

None identified in the 17 current images for this reading-and-following job. The visible result preserves the intended compact, calm workspace and makes the hierarchy/relation distinction understandable. No purely stylistic preference is being presented as a required correction.

## Missing states and live-testing questions

- Expanded ancestor paths and More relations are not pictured. Verify that the full named ancestor path remains available on a 390 px phone and with enlarged text, and that additional relationships remain distinct and individually selectable.
- The phone follow capture places the selected destination close to the bottom edge. Exercise several source/destination positions, long titles and enlarged text to ensure that following reveals the exact destination, while Back restores the exact source and useful reading position. The still image does not prove that transition or restoration.
- The enlarged navigation shows Conversation, Tasks and Map while Docs is outside the visible width; the image cannot establish the overflow route. Test discovery and access to all tabs, map-level actions and local controls with enlarged text, keyboard focus and touch.
- There are no screenshots of grouping controls open, a collapsed deep branch, many additional relations, missing/restricted destinations, errors, or an open details/assistant panel. Verify those affected states in the running application. In particular, confirm grouping's personal display meaning and that relation creation does not silently reorganize the hierarchy.
- Independently test interaction, keyboard behavior, actual color pairs, graph/API/persistence paths and access boundaries. This review makes no WCAG, keyboard, data correctness, privacy, installation, Web Push or PWA claim.

## Current inspected image pins

All filenames below are relative to `/tmp/flux134-evidence-8cff7ed`. The dimensions are read from the PNG headers; every image was inspected.

| File | Dimensions | SHA-256 |
| --- | --- | --- |
| `map-outline-dark-desktop-1280.png` | 1280×800 | `edcf810cf518ef3aeba9eb76c56965844986c15d552b8e10ebe1b63b81caf4da` |
| `map-outline-dark-desktop-1440.png` | 1440×900 | `44ce05ba4056dcfe84983462a2807267685d95709749a1444b9122f6bd4769d0` |
| `map-outline-dark-iris-desktop-1440.png` | 1440×900 | `c246b8e02a6c88274a17fc439bb05c6c0255ef3b7820a862da8fe460b61b1cdf` |
| `map-outline-dark-mint-desktop-1440.png` | 1440×900 | `44ce05ba4056dcfe84983462a2807267685d95709749a1444b9122f6bd4769d0` |
| `map-outline-dark-phone-390.png` | 390×844 | `815076b16d95b660b4af51a11d48b47772636551f5bcc01449b352782f85a4dd` |
| `map-outline-dark-phone-enlarged.png` | 390×844 | `68ceb08898156f7d55d4869de3bfcfc704d867b31c58c558d8958fc797ce943f` |
| `map-outline-dark-sky-desktop-1440.png` | 1440×900 | `9507d2d6c9064c15e6e65fe3d24b33c8745c9dd2807959c0a018ab34929b86f3` |
| `map-outline-dark-tablet-820.png` | 820×1180 | `eff7d2d439168c8a03bbf353c065402e1070ca80c424d8870858e128fb6260d2` |
| `map-outline-light-desktop-1280.png` | 1280×800 | `895c4128c76c49bd523efaba6122efee3c59dd074df2d23a4cd0bc94b7ec34fa` |
| `map-outline-light-desktop-1440.png` | 1440×900 | `1967a062a6b203940afa43e26da5cbe2151f955aa33f8ae5819792a7d94fdebf` |
| `map-outline-light-iris-desktop-1440.png` | 1440×900 | `416c7f9fea180a6671f843fd22eaa42b305d8be24b91ed0d965228d558a7d500` |
| `map-outline-light-mint-desktop-1440.png` | 1440×900 | `1967a062a6b203940afa43e26da5cbe2151f955aa33f8ae5819792a7d94fdebf` |
| `map-outline-light-phone-390.png` | 390×844 | `505ef9855bb1e825dc0c0783a995e9ff9c5d45a8721c4b6c7c7e688872910bd8` |
| `map-outline-light-phone-enlarged.png` | 390×844 | `cbe8f77cb00b7d20b90f5ea79ef76735cfb2b800b8ae56d16b635e158f9f5b07` |
| `map-outline-light-sky-desktop-1440.png` | 1440×900 | `eb612987352624c0e0055715649f43930e20a14ae5a19e3ed5669bf3bb584eb3` |
| `map-outline-light-tablet-820.png` | 820×1180 | `2d873c95352321b41e410cd72d2a96de287c1d9512d1e791cf7322e5abfa39b7` |
| `map-outline-phone-related-follow-back.png` | 390×844 | `b736500962c579b124e25b709768b79372d10741722f0409c55db7aea0df6aca` |

Manifest SHA-256: `3d16e1d761d5b0a68f843e7b5bfcbe74d2c7d2d9ac359e315db97b91fae9204a`.

## Guidance and reference pins

Paths below are relative to `/home/hubert/Develop/flux`. All six reference PNGs were inspected at original resolution.

| Source | SHA-256 |
| --- | --- |
| `.agents/skills/flux-review-visual/SKILL.md` | `fc4161227e26824902e5c234df6b84bf6595f51ef8e53dfbbda4c9834a0d6177` |
| `docs/product/FLUX-FOUNDATION.md` | `c83973e6fb102aacb6dadec289a615b15a23855542efd0018de6e314fdabdf0e` |
| `docs/design/README.md` | `c5048ce2bb81e53dd6128ca56802b12a44b464f274d7c089a9e6f142e81544db` |
| `docs/design/studio-v11-refinement.md` | `2a73f2e416436fe8fcd8da1a3c8855d7400e20c0a4ab7b58403b68cba612cf0a` |
| `docs/design/references/studio-v11/README.md` | `358dd9332b583c02a9d6c9c49d683551db60bdf6c0d547c8fa345a35d80911a8` |
| `docs/design/references/studio-v11/preview/evidence/deep-map-1440-light-after.png` | `411c529d40adac5b17c8daf5f555f3083f3ad70db488fc1b3c76afe36823b561` |
| `docs/design/references/studio-v11/preview/evidence/deep-map-1440-after.png` | `d4f84a0d66a891e9420f4f5dbc3034f8f588728ed24dcf28e817bf1701bf2ce7` |
| `docs/design/references/studio-v11/preview/evidence/deep-map-390-light-after.png` | `a359cb965980e9dd05e9f166e428f88e6d2a20c8b62c7880f05d9a384a3f23a4` |
| `docs/design/references/studio-v11/preview/evidence/deep-map-390-after.png` | `6e18a1829991faaa05f14798cffac644ae0ebedb111c8ae21c359bd08f41bda6` |
| `docs/design/references/studio-v11/supplied/screenshots/05-mapa-lista.png` | `cf5f9cf8ef212ab717e9c78467f4a74418aa04e9a5fbc8b784e39148aafe2710` |
| `docs/design/references/studio-v11/supplied/screenshots/06-szukaj-mapa.png` | `743d3575bf91fdae0a4db39443b6b9b5bb41f7c479a6e35efc7fa37eac0e79fc` |
