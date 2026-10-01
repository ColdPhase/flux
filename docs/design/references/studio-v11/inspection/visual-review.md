# Independent visual assessment — supplied Flux Studio v11

**Date:** 2026-09-29. **Reviewer:** separate `studio_v11_visual_review` agent using `flux-review-visual`, in a fresh context. No edits, implementation code, parent issue or author rationale were supplied. This is independent model visual feedback, not an eligible GitHub approval of the documentation PR, production behavior acceptance, or a user study.

**Neutral brief:** a person returns to a small collaborative creative project, resumes useful work without reading all history, and reads a map in List. Keep human work central, explicit private/project audiences, compact readable controls, secondary details on demand and calm desktop/phone use. The second pass compared three theme-aware accent families on the same conversation and a map with deep and root-level branches. Viewport/zoom and evidence boundaries were supplied.

## Supplied-screen review

Inspected `01-rozmowa.png`, `02-prywatny-skrot.png`, `03-kanban.png`, `05-mapa-lista.png`, `09-palety.png`, `12-mobile-skrot.png`, `13-mobile-kanban.png`, `14-jasna-laguna.png`, `16-razem.png` in `../supplied/screenshots/` (generally 1440×960 desktop, 390×844 phone).

Three highest-impact visible issues:

1. **Recap setup precedes the useful recap.** Repeated project headings, explanatory copy, scope and generation controls occupy most of the initial view. On phone, the first “Potrzebuje Ciebie” action reaches the fixed footer before its controls are fully visible. This delays finding a useful next step. Lead with changes/actions and compact the scope/date/generation explanation. Tracked by #133.
2. **Map entries are distant from their actions.** Titles/relations sit on the left while repeated unlabeled icon groups sit across a large empty span at the far right. Cross-links appear as small secondary chips. Readers must track long rows and interpret icons. Keep actions nearer their entry, make the destination legible and clarify relationship reading order. Preserve the useful tree structure. Tracked by #134.
3. **Phone kanban offers weak status orientation.** “Do zrobienia” is visible with a clipped sliver of “W trakcie”; active work can be outside the readable view. Add compact, legible status/column navigation or use an appropriate existing list/table mode. Tracked by #136.

Preserve the human conversation and embedded source/work links, clear task ownership, readable document hierarchy, named palette choices and contextual live banner that keeps the map central. Mint versus lagoon is a preference, not an observed usability defect.

## Focused theme and deep-list comparison

Inspected six `conversation-1440-{light|dark}-{mint|iris|sky}.png` renders and `map-deep-before-1440.png`, `map-deep-after-1440.png`, `map-deep-after-390.png` in this directory. These are fresh Docker reference renders at 100% zoom, not production screenshots.

The three families form a coherent limited set: branding, selected navigation, badges and send use consistent roles; darker accent ink in light mode and lighter ink in dark mode preserve hierarchy. None appeared materially weaker visually. Choice among them is preference.

Material observations in this focused pass:

1. **A resolution indicator follows the accent.** “To pytanie ma rozwiązanie” changes color with the chosen family while done/result/amber-blocker treatments remain stable. The production theme task must give semantic resolution markers a stable treatment. Tracked by #135.
2. **The relation changes the apparent hierarchy.** “Nowy kierunek: lokalna analiza obrazu” moves from a separate root into a deep child beneath “Pomiar poboru energii przy wykryciu gestu.” For a cross-relation, preserve both root positions and show a named reference. Tracked by #134.
3. **Phone indentation compresses deep titles.** Indentation and the fixed action column leave the deepest title around 100 pixels wide, causing three lines and slower scanning. Bound indentation or disclose an ancestor path, retaining branch guidance and usable actions. Tracked by #134.

## Limits and interaction questions

Check recap scrolling clear of its footer, source/action destinations, keyboard map navigation, phone column navigation and position retention, focus, enlarged text, contrast and touch targets in the actual application. The chooser’s exactly-three constraint, one-active-accent preference, graph semantics and persisted data require running checks. Images certify none of functionality, privacy enforcement, accessibility or production readiness. Preserve real-device PWA/push requirements separately.

[review-evidence.json](review-evidence.json) pins the reviewed images and reference HTML by SHA-256. A changed screenshot requires affected visual review again.
