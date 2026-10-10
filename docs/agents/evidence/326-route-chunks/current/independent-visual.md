# Independent visual review: pending and recovery surfaces

Reviewed 2026-10-08 in a fresh evaluator context using `flux-review-visual`. No implementation, revision history, author rationale, or other review was read. The scope is the neutral job in `/tmp/flux326-neutral-brief.md`: understand the surface opening, see a cancel/close action, and understand recovery after settings fail. This is a visual review, not a functional task approval.

**Bounded verdict: acceptable visible clarity for the supplied pending/error compositions; no material local visual finding.** This does not certify full F-026 integration of the surrounding application.

Source supplied by the brief: `784d46007cd21cf35bd457ecc71c0f81b47f33c3`, base `0f68aa963be920fbc7ebf30742da4aef54fe34be`. All ten PNG hashes match `/tmp/flux326-current-route-capture-manifest.json`. Desktop files are 1440×900; phone files are 390×844. Every listed PNG was inspected directly with `view_image`, without changing it.

## Evidence inspected

All paths below are under `/tmp/flux326-project-style-captures/`:

- `route-chunks-code-error-chromium-desktop.png`
- `route-chunks-code-error-webkit-desktop.png`
- `route-chunks-details-pending-chromium-desktop.png`
- `route-chunks-details-pending-webkit-desktop.png`
- `route-chunks-first-project-details-chromium-phone.png`
- `route-chunks-first-project-details-webkit-phone.png`
- `route-chunks-pending-chromium-desktop.png`
- `route-chunks-pending-webkit-phone.png`
- `route-chunks-search-pending-chromium-desktop.png`
- `route-chunks-search-pending-webkit-desktop.png`

Reference guide: `/home/hubert/.codex/worktrees/326-route-chunks/flux/docs/design/final/README.md`. Relevant accepted visual references inspected: `screens/phone-loading.webp`, `screens/desktop-palette.webp`, and the shared `reference-system.webp` and `desktop-thread.webp` assets in `/home/hubert/.codex/worktrees/339-kreska-fixes/flux/docs/design/final/screens/`.

## Observations and useful elements to preserve

- The desktop settings-pending bar and the WebKit phone equivalent say **Opening settings…** and expose **Cancel** in the same row. The note/composer remains visible beneath it, without a large placeholder taking the work area. The narrow capture fits the loading label and Cancel without clipping.
- Both desktop search-pending captures put **Opening search…** and **Close search** in a clearly raised white surface over a dimmed background. The soft corners and restrained monochrome treatment are consistent with the accepted surface language. The close wording is explicit and easy to recognize.
- Both Details-pending captures retain the **Details** heading and visible close ×, with **Opening details…** directly beneath. The note and composer remain visible beside the panel.
- Both error captures lead with **This page couldn’t be loaded**, explain that settings could not open, and present a clearly dominant **Reload Flux** action plus **Go to Home**. Their scale is calm and the two actions remain distinct. The generic warning icon avoids placing a mascot in an error.
- The two first-project Details phone captures show the project identity, native task row, empty material sections, audience description, person and invitation action in a readable single column. No text or control is visibly pushed outside the narrow width.

## Material findings

None within the bounded loading/recovery job. The surrounding navigation, logo, project chrome and full Details redesign are not accepted or rejected by this verdict.

## Questions for live checks and missing states

- The desktop pending Details pane has a strong rectangular outline. The screenshot cannot establish whether this is a focus indicator. Keep a visible focus treatment; compare the unfocused shell with F-026's rounded raised panel in the running app before treating the outline as a permanent visual defect.
- Verify Cancel/close, draft continuity, focus restoration, reload recovery, history/Back and actual data preservation in the application. The copy and visible note cannot prove these.
- No phone settings-error, phone search-pending, dark, enlarged-text or loaded-settings transition capture was supplied. Those states remain visually unreviewed.
- This review does not establish privacy, permissions, keyboard behavior, touch target size, motion preferences, WCAG compliance or whole-application completion.
