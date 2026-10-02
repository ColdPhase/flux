# Independent visual review: personal background suggestions

The captured flow is compact and readable across the supplied desktop, tablet and phone views. Two visible clarity problems remain: the effect of disconnecting is distant from its action, and the captured failure provides broad recovery instructions without a visible field destination. This review does not approve the functional task or certify behavior, privacy, accessibility or real-device support.

## Scope and basis

- Candidate revision supplied with the evidence: `06d07f6cbdea4d0a569b719929ec82594332406a`.
- Review date: 2026-09-30. Independent visual-only review using `flux-review-visual/SKILL.md`, `docs/design/README.md`, and the Studio v11 refinement direction. No implementation code, Git history, previous review reports or author rationale was inspected; no GitHub action or implementation edit was performed.
- Neutral job: a signed-in contributor connects an optional personal background comparison source, understands payer, project evidence and local allowance, replaces/disconnects the source, and chooses a personal agent/project to create a paused rule. Ordinary project work should remain reachable. Runtime is unavailable at this checkpoint; secrets and payer details belong only to the owner.
- All 15 `background-*.png` files in `reviewed-06d07f6` were inspected, including empty, saved, replacement, consent, error, creation and paused states.
- Supplied capture conditions: Chromium, DPR 1, 100%; desktop 1440×900, touch tablet 1024×768, touch phone 390×844. The zoom2 image is CSS zoom 200% in a 1440×1800 capture. PNG dimensions were checked. Several images show scrolled partial views; they do not establish the complete document or scroll transition.
- References inspected: `appearance-light-mint-after.png`, `appearance-dark-mint-after.png`, and `chat-390-after.png` in `docs/design/references/studio-v11/preview/evidence/`. They support the assessment of calm neutral surfaces, restrained containers, readable working type and reachable actions; they are not templates for this form.

## Material visible problems

1. **Disconnect context is too far from the action.** Location: saved connection in `background-setup-1440-saved.png`, `background-setup-1024-saved.png`, and `background-setup-390-saved.png`. Symptom: **Disconnect** sits beside **Replace connection**, while “Disconnecting removes this key from Flux. Revoke it at Claude Platform too…” appears after the project-rules section. The phone saved capture shows the button but does not show that explanation. Consequence: before acting, a user can miss the distinction between removing the connection from Flux and revoking a provider key that can still work elsewhere. Improvement: place a short “Removes this key from Flux only” explanation beside or directly below Disconnect, with the provider-revocation instruction available there. Actual confirmation behavior was not tested.

2. **Failure recovery lacks a visible field destination.** Location: `background-setup-1440-error.png`, below “Replace your connection.” Symptom: the red message says to re-enter the cleared key and then check organization, workspace, allowance and confirmations, while all visible fields retain ordinary borders and no specific safe value is identified. Consequence: the owner must rescan the form and re-enter a secret without being shown which editable part needs correction. Improvement: for locally checkable non-secret errors, name and mark the relevant field or confirmation and provide an error-summary destination; retain appropriately generic provider/authentication errors. The screenshot's exact failure cause was not supplied, so this is a recovery-presentation finding, not proof of a particular validation defect.

## Useful elements to preserve

- Neutral light/dark surfaces, quiet section separators, ordinary-sized headings and minimal containers keep the settings readable and consistent with Studio v11's working character.
- The saved connection separates provider/model, payer, masked key and local allowance. The explanation distinguishes Flux's allowance from the provider invoice and warns that interrupted requests can still be charged.
- Explicit consent covers workspace restriction, spending authority, payer/invoice limits and published project evidence. Controls and labels wrap cleanly in the captured phone/tablet views; no horizontal content clipping is visible in those reviewed crops.
- Project scope stays beside the project selection and paused rule. “Paused · version 1,” the personal agent, rule allowance and unavailable-execution explanation make the saved state understandable without implying execution has started.
- The desktop project navigation and explicit “Continue work in Independent sensor benchmark” / “Continue in Flux” routes preserve an obvious way back to ordinary work in the shown states.

## Gaps requiring live testing

- Keyboard order, focus after replacement/save/failure, checkbox label targets, announcements, contrast measurements, true browser/text zoom and responsive transitions. CSS zoom in one image does not establish zoom accessibility.
- Disconnect/revoke confirmation and outcome; replacement success and failure; persistence; secret clearing; correct payer/allowance values; owner-only access; provider payload scope; access loss and rule transitions. Labels cannot prove these protections.
- Phone/tablet rule creation and expanded project/agent selectors, long names/payer details, no eligible agent/project and phone error states are not shown. Dark replacement/consent/error/rule views are also absent.
- Touch behavior, virtual keyboard, real Android/iPhone/iPad installation and notifications were not exercised. Emulated touch screenshots do not establish real-device or PWA acceptance.

## Evidence inventory

All files below are under `reviewed-06d07f6`; SHA-256 pins the inspected image bytes.

| Image | Pixels | SHA-256 |
| --- | --- | --- |
| background-rules-1024-paused.png | 1024×768 | `70f189947561dee495ea9644558259446890ad8212fb40958def216a2756e090` |
| background-rules-1440-create.png | 1440×900 | `e6a455659e8aee676df882552298cf1aee2bc546b5c6c0c40a03d23a9c58472d` |
| background-rules-1440-paused.png | 1440×900 | `5ffcbc1fa248d773c828310d42a25f74844fd0e3b8dc9ebf6daca279243cad88` |
| background-rules-390-paused.png | 390×844 | `94df68d7b73f789021c82b4ea13db3c9297f4b7fb35a77a621d3c3d032aa7d5d` |
| background-setup-1024-consent.png | 1024×768 | `f83017c0778f6e7e9f1c1a3614d9982ba99254c711e540e602c8ca9f03706cd2` |
| background-setup-1024-replace.png | 1024×768 | `390a5782bce7a3932073253a703fdf6fb2a4fda4f31985f44aec7d6c0700a26e` |
| background-setup-1024-saved.png | 1024×768 | `3d1faf9698757b90ad0586237251c47c7c8373759d398eb36cf58bb147831fed` |
| background-setup-1440-error.png | 1440×900 | `cc969213f9088e8a5619c7c2d2519074abcff328fbdc78f39993a976c18a939d` |
| background-setup-1440-saved-dark.png | 1440×900 | `8f7a3b4ae9592b67aba5428319c83d3784fb60f00333633913e38fb89b50f6c6` |
| background-setup-1440-saved.png | 1440×900 | `2dc56c929bcc048b1a13d28ea24d43eed2b4f0a2c058668f4b88a6161a15932f` |
| background-setup-1440-zoom2.png | 1440×1800 | `7f55b30f4ffae7b3f2058e43d6db68d7b656a723c615a54e6b3ad893007283ef` |
| background-setup-390-consent.png | 390×844 | `9f8e7bf83adf20313af703de4b0b64ea7fbe711951c0cc1e56f08f56caa2fdda` |
| background-setup-390-empty.png | 390×844 | `3616c286081e0c5876ea66f98c4625d8914600b9fffa52131a583693c1b337fa` |
| background-setup-390-replace.png | 390×844 | `afa2615ea9b9c9fc02db11990b556996238b874bc4d4861dcc1f1f4121ad0062` |
| background-setup-390-saved.png | 390×844 | `408a011f4a78c2c1af19abc2ec88e4c7c48094df0fe39782e66b9be74958ab2b` |
