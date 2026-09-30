# Current Flux design direction

**Current target:** founder-supplied **Flux Studio v11**, received 2026-09-29, under [F-013 / #132](https://github.com/ColdPhase/flux/issues/132). Read the [focused direction and UX contract](studio-v11-refinement.md) and inspect the [preserved HTML/source/screenshots](references/studio-v11/README.md) before changing the UI. It is approximately the desired final appearance and connected experience, with deliberate improvements for usability and useful behavior already in the repository.

This later direction qualifies O-003 and replaces the earlier v8-only visual baseline and mandatory rail/indigo treatment. It preserves the calm C principles and #44’s creative journeys; A/B remain rejected. Existing merged components are the implementation starting point, not evidence that the new refinements are complete. [The accepted 2026-09-27 C record](direction-c-2026-09-27.md) and its token/evaluation evidence remain available as history.

## Working rules

1. Keep conversation, map, work and knowledge central and connected, with explicit personal/DM/project audiences. Source links and exact object identities are preserved.
2. Use the v11 composition, compact goal/audience line, stable work tabs and “Co ważne” entry as the reference. Details/assistant/live controls open on demand; improve weak points without restarting the design.
3. Keep the private recap compact. “Podsumuj rozmowy dla mnie” loses its large full-width accent treatment; “Mam kontekst” retains its useful completion role and scale. Useful changes/actions appear before a long setup explanation.
4. Separate the map-list reading hierarchy from ordinary graph relationships. A relation to a deep thought does not silently move a shallow/root thought. Use named nearby cross-links and readable theme-aware guides, with a phone/keyboard route.
5. Offer Mint (default), Iris and Sky, one chosen family at a time, with separately tuned light/dark values. Status colors retain their meaning and accompanying text/icons. The [contract](studio-v11-refinement.md#3-three-theme-aware-accent-families) lists measured candidates; final production states and tokens are verified in #135.
6. Align the current user's conversation messages to the right and other people's to the left. Use the available conversation width with restrained edge spacing, while limiting long message text to a readable measure. Keep authors, chronology, replies and source cards clear; check the narrower conversation beside an open panel as well as phone views.
7. Improve density through grouping, fewer repeated controls/copy and restrained saturated area. Do not globally scale the view or shrink important text. Retain visible focus, modal containment, usable touch targets and reduced motion.
8. Preserve #57 personal AI and human continuation without AI, #59 contextual live work, and MOB-1–MOB-7. Demo AI/media/local storage and historical test claims never establish production behavior.

## Implementation and evidence

Use existing shared [tokens/components](../../apps/web/src/ui/) and accepted architecture; follow current repository path amendments during #76. Record contract changes before implementation, keep tokens and components consistent, and respect active issue/branch ownership. The [follow-up table](studio-v11-refinement.md#implementation-contracts) maps #133 recap, #134 map relations, #135 theme accents and #136 integrated UI/phone work.

Render realistic states at matched desktop, phone and tablet sizes/zoom. Obtain a neutral independent visual review, then verify actual keyboard, focus, touch, contrast, persistence, access and source paths separately in Docker. #44’s three integrated journeys and real PWA/device evidence remain release requirements. Unknown outcomes stay open; a PNG or the reference import is not a production acceptance pass.
