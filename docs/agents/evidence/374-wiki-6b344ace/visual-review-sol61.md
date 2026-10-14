# Independent visual review — PR #374

Reviewer: fresh Sol 6.1 visual-review context. Source revision: `6b344acedd1479e5f4e1ffcc03accd85937f6754`. Date: 2026-10-14. Scope: visible appearance only; no implementation source or author rationale inspected.

Verdict: **no P1/P2 visual composition findings in the supplied frames**. This is a scoped visual pass, not functional approval.

## Evidence and reference

Inspected all nine PNGs in `screenshots/`, supplied as Chromium captures from `scripts/check_ui.sh`. Actual dimensions: final-phone light/dark and view-menu 780×1688 (390×844 CSS, DPR 2); 320 reader/editor 960×1920 (320×640 CSS, DPR 3); other 390 reader/action 1170×2532 (390×844 CSS, DPR 3); desktop 1440×900 (DPR 1). These dimensions were independently read from the image files. Browser/zoom/source provenance is supplied by the packet, not independently reproduced by this reviewer.

Compared against `docs/design/final/README.md` §§2, 4 Phone, 5 and 9; `phone-wiki.webp`, `phone-viewsmenu.webp`, and `desktop-wiki.webp`; applied `.agents/skills/flux-review-visual/SKILL.md` and `docs/design/README.md`.

The final-phone frames visibly show Community garden sensors / Hardware / 1 person / Wiki / 5 pages. The open menu belongs to this fixture. Other frames visibly show Arduino + AI: the 320 reader/editor show How the lamp works; `wiki-phone-390-light.png` shows Retried import (Draft), and the action menu refers to How the lamp works. Desktop import shows Power budget (Draft); refusal shows How the lamp works with unreadable UTF-8 file feedback. Manifest corrections were requested for these mixed-fixture labels. No wide-table screenshot was supplied.

## Visible assessment

Preserve the compact two-line phone header: title with chevron, people context, current Wiki label and page count remain legible, while the open menu restores the complete long project name. At 390 the page chips directly precede the document without a competing action toolbar. Hardware has a strong page title, restrained author line and readable body/section hierarchy in both themes. Edit sits above the separate Home/Projects/Inbox capsule and Search button, following the reference composition.

The project menu clearly distinguishes all five views, marks Wiki as selected and separates Details, goal and people with a divider. Narrow reading/editor frames retain legible text and contained controls; the visible page-action menu groups history, share, download and adding pages clearly. Desktop import/refusal keeps the page index and document readable, with local feedback beside Import .md.

One nonblocking P3 conformance detail: in `wiki-phone-390-view-menu.png`, the Agents row uses a sparkle glyph, whereas canonical `phone-viewsmenu.webp` uses Kreska (F-026 P3 / §3). Prefer the canonical Kreska navigation mark for consistency. The text label remains clear, so this does not block the reviewed header/reader composition.

## Limits

Screenshots do not establish 44 px hit targets, focus/keyboard operation, contrast ratios, scrolling, download/import correctness, persistence or responsive transitions. Wide-table containment and its last-column readability are visually unverified because no table frame was supplied. Dark menu, 320 dark, open Details and phone import-refusal states were not supplied. This report adds no functional-test claim and makes no whole-task acceptance decision.
