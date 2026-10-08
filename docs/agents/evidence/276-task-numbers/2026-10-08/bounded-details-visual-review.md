# Independent visual review: finding and reading task #26

Reviewed 2026-10-08 in a fresh evaluator context using `flux-review-visual`. No implementation, revision history, author rationale, implementation handoff or other review was read. The job and boundary are `/tmp/flux282-6f9-neutral-visual-brief.md`: find known task #26 and read its number, project identity, Status and Owner on a computer and 390px phone, including enlarged text.

**Bounded verdict: acceptable visible number and metadata readability in all six supplied job captures; no material local visual finding.** This does not approve the full search, task-details feature, navigation or whole F-026 integration.

Source supplied with the captures: `6f962f6335cc7c560609a0c99c8309e1e83bf925`. All six screenshot hashes match `/tmp/flux282-6f9-ui-manifest.json`. Desktop files are 1440×900. Phone files are 1170×2532 at DPR3, representing 390×844 CSS pixels. Browser zoom is 100%; only the two `text-200` files have root text at 200%. Actual unmodified files were inspected with `view_image`.

## Evidence inspected

All paths below are under `/tmp/flux282-6f9-ui/`:

- `task-number-26-search-desktop-1440.png`
- `task-number-26-search-phone-390.png`
- `task-number-26-global-details-desktop-1440.png`
- `task-number-26-global-details-phone-390.png`
- `task-number-26-text-200-desktop-1440.png`
- `task-number-26-text-200-phone-390.png`

The manifest also lists other scenarios. They are not included in this verdict because the supplied neutral brief bounds this job to these six captures.

Accepted guide and references inspected under `/home/hubert/.codex/worktrees/339-kreska-fixes/flux/docs/design/final/`: `README.md`, `screens/desktop-tasks.webp`, `screens/reference-system.webp` and `screens/phone-conversation.webp`. P10 provides the calm property-row language; S17 provides the enlarged phone text constraint. The phone conversation reference supplies scale and character, not task-details behavior.

## Observations and useful elements to preserve

- Both search views visibly retain the query **#26**, one matching task, and **#26** next to its title. The highlighted digits distinguish the known number from the surrounding title and project metadata. On the phone, the filter truncates the project name, but the full **Hedge sensor calibration** name is repeated below the result and remains readable.
- In both opened Details views, the first metadata line identifies **Task #26 · Hedge sensor calibration · Open**, before the stronger task title. **Status / Open** and **Owner / Nobody yet** are two simple label/value rows. They fit above the fold and do not compete with the title through decorative cards or badges.
- At 200% text, the project metadata and title wrap in both Details views. The task number stays with its identity line; Status and Owner remain paired with their complete values. In the phone capture, **Nobody yet** fits without truncation, overlap or a horizontal cutoff. Increasing vertical reading length is expected with enlarged text.
- Preserve the direct reading order, explicit absence of an owner, visible close ×, and restrained monochrome hierarchy. The native field fills give the editable values enough separation while keeping the rows compact.

## Material findings

None for the specific number/metadata job. Differences between the surrounding current navigation and the accepted reference are outside the neutral brief and do not become a whole-screen approval.

## Questions for live checks and missing states

- The enlarged captures show task details, not enlarged search. Longer task numbers, long project names, non-empty long owner names and a crowded multi-result search are also not represented.
- Verify the actual number typeface and its scaling against Geist Mono in the app; screenshots show readable digits but cannot reliably certify a loaded font family.
- Verify scrolling, field expansion, selection menus, focus/close behavior, correct task identity and persistence in the running application. Search and native controls can be visually readable while still behaving incorrectly.
- This review does not establish permissions, data correctness, keyboard behavior, touch target size, WCAG compliance or whole-project completion.
