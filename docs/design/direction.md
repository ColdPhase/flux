# Current Flux design direction

**The current target is [Studio 11.6](studio-v11.6.md), F-017, received
2026-09-30.** Use its [original HTML and current screenshots](references/studio-v11.6/README.md),
[F-016 co-work](../product/mcp-cowork.md) and [F-015 adaptation](adaptive-workspaces.md).
Preserve useful implemented behavior; deliver the complete visual redesign and
connected flow through #136 without replacing architecture or permissions.

Earlier C/v8/v11/11.1 decisions are [history](reference-history.md), not competing
instructions. The production components are an implementation starting point,
not proof that the new target is finished. Improve remaining phone/large-screen
friction within the accepted direction.

## Working rules

1. Keep conversation, map, work, knowledge and the same-task Agents view central and connected, with explicit personal/DM/project audiences. Source links and exact object identities are preserved.
2. Use the Studio 11.6 composition, compact goal/audience line, stable work tabs and “Co ważne” entry as the reference. Details/assistant/live controls open on demand; improve weak points without restarting the design.
3. Keep the private recap compact. “Podsumuj rozmowy dla mnie” loses its large full-width accent treatment; “Mam kontekst” retains its useful completion role and scale. Useful changes/actions appear before a long setup explanation.
4. Separate the map-list reading hierarchy from ordinary graph relationships. A relation to a deep thought does not silently move a shallow/root thought. Use named nearby cross-links and readable theme-aware guides, with a phone/keyboard route.
5. The reviewed next appearance target is Mint (default), Sky and Copper, with separately remembered light/dark choices and tuned values (#148). Preserve #135’s earlier Mint/Iris/Sky contract and current review; apply the amendment as its bounded successor with explicit migration. Status colors retain their meaning and accompanying text/icons. [Current contract](studio-v11.6.md) distinguishes candidates from verified production tokens.
6. Align the current user's conversation messages to the right and other people's to the left. Use the available conversation width with restrained edge spacing, while limiting long message text to a readable measure. Keep authors, chronology, replies and source cards clear; check the narrower conversation beside an open panel as well as phone views.
7. Improve density through grouping, fewer repeated controls/copy and restrained saturated area. Do not globally scale the view or shrink important text. Retain visible focus, modal containment, usable touch targets and reduced motion.
8. Preserve #57 personal AI and human continuation without AI, #59 contextual live work, and MOB-1–MOB-7. Demo AI/media/local storage and historical test claims never establish production behavior.

9. Apply [F-015 adaptive workspaces](adaptive-workspaces.md): small Android phones
   through 4K/ultrawide, useful additional context when space permits, stable
   vocabulary/actions and preserved work during size/device changes. Readable
   text, user-controlled context and the actual available pane size govern layout.
   #151 supplies the adaptive implementation; #136 verifies the combined UI.

## Implementation and evidence

Use existing shared [tokens/components](../../app/apps/web/src/ui) and accepted architecture; follow current repository path amendments during #76. Record contract changes before implementation, keep tokens and components consistent, and respect active issue/branch ownership. The [current delivery table](../product/mcp-cowork.md#delivery-and-evidence--co-5) maps the backend/UI slices. #133 is merged; active #134/#135 foundations retain review scope, followed by #148/#149. #136 integrates the final 11.6 result.

Render realistic states at matched desktop, phone and tablet sizes/zoom. Obtain a neutral independent visual review, then verify actual keyboard, focus, touch, contrast, persistence, access and source paths separately in Docker. #44’s three integrated journeys and real PWA/device evidence remain release requirements. Unknown outcomes stay open; a PNG or the reference import is not a production acceptance pass.
