# Independent visual review — PR #389

Reviewed revision: `108a7a3c5935cb0265e55658176e97b759a1d937`.
Reviewer: fresh delegated visual reviewer; no implementation, author rationale or functional test results inspected.

Scope: all twelve frames named by `flux389-108a7a3c-visual-brief.md`, both screenshot manifests, canonical `desktop-wiki.webp` and `phone-wiki.webp`, and F-026 guidance. PNG dimensions and SHA-256 values match both manifests. Desktop is 1440×900 CSS px/DPR 1. WikiFinal phone is 390×844 CSS px/DPR 2 (780×1688 PNG), mobile emulation; live-reader phone is 390×844 CSS px/DPR 1, viewport only, without mobile emulation. Default browser zoom. The 2× Wiki frames were assessed at their stated CSS scale, not mistaken for oversized UI.

## Outcome

No P1/P2 visual problem established in the supplied frames. Visual pass for the supplied reader states only, with the nonblocking P3 conformance detail below. This is not whole-task approval.

The desktop reader preserves the reference's page navigation / prose / right outline hierarchy. Headings are clear, prose has a comfortable bounded measure, the table is legible, and Edit is visibly prominent. The phone keeps a compact project header, horizontal page navigation, readable body and heading sizes, and a visible floating Edit action above the navigation capsule. Long project titles ellipsize rather than colliding with adjacent controls. Light and dark Wiki frames retain clear surface and text hierarchy in both engines. The focused project-title outline in the light phone captures is an observable focus state, not evidence that all focus behavior works.

The live-reader frames show the new working heading and paragraph as readable prose, including a corresponding desktop outline entry. The shared-working-copy notice explicitly distinguishes the last saved version and saved references from working text. Preserve this distinction and the visible contributor label. Although the desktop also says “Published · version 1”, the immediately visible shared-copy notice provides enough context here that I cannot establish material ambiguity from these images alone.

## Nonblocking detail

**P3 — live contributor label uses pink outside the monochrome surfaces.** In both engines' live-reader desktop and phone light frames, “Ada North · line 9” is pink. This is a visible departure from F-026 principle 4 / P7, which reserves colour for user content and the Agents section. It slightly pulls attention away from the document. Keep the contributor wording and use the established monochrome text treatment. This is a small conformance correction, not a readability blocker or a request to redesign presence.

Differences in fixture prose, page ordering/count and missing decision card are not treated as visual failures: the neutral brief supplies distinct fixture content and does not assert an exact reproduction of the canonical document.

## Evidence limits and next live checks

No editing-mode, historical-version, history-menu, error, enlarged-text, or long-document scrolled screenshot is supplied; these states remain visually unassessed. In particular, the saved-state distinction is visible as a reader notice, but historical saved-state rendering itself has not been reviewed. The viewport-only live phone frames do not prove mobile/touch behavior.

Separately exercise phone title/view menu and horizontal page navigation, Edit reachability while scrolling, outline navigation to unsaved headings, historical saved versions versus current working text, keyboard/focus paths, safe-area/content clearance under fixed navigation, zoom/text enlargement and computed contrast. Images cannot certify interaction, persistence, permissions, accessibility or actual synchronization.
