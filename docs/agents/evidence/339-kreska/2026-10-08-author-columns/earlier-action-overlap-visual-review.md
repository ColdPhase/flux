# Independent replacement visual review: author identity and event column

Reviewed 2026-10-08, 01:38 UTC. This is a bounded, read-only replacement review against the unchanged neutral collaborator job and accepted F-026 author rules. The initial report at `/tmp/flux356-final-author-neutral-visual.md` is preserved as historical evidence. No implementation code, revision history, prior author rationale, or functional/security evidence was read. No application, source, or GitHub changes were made.

**Bounded verdict: not visually accepted across the supplied phone author states. One material P2 finding remains: the floating Details control obscures author identity.** The desktop author/owner lines and task-event content starts remain clear. The dark phone workspace-event header is now readable without the earlier superimposed reply view. The personal-agent and task-event phone files are byte-identical and constitute one visual context, not two independently captured states.

The assessed job is distinguishing a person from an agent, reading the full author name, Agent tag, and human/workspace owner, and scanning task events and replies on one author column. Accepted constraints remain a 32 px author column with 12 px desktop / 10 px phone content gap, full author names, and the own inverse bubble. The review does not approve the whole functional issue or whole F-026 design, and does not certify behavior, permissions/security, persistence, responsive transitions, or accessibility.

Supplied application snapshot: `d85c9a931837a97b80b8a18da7a8dc3ba64df661` (D85). Supplied latest test-only pin: `87204070bc431cee5302a6bc4ec37b8604c12cdd`. Their relationship to the screenshots is supplied evidence only; this reviewer did not inspect source or history to establish it. Actual raster dimensions and hashes below were read from the files. Text scale and CSS viewport labels come from the neutral brief/filenames. The two unchanged task-announcement captures have a raster width of three times the stated phone width.

## Material finding (1)

**P2 — Floating Details control covers an agent's identity at 390 px and 200% text.**

- **Location:** In the byte-identical `agent-owner-reader-390-text200.png` / `task-event-reader-390-text200.png`, the control is around x=254–374, y=306–350. In `workspace-agent-event-390-dark-text200.png`, it is around x=254–374, y=557–598; in `workspace-agent-author-390-dark-text200.png`, around x=254–374, y=526–568.
- **Visible symptom:** The personal-agent header shows `Trial analyst` and `for Casey Human`, but the Details control covers the latter part of the Agent tag. In both dark workspace captures it covers the latter part of the message author's `Workspace analyst` name. The clean workspace event header above remains fully readable, including Agent and `for the workspace`.
- **User consequence:** A collaborator cannot read the complete required agent tag or author name in the affected message header. The full-name and explicit agent distinction are obscured by an unrelated control even though the content-column layout is otherwise consistent.
- **Improvement direction:** Place the Details affordance in reserved layout space outside the author line, or let the author metadata wrap in space that the control cannot cover. Preserve the full name, Agent tag, and owner text, then recapture the affected light/dark phone headers at the same text scale. This is a visible outcome requirement, not an implementation prescription.

## Elements to preserve

- The two desktop conversation/reply captures retain the Kreska squircle for `Trial analyst`, a visible Agent tag and `for Casey Human`, and circular initials for `Casey Human`. Both names and the owner attribution are readable. The own inverse reply in `agent-root-desktop.png` remains clear.
- `339-scoped-owner-agents-thread.png` keeps `Scoped analyst`, Agent, and `for Scoped Casey` compact and readable. Its reply starts on the same content column as the author name.
- The replacement light phone context visibly includes the full `Casey Human` task-event author and a full `Trial analyst` name with `for Casey Human` beneath it. The clean workspace event header includes the full `Workspace analyst`, Agent, and `for the workspace`; wrapping retains the owner without ellipsis.
- Visible author, event-text, task-reference, and bubble starts follow a consistent left edge beside the avatars. The unchanged 320 px light and 390 px dark task-announcement images preserve full `Jonas Berg` and `Ada Kowalska · you` author names at enlarged text, with the `New task` content beginning on that same edge. These observations fit the requested column/gap direction without claiming exact CSS/DOM measurement.

## Coverage and remaining live checks

All nine specified paths were opened with `view_image` at original detail. Eight distinct byte sets were observed: the personal-agent and task-event reader phone filenames share one hash and display the same image. They show both a human task event and the personal agent header in one viewport; this is one visual context.

The initial missing-state evidence gap is reduced by the newly visible source authors/events. The obscured portions identified above prevent acceptance of full phone author identity. Screenshots cannot establish scrolling/reachability, entering and leaving replies, text-scale transitions, keyboard/focus, touch targets, identity/owner data correctness, permissions, or measured contrast; those remain outside this visual review.

## Exact reviewed screenshot bytes

First seven paths use `/tmp/flux356-callbacks-final-e2e/`; the final two use `/tmp/flux356-event-edge-current/`.

| File | Actual raster size | SHA-256 |
| --- | --- | --- |
| agent-root-desktop.png | 1280×900 | `bcbea792dfea771ae606d8e3a4759e857fd8e3c9c8c70b10c624215e5d70c105` |
| mixed-authors-reader-1280.png | 1280×900 | `42f136dff60a81a273ccf315974fb9464216e1acc059d0e8ee46b395b6cd4ad5` |
| agent-owner-reader-390-text200.png | 390×900 | `e99e1dc765a21be0e69400f5a49165ad9c9bf89e7c0f4f660176bcd9923941b9` |
| task-event-reader-390-text200.png | 390×900 | `e99e1dc765a21be0e69400f5a49165ad9c9bf89e7c0f4f660176bcd9923941b9` |
| workspace-agent-event-390-dark-text200.png | 390×900 | `17285a9955ffd5e371e91a5e508de247cbe07b3c61d79af80da81b1d956b37e3` |
| workspace-agent-author-390-dark-text200.png | 390×900 | `a4bf8c0e402406cace3199ef9c07d9aceaf9e9d5b2a071c2ef4da83a69cf59c9` |
| 339-scoped-owner-agents-thread.png | 1440×900 | `5468fdf1fbb91dd0e74c26d60c9e4dd8176b5faa67c223056208e4b4e40fd245` |
| task-announcements-phone-320-text200.png | 960×1920 | `4b447593f9b71855e9bb418dfe5d82dafd8ba1b9e9a928c34c88227f4d2a78d2` |
| task-announcements-phone-390-dark-text200.png | 1170×2532 | `67086d88c650c4db0536306b5c10fa586911f32681c57c22c9ae36ebdc785ea9` |

Reference basis retained from the initial review: the final guide, plus the actual inspected `desktop-conversation.webp`, `desktop-thread.webp`, `desktop-tasknotice.webp`, `phone-conversation.webp`, `phone-thread.webp`, `phone-tasknotice.webp`, and `phone-conversation-dark.webp` under `/home/hubert/.codex/worktrees/339-kreska-fixes/flux/docs/design/final/screens/`. These establish the monochrome human/agent distinction, column rhythm, inverse own bubble, and thread/event hierarchy. The written F-026 rules establish the full-name and owner requirement.
