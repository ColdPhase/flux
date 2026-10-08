# Independent visual review: author identity and event column

Reviewed 2026-10-08, 01:22 UTC. Read-only review in a fresh reviewer context, using the supplied neutral job brief, the Flux visual review skill, `docs/design/README.md`, and the accepted final design guide and reference images. No implementation code, revision history, prior reviews, or author rationale was read. No application, source, or GitHub changes were made.

**Bounded verdict: the supplied set is not visually accepted for the complete requested author-identity scope.** One material visible problem affects the dark phone workspace-agent captures. The desktop captures and the two task-announcement phone captures support the consistent author/event column. Two other supplied phone captures do not expose the agent/event states named in their filenames, so those states remain visually unverified.

The job assessed is a collaborator distinguishing people from agents, reading full author names and the Agent/owner attribution, and scanning task events and replies using one author column. Accepted constraints are a 32 px author column, 12 px desktop / 10 px phone content gap, full names, and the own inverse bubble. This is a visual finding only: it does not approve a functional issue or establish permissions, keyboard/touch behavior, persistence, responsive transitions, or WCAG compliance.

The supplied production identifier is `d85c9a931837a97b80b8a18da7a8dc3ba64df661`; the supplied latest test-only identifier is `0c195c973c03c7ab1ad305da7d369984d48a4eb6`. Their relationship to the captures is supplied evidence, not independently established by this review. Pixel dimensions below were read from the actual files. Text scaling and CSS viewport labels come from the supplied brief/filenames; the two task-announcement files are 3× raster captures of the stated phone widths.

## Material finding (1)

**P2 — Overlapping layers obscure workspace-agent identity at 390 px, dark, 200% text.**

- **Location:** `workspace-agent-event-390-dark-text200.png` and `workspace-agent-author-390-dark-text200.png`, roughly image y=190–550, immediately beneath the project tabs.
- **Visible symptom:** The foreground `Replies 0`, root message, task card, and `No replies yet` coexist with faint conversation text behind them. `Workspace analyst`, the Agent tag, `for the workspace`, and duplicate observation/task text show through the reply view. In the author capture, the attribution sits beneath the reply heading and foreground root text rather than remaining a readable author header.
- **User consequence:** The collaborator cannot reliably scan the workspace agent's full author/owner identity in this state. The multiple visible text layers compete with the message and event, breaking the otherwise clear author-to-content relationship.
- **Improvement direction:** Give the phone reply surface a visually opaque, contained layer and sufficient layout space for its own root author header. Keep background conversation text outside that reading surface, then recapture both the workspace-agent event and author with their full author/Agent/owner lines visible at the stated text scale. This describes the visible outcome needed, not an implementation prescription.

## Elements to preserve

- In `agent-root-desktop.png` and `mixed-authors-reader-1280.png`, circular human initials and the Kreska squircle distinguish authors without color. `Trial analyst`, Agent, and `for Casey Human` are legible together in the conversation and reply root. Human `Casey Human` remains readable in the reply header; the own inverse reply in the first capture remains clear.
- In `339-scoped-owner-agents-thread.png`, `Scoped analyst`, Agent, and `for Scoped Casey` form a compact, readable author line. The reply content starts beneath that line on the same content column.
- The visible desktop name, bubble, task reference, and event starts follow a stable column beside the avatars. The 320 px light and 390 px dark task-announcement captures likewise align `Jonas Berg` / `Ada Kowalska · you`, `New task`, and the neighboring message/task content on one left edge. Full author names survive the enlarged text; wrapping keeps names legible. These observations fit the accepted column/gap direction, without claiming DOM measurement of its exact CSS values.

## Evidence gaps and live checks

`agent-owner-reader-390-text200.png` and `task-event-reader-390-text200.png` show the human `Casey Human` reply, `Replies 1`, and the read-only source area. The personal-agent author/owner header and task-event source are outside the visible capture. Their filename labels cannot establish those states; obtain captures with the relevant source author/event visible, including a long author/owner name.

After resolving the overlapping workspace view, live testing still needs to establish scrolling and author retention when entering/leaving replies, enlarged text without clipped reachable content, keyboard/focus and touch behavior, actual identity/owner data, permissions, and measured contrast. No such functional or accessibility acceptance was performed here.

## Actual screenshot bytes

First seven files are under `/tmp/flux356-final-barriers-e2e/`; final two are under `/tmp/flux356-event-edge-current/`. Every file was opened with `view_image` at original detail and hashed from its actual bytes.

| File | Actual raster size | SHA-256 |
| --- | --- | --- |
| agent-root-desktop.png | 1280×900 | `416e51f478aa34fcc50c70cbed2a3bc7f6f9752ca18062e06b32173d6bf42150` |
| mixed-authors-reader-1280.png | 1280×900 | `6b73883c20e389e825160818511dc16a6271fc7b808fdda74cc0cde92dae7e74` |
| agent-owner-reader-390-text200.png | 390×900 | `23d9ceda108459fade40f2193af575ec809ab46a8a3864488ccb8647f71b4353` |
| task-event-reader-390-text200.png | 390×900 | `4496ad16169cc8a708d250a740d30a836bd4c7185afb7d7792ba209838d5ba74` |
| workspace-agent-event-390-dark-text200.png | 390×900 | `e5a0a372fe1eeb982d36cfcdd6b28501c5faf45e58ed84fe932e2cb8cf3e634d` |
| workspace-agent-author-390-dark-text200.png | 390×900 | `1d7e9242aef73f235a1613caf47dbda93657bf988d5e3e680c823fb8abc17a42` |
| 339-scoped-owner-agents-thread.png | 1440×900 | `71b5af4f8d60ad165cce293fb4794ae43e19376741451411dd163d8d4b7afc3f` |
| task-announcements-phone-320-text200.png | 960×1920 | `4b447593f9b71855e9bb418dfe5d82dafd8ba1b9e9a928c34c88227f4d2a78d2` |
| task-announcements-phone-390-dark-text200.png | 1170×2532 | `67086d88c650c4db0536306b5c10fa586911f32681c57c22c9ae36ebdc785ea9` |

## Inspected accepted references

Reference directory: `/home/hubert/.codex/worktrees/339-kreska-fixes/flux/docs/design/final/screens/`. All seven reference images were also inspected at original detail. They supply the column rhythm, own inverse bubble, Kreska/human distinction, and conversation/thread/task-notice hierarchy. The written F-026 rules supply the full-name/owner requirement where an individual drawn reference omits it.

| Reference | SHA-256 |
| --- | --- |
| desktop-conversation.webp | `a21d455f9d7a9900fbc8e3618b61dcef34174349599bfb6fbfe4632d0bcd021c` |
| desktop-thread.webp | `7d2eb79b426b74ece9fc7afab3bdbb4ea920e37da5259659300e8c5ee02e0c78` |
| desktop-tasknotice.webp | `3deb8d694ebb7743e8a5d4c0cc45bd69b76a1a43940e81d72e8496870f306641` |
| phone-conversation.webp | `a278b95fc7dc047eb312423aed68d4c21befb60495c95e101917a3aa2466f85d` |
| phone-thread.webp | `d9586635e119839c52f9b1ef36cd22c47603fc9798da9151c30f48055f74a888` |
| phone-tasknotice.webp | `486217b3ec0f9660494891c7388887e49a2742648541a9c2a6b9b80442464854` |
| phone-conversation-dark.webp | `2197632f3811b7114b4e745e865c641de6a81e8650a125802813c120b37f7fe7` |

Final guide bytes: `4d9d96b9565da7b26a1a23104e0932ae29ee4972fadc9a61f528698c1b87273f`.
