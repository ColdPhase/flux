# Independent visual review — Flux accent selection

Reviewed 2026-09-30 using `flux-review-visual` in a fresh reviewer context. No implementation code, Git history, author rationale, earlier review reports, or contrast results were inspected. No application files were edited and no GitHub approval was posted.

**Verdict: visual pass for the supplied appearance scope. No material visible problem requires a correction round.** This is an image review, not functional acceptance.

## Brief and evidence

A teammate selects a browser-local accent for the current light or dark working interface. Exactly Mint, Sky and Copper are offered beside a separate theme selector. The choice, selection state and explanation should remain readable, compact and discoverable in realistic project work. Preserve useful existing layout; this is an appearance successor, not a shell redesign.

The supplied production-source attribution is `f9db781dc9e7410651355e3f475cfd33d0574bae`. This attribution and the stated 100% browser zoom / 125% text setting are supplied capture context, not independently established from pixels.

Reviewed images under `/tmp/flux148-current-screenshots`:

- All six `accent-{light,dark}-{mint,sky,copper}-settings-1440.png`: PNG dimensions 1440×900.
- Copper in both themes: `conversation-1440` and `recap-1440`: 1440×900.
- Copper in both themes: `phone-conversation` and `phone-recap`: 390×844.
- Copper in both themes: `tablet-conversation` and `tablet-recap`: 820×1180. The initial brief named 768×1024; the requester corrected the corpus scope to these actual dimensions. No 768×1024 production image was assessed.
- Copper in both themes: `phone-text-125-settings` and `phone-text-125-conversation`: 390×844, supplied as 125% text at 100% browser zoom.

Reference images only, under `/home/hubert/Develop/flux/.worktrees/147-studio-v111-reference/docs/design/references/studio-v11.6/inspection`: all six `studio-v11.6-appearance-{light,dark}-{mint,sky,copper}.png`; `chat-1440-light`, `chat-1440-dark`, `chat-390-dark`, `chat-768-dark`; `recap-1440` and `recap-390`. Appearance images informed theme/accent separation and restrained selection; conversation/recap images informed calm hierarchy and working scale. Different fixture content and tablet dimensions prevent a strict row-count or space comparison. No Agents behavior or missing Agents surface is evaluated.

## Visible assessment

The desktop settings show a distinct Appearance segment for System/Light/Dark, then an Accent label, a short current-theme/browser-local explanation, and one row of three named options. Names, swatches, a border and a checkmark make the selected accent readable without relying on hue alone. All six combinations remain legible and fit within the compact account menu; opening it leaves most of the conversation visible.

At 390×844 with 125% text, the open menu shows the theme choices, the complete accent explanation and all three options without horizontal clipping or an obscured selected state. Copper remains clearly checked in both themes. The menu takes the foreground while retaining a visible drawer close control and account anchor.

Copper is restrained in the working views: the own-message surface, recap next-step surface and primary action share the accent, while text and project structure remain dominant. Light and dark variants preserve readable message text and distinct primary actions. Desktop recap leaves a usable conversation column; phone recap dedicates the screen to the current next step; tablet recap visibly separates the foreground panel from the dimmed conversation. The two-message fixture is realistic in wording but sparse, so its large empty area does not establish density under a busy history.

The enlarged-text conversation captures show the conversation title partly above the visible scroll area. A screenshot cannot distinguish ordinary scroll position from incorrect initial positioning; this is a live-testing question, not an attributed visual defect.

## Useful elements to preserve

- Separate theme and accent groups, explicit current-theme/browser-local copy, and the three named choices with a checkmark.
- The compact menu within the existing layout and sufficient readable spacing at enlarged text size.
- Restrained accent surfaces and a clear primary action, with ordinary content retaining the visual hierarchy.
- The desktop conversation space and the focused phone recap presentation.

## Missing states and live-testing limits

The bounded review does not include a tablet settings image, ordinary-size phone settings, desktop enlarged-text settings, System selected with its resolved appearance, or accent changes during an OS-theme transition. Mint/Sky phone and tablet images exist in the corpus but were outside this representative Copper review. No dense history, long change list, open virtual keyboard, or 125% recap was reviewed.

Live testing must establish closed-menu entry discoverability, phone drawer/menu navigation and dismissal, scroll reachability on shorter heights, initial/retained scroll position at enlarged text, keyboard operation and focus movement, screen-reader names/selection, touch targets, contrast and other applicable WCAG requirements. It must also establish independent light/dark remembering, browser-local persistence and storage-failure behavior. Pixels do not certify behavior, data correctness, permissions, accessibility conformance, physical-device/PWA behavior, or missing Agents surfaces.
