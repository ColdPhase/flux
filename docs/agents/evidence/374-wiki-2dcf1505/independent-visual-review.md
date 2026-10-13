# Independent visual review — phone Wiki, PR #374

**Scoped verdict:** Wiki content, page selection, project view menu, empty state, and Page actions pass visual review. The phone Wiki is legible and Page actions are reachable by scrolling. The integrated phone shell remains a conformance dependency; this report does not approve the whole PR.

The evaluator reviewed seven WebKit captures at source `2dcf15056b9f02c592a431e642b6f47febd0946c` against the neutral brief and the accepted [F-026 design guide](https://github.com/ColdPhase/flux/blob/main/docs/design/final/README.md), including its [phone Wiki reference](https://github.com/ColdPhase/flux/blob/main/docs/design/final/screens/phone-wiki.webp). Original PNGs are retained outside this repository; the eight WebP images in this evidence packet decode pixel-identically to their source PNGs. `manifest.json` records source/output hashes and dimensions.

The Wiki title and page count are easy to identify. The horizontal page strip makes selection visible, and the selected page title and document content have clear hierarchy and readable scale. The project view menu presents its five views and details option in a clear, restrained overlay. The empty state has a clear heading and two prominent next steps in both themes.

The Page actions menu is taller than its initial viewport. The initial capture alone did not establish that its final entry was unreachable. The [scrolled capture](wiki-phone-390-page-actions-scrolled.webp) shows Details and its supporting text fully in view. The probe records a 24 px scroll, no overlap with bottom navigation, a successful center hit-test, and a touch tap that opened Details. This withdraws the earlier visible-cutoff concern. The probe used WebKit with a phone CSS viewport, touch enabled and a coarse pointer, but `is_mobile=False` and `navigator.maxTouchPoints=0`; it is limited reachability evidence, not full mobile WebKit certification.

## Upstream phone-shell dependency

The supplied #374 captures show a persistent Home / Inbox / Messages / Projects bar with Projects selected, and a hamburger in the project header. F-026 specifies Home / Projects / Inbox in a floating capsule plus a separate Search button, with direct messages inside Projects; the phone Wiki reference shows a back control. This mismatch is visible in these captures. It belongs to the accepted shared-shell work in #341 / PR #414, which is absent from source `2dcf150...`. Evaluate the shell on the integrated candidate; this is not a Wiki-specific visual blocker in this scoped report.

## Limits

The initial review marked Details as a blocker because it appeared cut off in the unscrolled image. After inspecting the scrolled state and probe evidence, the evaluator withdrew that finding. This verdict covers supplied images and the stated probe only; it does not assess keyboard use, accessibility, persistence, other responsive sizes, or whole-PR behavior.
