# Flux Studio v11 direction and focused UX refinements

**Latest refinement:** [Studio 11.1 / F-014](studio-v11.1-refinement.md), received
2026-09-30, adds the next appearance/draft targets and reconciles active work.
This earlier record preserves the original F-013 decision and evidence; the
latest reconciliation takes precedence for the final target. #133 has since
merged via #140; #134/#135 remain active and #136 owns integration.

**Date:** 2026-09-29. **Founder direction:** F-013, [#132](https://github.com/ColdPhase/flux/issues/132). **Implementation status:** the reference/audit and [runnable refined preview](references/studio-v11/preview/README.md) are a shared design deliverable; [#133–#136](#implementation-contracts) are proposed application work. The real application still has its merged C-based components and behavior. This document does not declare those follow-ups implemented or release-accepted.

Hubert identified the supplied Flux Studio v11 as approximately the intended finished appearance and functional experience, while acknowledging useful improvements in the current repository. Preserve its calm, connected creative character; improve the specific remaining friction. This supersedes the v8-only visual baseline and the fixed rail/indigo treatment of O-003. The accepted human/AI, audience, graph, live, architecture and mobile contracts continue to apply. Earlier C choices remain valuable history, not a reason to ignore this later instruction.

The byte-preserved [reference package](references/studio-v11/README.md), source, supplied images and fresh inspection are available to both development agents and Maurycy. Do not choose a new design from memory or copy the prototype’s single-file implementation into production.

## Preserve

- The human conversation and source-linked work remain central. AI messages follow the ordinary message hierarchy with clear authorship; private assistance and shared answers retain the existing owner/audience rules.
- Personal space, sketchbook, independent projects and DMs are easy to find. A compact header shows the place, audience and an optional current goal, with stable Conversation / Map / Tasks / Wiki navigation.
- “Co ważne” has one predictable entry. Secondary details, assistant setup and live controls appear on demand, without several competing sidebars or a large goal card over the conversation.
- Maps support exploration; tasks represent undertaken work; results and wiki carry durable learning. Sources remain navigable in either creation order. The prototype’s content does not replace stable IDs, revisions, authorization or persisted application paths.
- Neutral light/dark surfaces, quiet separators, readable text and restrained accents. Keep the existing good keyboard/focus/modal/draft behavior and verify it again wherever a UI change affects it.

## 1. A compact private recap

**Founder observation:** “Podsumuj rozmowy dla mnie” is too large; “Mam kontekst” has a good scale. **Inspected:** `.summary-generate` is 381×39 CSS px in the 1440×900 desktop fixture. The problem includes its full-width saturated area and the surrounding setup block, not just button height. The phone reference repeats the project/title/privacy explanation and settings before useful content.

Use a content-sized action with a short label, for example **Zrób skrót** / **Summarize**, beside the relevant scope cue. A quiet/soft button is the starting treatment; compare it with a compact accent button in the same actual panel. Keep scope and date controls discoverable, disclose longer explanations on demand and make useful changes/next steps visible earlier. Preserve the recognizable completion action. Compact desktop controls must still have usable touch targets; do not shrink all text.

At zero messages, show a truthful empty state and the period-changing route; independently recorded results/requests may still be useful. Preserve privacy, snapshot stability, exact source return, the personal visit baseline and its separation from message-read status. Model use is optional and remains personal under #57/#68; production wording must describe the actual behavior, not “AI · demo” or the local HTML implementation.

The supplied rerun failed one previous-visit-baseline test. Its test fixture hard-codes a date; root cause is unestablished. Investigate it in #133 and carry the per-person/per-place regression into the application rather than accepting a historical green report.

## 2. Hierarchy is distinct from a graph relation

**Founder observation:** deep-list connections to a new shallower parent/root are visually confusing, with poorly integrated dark lines. **Inspected behavior:** adding an ordinary relation can also change the *presented* hierarchy. In the disposable fixture, `newRoot` starts at depth 0; connecting it to `deep4` makes the list render it at depth 5 under `deep4`, with no cross-link cue. [Before](references/studio-v11/inspection/map-deep-before-1440.png) / [after](references/studio-v11/inspection/map-deep-after-1440.png), exact data in [report.json](references/studio-v11/inspection/report.json).

Use a stable presentation forest over the many-to-many graph. Adding a relation must not silently imply a new parent. Explicit reparenting, if offered, is a separate deliberate operation. Keep hierarchy guides subdued and theme-aware; make non-tree relationships named, clickable and close to the relevant thought (**Powiązane z …** / **Related to …**). Following one reveals the exact destination and preserves a return route. Bound deep indentation on the phone while making the ancestor path available. Do not draw crossing wires over list text or duplicate the thought to represent multiple links.

The independent visual assessment also found repeated actions far away at the right edge. Put the core action near its entry; reveal secondary actions and additional relationships progressively. Stable reading, keyboard access and touch navigation matter more than making a more elaborate connector diagram. Existing graph IDs, labels/types, sources, undo and authorization remain authoritative.

## 3. Three theme-aware accent families

**Founder requirement:** choose three and stay with them; tune light/dark separately. **Selected target:** **Mint (default), Iris, Sky**. The value table below comes from the unchanged v11 computed styles, compared on the same conversation at 1440×900 and 100% zoom.

| Family | Light accent | Dark accent | Soft surface light / dark | Contrast: accent on surface light / dark | Contrast: button label on accent light / dark |
| --- | --- | --- | --- | --- | --- |
| Mint / Mięta | `#247358` | `#8ED8B8` | `#E7F4ED` / `#1C3028` | 5.72 / 10.71 | 5.72 / 9.49 |
| Iris / Irys | `#6742A6` | `#B7A8EF` | `#EEE8F9` / `#2A2539` | 7.22 / 8.34 | 7.22 / 7.73 |
| Sky / Błękit | `#2C609B` | `#94BCF3` | `#E9F0F8` / `#202C3D` | 6.45 / 9.08 | 6.45 / 7.97 |

**Reasoned choice, not a usability finding:** mint preserves v11’s recognizable default; iris offers a distinct creative alternative; sky offers another restrained cool alternative. Teal overlaps mint for a deliberately small menu. The warm and other remaining candidates are not inherently unusable; reducing preference decisions matters more than keeping nine variants. The separate visual reviewer found the six renders coherent; one prototype resolution marker (“To pytanie ma rozwiązanie”) still follows the appearance accent and must receive a stable semantic treatment in #135. The shortlist has measured readable text pairs in this fixture. That does not certify all production states or prove which colors users prefer.

Offer three named choices, **one active at a time**, with six theme-specific token sets. Switching theme keeps the family and resolves its appropriate light/dark values. Status/error/success/warning colors remain semantic and separately defined, with text/icons. No custom HEX picker or simultaneous three-accent decoration. Record hover/pressed/focus/selected/on-accent states through shared tokens, verify their composited pairs, and use a safe documented fallback for older preferences.

## 4. Conversation alignment

**Later founder clarification, 2026-09-29:** the conversation is too tightly centered. The current user's messages should sit clearly on the right; other people's messages on the left. The reference already reverses own-message rows, but `.messages` reserves an 800 px centered lane on wide surfaces, weakening the separation.

Use the available conversation pane with modest responsive edge spacing. Keep long bubbles at a readable width, with the existing author, timestamp, reply and source hierarchy. Own-message alignment follows the signed-in author, not a fixed demo name. Check project conversation, DM, long text, phone/tablet and the conversation narrowed by an open details/return panel. Source opening, drafts and chronological order remain intact. Carry the production change in #136 and show a matched before/after in the #132 preview.

## 5. Remaining UX polish

A separate reviewer examined nine supplied screens without code or the author’s rationale. [Full report](references/studio-v11/inspection/visual-review.md). The three material findings were:

1. Recap setup delays useful recap/actions, especially on phone — covered by #133.
2. Map-list titles/relations and distant repetitive actions require long-row tracking — covered by #134.
3. Phone kanban shows one column and a clipped sliver of another, offering weak orientation across statuses — covered by #136.

For phone work, use a legible status selector/column navigation or a useful existing table/list entry view. Keep desktop card widths and local board scroll; remember useful position when navigating. For the full interface, check long titles, empty/errors/restricted states, open assistant/details/live controls and the virtual keyboard. Avoid repeated setup explanations, excessive frames, several equally prominent actions and unread-count pressure. Preserve source context and draft recovery. Do not introduce a new dashboard or aesthetic to solve a local issue.

## Implementation contracts

All follow-ups belong to [milestone 2](https://github.com/ColdPhase/flux/milestone/2), which already owns the complete application. A separate design milestone would fragment this required product work.

| Task | Owner / independent evaluator | Scope and dependencies |
| --- | --- | --- |
| [#132 reference and shared direction](https://github.com/ColdPhase/flux/issues/132) | codex-hubert / claude-maurycy | Byte-preserved package, audit, separately marked runnable refined preview with before/after evidence, entry points, milestone and proposed follow-ups; no production feature changes |
| [#133 compact private recap](https://github.com/ColdPhase/flux/issues/133) | claude-maurycy / codex-hubert | Extends merged #106/#117; coordinate with #87; #68 only for optional model use |
| [#134 stable deep map relations](https://github.com/ColdPhase/flux/issues/134) | codex-hubert / claude-maurycy | Extends #69; coordinate #96/#94 on shared sketch components |
| [#135 three light/dark accents](https://github.com/ColdPhase/flux/issues/135) | codex-hubert / claude-maurycy | Shared tokens from #40; token review before dependent styling |
| [#136 calm integrated UI/phone work](https://github.com/ColdPhase/flux/issues/136) | claude-maurycy / codex-hubert | Own messages right / other people's left, phone work navigation and final affected-slice integration; coordinate #62/#96/#94, preserve completed functional slices |

Founder requirements are current direction. Each proposed implementation contract still receives concise independent peer agreement, implementation and current-head review; no founder approval queue. An assigned backlog task is not a claim that implementation has started.

## Verification and research boundaries

- Compare actual application before/after at 1440×900 and 1280×800, 100% zoom; add 390×844, tablet and enlarged text. Use realistic names, content and permissions, and inspect the whole view with panels open.
- Test real persisted UI/API behavior separately from visual assessment: two users, source links, loss of access, no AI, failed sends/generation, scope/account changes and keyboard/touch routes. The supplied extraction and local fixtures do not prove production security or model ownership.
- Retain #44’s three integrated journeys, #57 personal compute, #59 live work and MOB-1–MOB-7. Real phone/tablet installation and OS push remain #20 acceptance; screenshots cannot substitute for them.
- Primary standards checked 2026-09-29: [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) (normal text 4.5:1), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) (applicable essential graphics/controls 3:1), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) (24×24 minimum or specified exceptions), and [cognitive usability guidance](https://www.w3.org/TR/coga-usable/). Flux retains a 44×44 starting target for primary touch actions. Reducing repeated copy and progressive disclosure are our design inferences, not evidence of a user study.
- Fresh reference inspection rendered 13 views with zero page errors and measured selected pairs. Supplied-suite rerun: 168 interaction passes, one failure, 108 standalone contrast passes. The [reports](references/studio-v11/README.md#evidence-boundaries) list limits; this task did not run the full application suite or test hardware, screen readers or real users.
- The separately marked refined preview shows all four requested corrections with matched before/after states. Its [Docker report](references/studio-v11/preview/evidence/report.json) records 75 focused passes, 38 screenshots and zero page errors; current application Docker build/typecheck/lint passed. This does not resolve the original supplied-suite failure or complete production follow-ups.
- A [fresh independent visual review](references/studio-v11/preview/evidence/visual-review.md) inspected 14 final images. Its phone-toolbar density finding was resolved by sharing the search/create row; no material visible issue remains in that reviewed scope. Exact image/source/report hashes are recorded separately, and eligible GitHub peer review remains required.
