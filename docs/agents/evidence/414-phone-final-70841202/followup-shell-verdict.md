# Follow-up shell verdict — Flux phone surfaces

**Overall for the #414 phone-shell scope: no blocking visual conformance issue was established by the added Home and Details evidence.** The returning-user Home frame shows the P1 “Continue where you left off” card with a task title, state/project context, and a round arrow affordance; it also shows the Needs you count and cards. The earlier Home frame was a new-account fixture with no assigned work or previous return point, so its empty state and lack of a Continue card were appropriate to that state. The 320 captures are confirmed as 320×568 CSS px; the earlier manifest/brief discrepancy is resolved.

The open Details screenshots present project identity, overview, current work, sketches, docs, and visibility in a coherent monochrome sheet in both themes. One low-severity optional polish item remains: an in-progress task repeats its title verbatim in a second line. Since F-026 has no opened project Details reference or uniqueness rule for that secondary line, this is not a blocking conformance failure. See `followup-details-visual-review.md` for the observation and frame references.

The task surface still visibly shows a Search / Kanban / List / Mine row plus Open / In progress / Done controls in the initial capture. This remains an unresolved integrated F-026 conformance observation, but it is inherited/outside #414’s phone-shell slice and belongs to #375. It should not be reported as a correction to this PR’s shell work or counted as a #414-specific blocking finding.

The supplied phone screenshots show a coherent Home/Create/project menu/conversation/question/Stop flow: Home uses the floating capsule and separate Search control; the conversation has no tab bar and keeps the composer at the bottom; the project view menu groups its project views and Details entry. Screenshots cannot verify navigation, sheet scrolling, control behavior, keyboard use, accessibility, or responsive transitions.

## Evidence

- Initial exact-46f packet and manifest: `manifest.json` (frames whose capture source is `46f635e9` are production-source-equivalent to the exact 70841202 head)
- Exact-head supplement manifest and run record: `manifest.json` and `capture-run-record.md`
- Returning-user Home: `screens/home-final-phone-390.webp` and `screens/341-home-returning-390-dark.webp` (390×844 CSS px, DPR 3)
- Open Details: `screens/341-details-320-{light,dark}.webp` (320×568 CSS px) and `screens/341-details-390-{light,dark}.webp` (390×844 CSS px), DPR 1
