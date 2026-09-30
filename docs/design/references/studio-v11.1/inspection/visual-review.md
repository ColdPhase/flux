# Studio v11.1 independent visual review

**Verdict: preserve the overall direction; one material phone-layout correction is needed.** This is an independent screenshot-only assessment against the supplied neutral daily-work brief, not functional acceptance. No implementation, audit, revision history or author rationale was inspected.

Evidence: 2026-09-30; native Chromium 151.0.7922.34; 100% zoom; desktop 1440×900, phone 390×844, tablet 768×1024 CSS pixels. Source SHA-256: `c6b5263f36c51c569495980db6961bbf7862eccc9972ecc454b62da11ed50477`. Reviewed the eleven requested screenshots and all six `palette-1440-{light|dark}-{mint|sky|copper}.png` comparisons under `docs/design/references/studio-v11.1/inspection/`. All seventeen image hashes matched the final `inspection/report.json` metadata.

## Material visible problem

**Phone work overview — `tasks-390.png` (SHA-256 `151295784563d032f185bbdd470d2a1b70d5c2ff2c99d7318f5239ea9909e1ad`).**

- **Location:** board below the search field, especially the right viewport edge.
- **Observation:** only “Do zrobienia” and its one card are readable. The next column appears as a narrow clipped strip. No visible status index, counts for the other states, or labeled jump controls explain what lies horizontally outside the viewport. The board/list switch is icon-only.
- **Consequence:** a person checking active or blocked work must discover horizontal navigation or interpret the alternate-view icon before they can establish the work state. The large unused lower area reinforces the impression that this is the complete task set.
- **Direction:** give narrow screens a readable status overview with labeled counts and direct access to active/blocked states, or start with a grouped vertical list. Retain the existing task-card clarity and prominent add action. `tasks-768.png` fits two readable columns, but does not establish discoverability of further states.

This is an observable information-discovery problem relative to the phone brief, not a preference against boards. No second or third material visual problem is warranted by this evidence.

## Preserve

- **Conversation:** own messages remain right-aligned and others left-aligned; author/time labels, restrained bubble colors, inline task/source material and the anchored composer provide a clear working structure. Opening the desktop recap still leaves a usable conversation area.
- **Recap:** “Potrzebuje Ciebie,” the help-request treatment, direct source links and “Odpowiedz i odblokuj” connect context to action. The period, personal scope and acknowledgment remain visible on phone.
- **Map:** restrained tree guides, wrapping labels, explicit level/parent text at depth, reciprocal related-item cards, and visible row actions preserve orientation. The phone draft sits next to its selected context and exposes save/cancel without a separate full-screen detour.
- **Appearance:** labeled light/dark previews, checkmarks, named swatches and the explanation of separate remembered choices make the preferences understandable. All six palette screenshots keep the same hierarchy and clearly distinguish own messages.

**Aesthetic preference only:** mint feels particularly calm on the dark surface; sky and copper are also coherent. These screenshots give no usability reason to remove either alternative.

## Separate live verification still required

Exercise phone board navigation and the list switch; reaching blocked work; long project names and active-location cues after navigation; map disclosure, local add/edit/save/cancel and related-item navigation; recap source destinations and acknowledgment; theme/accent changes and reload persistence. Test keyboard focus and modal containment, enlarged text, touch targets, measured color contrast and screen-reader labels separately. Missing visual states include the blocked task column/list, appearance on phone, empty/error/loading states, long-name stress cases and enlarged text. Screenshots do not certify keyboard behavior, data correctness, persistence, responsive transitions or WCAG compliance.
