# Independent phone visual review — source/render pin 781de6dc

Reviewed 2026-10-01 with `flux-review-visual` and the current Studio 11.6 design guidance. This is a fresh, independent screenshot review: no application implementation, revision history, baseline images or author rationale were inspected. The pin and immutable-after-test07 capture provenance are supplied by the requesting reviewer; this review does not independently establish build provenance.

Neutral brief: a project member and a read-only collaborator check current project work on a phone containing a proposal, ongoing work and a blocked task. Their job is to see whether attention is needed and reach existing Details. The accepted direction is a compact, readable Studio 11.6 working surface. The supplied 390px task-first-message and 320px dark wiki references were inspected for density and visual character, not as exact screen templates.

## Material visible finding

1. **State-strip labels collide at 200% text (both roles, 320×844).** Directly below the project header, the enlarged “1 blocked” label and the outlined “What matters” control occupy the same horizontal space. Their text overlaps, and the state summary/chevron no longer forms a clean readable group. This obscures the attention signal that the user came to check. Allow the strip to wrap or stack with adequate height, or give its controls separate rows when enlarged text cannot fit. Preserve the full blocked count and distinct Details affordance. This is observable clipping/overlap, not a stylistic preference. It is present in both `136-state-blocked-320-text-200-writer.png` and `136-state-blocked-320-text-200-reader.png`.

No other material visible problem is established within these six supplied states. At 100% and 125% text, the state wording is abbreviated, but “1 blocked” remains clearly separated and the Details action is readily visible. The supplied images establish a clear attention signal at those settings; they do not expose the proposal or ongoing-work contents.

## Useful elements to preserve

- Quiet neutral surfaces, strong primary text, restrained dividers and a small state mark fit the references' working-tool character. The header and navigation leave the body available for work without a decorative hero.
- At 100%/125% text, “1 blocked” is a concise textual attention signal that does not depend on color alone. Details remains explicitly named and visible in all six renders, including 200% text.
- The selected Conversation underline is clear. The reader's empty state explains read access and available saved material, while the bottom read-only notice remains visibly distinct from the writer's composer.

## Evidence

All CSS viewports have height 844, browser zoom 100%. Text percentages refer to supplied text-token enlargement, not browser zoom. The 125% and 200% cases are enlarged-text evaluations; their density should not be compared as default typography against the references. The writer/reader images at 100% and 200% are light; the 125% images are dark, as visibly rendered.

Files are under `/tmp/flux136-phone-blocked-final/`.

| Screenshot | CSS viewport | Text tokens | SHA256 |
| --- | --- | --- | --- |
| 136-state-blocked-320-text-100-writer.png | 320×844 | 100% | 3cd5e2cbe16e85bf22f559efb00e456bb1b95cd3154bcc21418e2be307ee5be8 |
| 136-state-blocked-390-text-125-writer.png | 390×844 | 125% | 3657c9f0b8ec3e5b1d0e048122a1a6530c195d6998686c1df1577a8453002aa8 |
| 136-state-blocked-320-text-200-writer.png | 320×844 | 200% | 40e69bb61813e03b46b5d55ac18949d7613f0aefabbe9985eea870dc388d91c5 |
| 136-state-blocked-320-text-100-reader.png | 320×844 | 100% | 5ae713e0f25bfb3549ccf1b851e3e1ca093e017735a668f8b4580fa3d84ff26a |
| 136-state-blocked-390-text-125-reader.png | 390×844 | 125% | 2088804f7d6c35d1dd2376a148c89f182c073e1e9d0cb4f218913d6faa9307bc |
| 136-state-blocked-320-text-200-reader.png | 320×844 | 200% | 6fd2a99ebc04eaa834bc101ab9d6c756c1d7616319d722d605bfb0ecfcd131fb |

References inspected:

- `/Users/maurycyzamojski/Dev/Projekty/flux/docs/design/references/studio-v11.6/inspection/studio-v11.6-task-first-message-390.png`
- `/Users/maurycyzamojski/Dev/Projekty/flux/docs/design/references/studio-v11.6/inspection/studio-v11.6-wiki-320-dark.png`

## Missing states and live verification

This six-image scope does not show expanded Details, the specific proposal/ongoing/blocked task contents, a populated conversation, long project names, focus/error states, landscape, virtual keyboard, or the transition between widths/text settings. The reader 200% capture does not show the empty-state heading within its visible body; without scroll evidence this is not classified as a disappearance defect.

Live testing must establish that the blocked summary and Details remain independently reachable, readable and operable at enlarged text; that hidden tabs can be reached; and that opening Details reveals the correct authorized project/task state and preserves the return position. These screenshots cannot certify interaction, data correctness, responsive transitions, focus/keyboard behavior, touch target size, contrast compliance or accessibility. This report does not approve the whole functional task.
