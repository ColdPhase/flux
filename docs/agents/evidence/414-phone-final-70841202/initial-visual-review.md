# Independent visual review — Flux phone shell

**Verdict: needs visual correction before treating the phone surfaces as conformant to F-026.** Review is limited to the rendered screenshot packet for source `46f635e9234dceca5eab453d8a12754c3c74ba48`; no implementation, PR discussion, interaction, keyboard, accessibility, or data behavior was evaluated.

## Material findings

1. **Home omits the required return-to-work anchor (major).** In `341-home-390-light.png` (390×844), the greeting leads into “Needs you” and a quiet-state card, then a two-row Projects card; the rest of the viewport is mostly empty. The canonical `phone-home.webp` gives the first screen to “Continue where you left off” and a working-agent card before the Needs you queue. The current Home therefore loses the main re-entry point and useful context for returning to ongoing work even at 390 px, where there is room for it. Preserve the quiet state, but include the Continue card in the intended first-screen hierarchy (and show the working-agent card when one is active). The 320 capture also shows the Projects card continuing behind the floating navigation, so verify its scroll clearance in the live view.

2. **Task view adds two competing control rows under the project title (moderate).** In `341-create-390-light.png` and its dark counterpart, the underlying project screen has a row for Search / Kanban / List / Mine and a second row for Open / In progress / Done. The canonical phone structure makes the project title the view menu and specifies no chip rows (`phone-viewsmenu.webp`, F-026 Phone section). These rows take a large share of a short phone viewport and split attention from the project content. Consolidate the view choice into the title menu and keep only controls required for the active task view, with its status choices presented in the canonical structure.

3. **The narrow-phone evidence is shorter than the brief says (review limitation).** The brief says 320×844 for filenames containing `320`, but the manifest records those PNGs as 320×568 (for example `341-home-320-light.png` and `341-viewsmenu-320-light.png`). This prevents judging the 320 px-wide layout at the stated 844 px height. Clarify which viewport was captured and recapture the intended height if 320×844 was the target. Also, the packet shows the “Details, goal and people” menu row but contains no opened Details frame, so that surface remains unevaluated.

## Elements to preserve

The light and dark themes use calm, monochrome surfaces with clear active-view treatment. The Create sheet’s six evenly sized actions and project selector are easy to scan at both widths (`341-create-390-light.png`, `341-create-320-light.png`). The project view menu keeps Conversation, Tasks, Map, Wiki, Agents, and Details together in a clear list (`341-viewsmenu-390-light.png`, `341-viewsmenu-390-dark.png`). The conversation composer remains visually anchored at the bottom without a tab bar, in line with S2.

The question thread (`question-card-phone.png`) and Stop-header state (`stop-conversation-header-phone.png`) were inspected. Their screenshots show the question, prepared answers, reply composer, and a visible Stop control; screenshots cannot establish whether these controls work. No additional material visual issue was apparent in those two frames.

## Evidence

Neutral brief: ``neutral-brief.md``

Frame manifest and hashes: ``manifest.json``

Canonical comparisons: `docs/design/final/screens/phone-home.webp`, `phone-viewsmenu.webp`, `phone-create.webp`, `phone-conversation.webp`, and `phone-conversation-dark.webp`.
