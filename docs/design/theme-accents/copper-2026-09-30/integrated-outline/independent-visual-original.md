# Independent visual assessment — integrated map outline

Date: 2026-09-30. Supplied production source: `03f0f8d6b417cc3fc7bcaa3d0f48accf7332cb48`.

The core outline is readable in the supplied states. Mint, Sky and Copper retain distinct related links and a clear selected row in both light and dark. One localized visibility problem remains in the supplied phone related-navigation capture. This is a screenshot-only assessment, not functional, accessibility, or GitHub acceptance.

## Scope and evidence

Neutral job: a teammate reads a deep personal list over a many-to-many shared map. The hierarchy, cross-links, selected row/path and ordinary metadata should remain clear while preserving compact working density.

I inspected these files under `/tmp/flux148-current-integrated-screenshots` at their original resolution:

- `map-outline-{light,dark}-{mint,sky,copper}-desktop-1440.png` — six captures, 1440×900.
- `map-outline-{light,dark}-phone-390.png` — two captures, 390×844.
- `map-outline-{light,dark}-tablet-820.png` — two captures, 820×1180.
- `map-outline-{light,dark}-phone-enlarged.png` — two captures, 390×844, supplied as 125% text.
- `map-outline-phone-related-follow-back.png` — 390×844.

The supplied browser zoom is 100%. I used only the current `studio-v11.6-map-list-1440.png` and `studio-v11.6-map-list-390.png` images in the stated reference inspection directory for comparison. I did not inspect implementation code, revision history, author rationale, contrast output, or previous review reports.

## Material visible finding

**Selected destination context falls below the phone viewport in the related-navigation capture.** In `map-outline-phone-related-follow-back.png`, the “Back to ‘Quiet hours · a separate direction’” cue is visible near the top, but the selected long-distance receiver row begins around y=770 and continues beyond the bottom edge. Its metadata, level/path cue, related links and actions are absent from the visible portion. A teammate can recognize the return route, but cannot read the selected destination's context at the same glance. Ensure the landing presentation reveals enough of the selected destination below the fixed header to show its title and context, while preserving the Back cue. The pixels establish the partial presentation; they do not establish whether this reflects actual navigation scrolling, capture timing, or a later manual scroll.

No additional material hierarchy, cross-link readability, accent, or ordinary metadata problem is visible in the inspected captures.

## Useful elements to preserve

- Titles lead each row; muted author/time metadata stays secondary. Indentation, disclosure markers and explicit “Path · level” labels communicate the deep outline. On phone the indentation uses little width, leaving long titles readable.
- Related links use underlining as well as accent color and sit behind a “Related to” label. They remain distinguishable from bold hierarchy titles in all six desktop theme/accent states. Their inline wrapping retains readable text on phone.
- The selected row has a broad tinted surface and a checkmark. Its title, author/time, level and related links remain readable on that surface in Mint, Sky and Copper, light and dark. The normal phone capture shows the selected row and its actions together.
- Desktop and tablet keep the work surface visually quiet. The toolbar is compact, and the typography does not turn this working list into a large presentation screen. The tablet capture shows the deep branch, a separate branch, a disconnected thought, a draft and their relationships in one view. The supplied reference has simpler and shorter content, so its row count alone is not a fair density target.
- Enlarged phone text wraps rather than visibly overlapping or cutting the selected title horizontally. The selected fill and checkmark remain recognizable.

## Missing states and live questions

- Expanded Path and More relations are not shown. Their readability, complete ancestry, return context, and behavior under long or repeated links remain unverified.
- The enlarged phone captures show Conversation, Tasks and Map across the visible tab row, while Docs is outside the visible width; the status sentence is also shortened to “No de…”. Check whether horizontal continuation is discoverable and all modules remain reachable with touch and keyboard. The screenshots cannot establish an inaccessible tab.
- The phone/tablet captures use the green accent. They do not provide narrow or enlarged-text evidence for Sky and Copper.
- Check actual related-link follow/back behavior, selection restoration, viewport positioning, collapse/expand, focus visibility, keyboard navigation, touch targets, responsive transitions and persistence in the running application.
- Screenshot legibility does not establish contrast ratios, WCAG compliance, screen-reader semantics, actual zoom behavior, data correctness, or permissions. No such certification is made here.

## Focused correction review — phone destination landing

Date: 2026-09-30. Supplied source: `763cf10` on the original Mint/Iris/Sky branch. Evidence: `/tmp/flux134-landing-screenshots/map-outline-phone-related-follow-back.png`, 390×844 at supplied 100% browser zoom. This section preserves the original finding and assesses only the newly supplied pixels.

**Focused verdict: the supplied corrected capture resolves the selected-destination visibility finding.** The Back cue remains visible below the module tabs. The selected long-distance receiver row now starts immediately below it, around y=211, and its full title, author/time, “Path · level 4”, related links, More relations disclosure and row actions fit above y=557. The teammate can read the selected destination's context while retaining the return route in the same viewport. The tinted selection surface and checkmark remain clear, and part of the following branch is still visible beneath it.

This verdict applies only to this capture and its supplied `763cf10` source. It does not certify live navigation behavior or the unprovided integrated Mint/Sky/Copper head. That head needs its own current captures and applicable behavior checks.

**Earlier capture metadata correction:** the two integrated `map-outline-{light,dark}-phone-enlarged.png` files reviewed above use 200% shared type tokens, with supplied row text of 28px versus the ordinary 14px. The original brief described them as 125%; the capture provider has corrected that description to 200%. The separate appearance corpus's 125% captures were not part of this outline review. The earlier observations about visible wrapping, selection and offscreen module navigation remain observations of those same 200% images. They do not constitute 125% text evidence.
