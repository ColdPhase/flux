# Independent visual review: personal background suggestions

Review date: 2026-09-30. Candidate render revision: `035fd29`; the supplied brief identifies subsequent `3d39e9e` as documentation-only. This verdict is tied to the supplied PNGs, not to an independently verified repository head.

**Visual verdict: the normal connection and rule surfaces are readable and usable in the supplied desktop, tablet and phone renders. Two focused difficult-state refinements remain.** This is a visual-only review; it does not approve the functional task, privacy enforcement, accessibility or release readiness.

The neutral job is a signed-in contributor configuring an optional personal background comparison source, understanding payer/data disclosures and local allowances, replacing or disconnecting it, then selecting a personal agent and project to create a paused rule. Project work must remain reachable. Background execution is unavailable at this checkpoint; secrets and payer details belong to the owner.

I used the visual review skill and the designated Studio v11 worktree's `docs/design/README.md` and `direction.md`. The three supplied appearance/chat PNGs inform calm surfaces, restrained emphasis, readable type and compact work controls; their compositions are not templates for this settings page. I did not inspect implementation code, Git history, previous reviews or the author's rationale. I did not operate the application or GitHub.

## Material visible findings

1. **Replacement error does not point to the corrective field.** In [background-setup-1440-error.png](reviewed-035fd29/background-setup-1440-error.png), the red summary says to check the key, organization, workspace, allowance and confirmations. The empty API key field looks like the other ordinary fields; there is no adjacent error or visible invalid-field marker. The user must diagnose the whole form even though the captured state shows a blank key and completed confirmations. Keep the summary, but name the applicable error and place a clear cue beside the relevant input or confirmation. The replacement heading is also partly behind the fixed header in this captured scroll position; live testing should check where error focus/scroll lands. This finding concerns visible recovery guidance, not whether validation rejects the submission.

2. **The paused rule's unavailable action has no nearby reason.** In [background-rules-390-paused.png](reviewed-035fd29/background-rules-390-paused.png), [background-rules-1024-paused.png](reviewed-035fd29/background-rules-1024-paused.png) and [background-rules-1440-paused.png](reviewed-035fd29/background-rules-1440-paused.png), “Paused · version 1” and “Enable unavailable” are visible, but the instance-wide execution explanation is above the current view. A connection save form still precedes the rules in these captures, which makes missing setup a plausible interpretation of the unavailable button. Add a short explanation adjacent to the paused status/action that background execution is unavailable on this instance and the saved rule remains paused. Retain the nearby project continuation link. This is a difficult-state clarity issue, particularly on the long phone page.

## Useful elements to preserve

- The saved connection puts provider/model, payer, key suffix and local allowance into one restrained summary. The light and dark desktop renders have a clear reading order without repeated cards or oversized headings.
- The payer explanation directly distinguishes Flux's local allowance from the provider invoice. Separate confirmation statements keep spending authority and publication/data consent readable, including the wrapping phone layout.
- Replacement and disconnect are named actions beside the summary. Replacement has a visible cancel route and a strong input focus outline in the supplied phone/tablet renders.
- Project selection, personal agent identity, named project scope and rule allowance remain explicit. The creation action says “Create paused rule”; the saved state says “Paused” and exposes “Revoke rule.”
- Normal phone/tablet controls fit the available width, with readable text and larger controls than the desktop. The paused phone screenshot keeps both rule actions and the project continuation link together.
- Desktop project navigation and the explicit “Continue work in…” / “Continue in Flux” links support return to ordinary work. The collapsed narrow navigation's operation still needs live verification.

These are observable hierarchy/readability strengths. A stronger mint treatment, different corner shape or matching the reference modal's layout would be stylistic choices, not additional material findings from this evidence.

## Evidence inspected

All files below are in `reviewed-035fd29/`. The directory contained **15** `background-*` PNGs, not the brief's stated 16: 14 normal captures and one separate CSS zoom capture. Every file present was inspected.

| Scenario | Files |
|---|---|
| Desktop saved, light/dark | `background-setup-1440-saved.png`, `background-setup-1440-saved-dark.png` |
| Phone initial form, saved, replacement, consent | `background-setup-390-empty.png`, `background-setup-390-saved.png`, `background-setup-390-replace.png`, `background-setup-390-consent.png` |
| Tablet saved, replacement, consent | `background-setup-1024-saved.png`, `background-setup-1024-replace.png`, `background-setup-1024-consent.png` |
| Desktop replacement error | `background-setup-1440-error.png` |
| Desktop rule creation; paused desktop/phone/tablet | `background-rules-1440-create.png`, `background-rules-1440-paused.png`, `background-rules-390-paused.png`, `background-rules-1024-paused.png` |
| Separate enlarged capture | `background-setup-1440-zoom2.png` |

Normal supplied capture conditions: Docker Chromium, desktop 1440×900, touch tablet 1024×768, touch phone 390×844, DPR 1, 100%. Several images show scrolled portions of a longer page. The zoom2 image is a CSS zoom 200% capture only. Its content is readable in the supplied frame, but it establishes neither browser/OS zoom behavior nor physical-device evidence.

## Missing states and separate live checks

Missing visual evidence includes phone/tablet rule creation, rule creation with no eligible personal agent or lost project access, disconnect/revoke confirmation and resulting empty states, replacement failure on narrow layouts, pending/success feedback, long payer/agent/project names, and dark phone/tablet forms. These are evidence gaps, not claims that the states fail.

Separate live testing should establish:

- Field-specific validation, error focus/scroll beneath the fixed header, consent requiredness and whether failed replacement preserves the existing connection.
- Keyboard order, input/checkbox labels, focus visibility, checkbox label activation, select operation, touch targets, measured contrast, browser zoom and responsive transitions.
- Owner-only access to payer and secret details through UI/API/persistence paths, key masking, disconnect deletion and the provider revocation boundary.
- Correct personal agent/project association, allowance persistence, paused creation with no execution or charge, revoke behavior, and the disabled enable control's actual behavior.
- Reachable project work via narrow navigation and continuation links, with scroll restoration and mobile keyboard behavior.

No live interaction, access-control, API, persistence, WCAG, PWA installation or notification checks were performed for this review.
