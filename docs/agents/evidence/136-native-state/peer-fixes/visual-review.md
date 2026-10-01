# Independent visual review — Flux project header and reader states

Reviewed 2026-10-01 using `.agents/skills/flux-review-visual/SKILL.md`. Fresh independent reviewer context; no implementation, PR history, or author rationale inspected. Read-only review of the supplied immutable PNGs; no repository edits or GitHub messages.

Neutral job: project participants need to identify the project and who can see it, navigate saved work, and read conversation/history in a compact working surface. Constraints: readable audience, compact header, usable controls/content, full long project name may be available in Details, and read-only access.

## Evidence

Supplied metadata: all screenshots at 100% browser zoom, Chromium emulation. The viewport dimensions below are the supplied capture dimensions; hardware rendering/scaling is unverified. No source commit was supplied to this fresh reviewer, so this assessment is tied to the exact image hashes, not an inferred commit.

| Screenshot | Viewport | SHA-256 |
| --- | --- | --- |
| `136-state-long-title-71-820.png` | 820 × 1180 | `28556f9ab56f95a07399217ed70fc6ce1c3a4e5b5709b15636d84f1ab8038ab8` |
| `136-state-long-title-122-744.png` | 744 × 1180 | `deb0e05e587b9b7ffc062c68d0fae6090731887e37ab6e1bf426d7e0b44fe75b` |
| `136-state-reader-1280-light.png` | 1280 × 800 | `6eec937b1aee3c22774b9945396c429f431ad15b1da28b6ca44f6aac8e49a37f` |
| `136-state-reader-saved-conversation-390.png` | 390 × 844 | `64d53832b7e70b5d42f766a4d87691c59ab0d61eef25572c76020bce98ddd326` |

Files: `/tmp/flux136-peer-visual/`.

Appearance guidance inspected: `docs/design/README.md`, `docs/design/studio-v11.6.md`, foundation including design sections 10 and 17 D1–D4. Reference images inspected: `studio-v11.6-chat-1440-light.png` and `studio-v11.6-chat-390-dark.png` under `docs/design/references/studio-v11.6/inspection/`. These have different content and, for phone, theme; they informed character/grouping and are not a matched before/after comparison.

## Assessment

No material header hierarchy or readability finding in these four captures. The project name retains a strong visual anchor, the audience text is legible, Details remains visible, and work navigation stays compact. In the two long-name states the header truncates the project name without displacing the audience or controls. The phone header allows the audience to wrap while keeping the project and Details distinct. The read-only desktop and phone states explicitly explain the access limit, and the phone conversation preserves visible author, time, message and source/detail affordances.

The neutral surfaces, restrained active-tab underline, compact type and quiet message bubble are compatible with the reference direction within this narrow scope. This does not establish full Studio 11.6 integration.

## One material visual finding

**Tall empty conversations disconnect the invitation from the writing surface.** Location: both 1180px-tall long-title captures, between the introduction near y200–305 and the composer beginning near y1115. Visible symptom: approximately 800px of empty vertical space separates the end of the invitation from the input. Consequence: a first-time participant must travel across most of the screen to act on “Start a conversation”; the invitation and primary action do not read as one compact working group. Direction: keep the empty-state introduction and first input visually connected on tall layouts, for example by grouping them within a bounded starter area, while retaining usable navigation and the readable audience. This follows Studio 11.6's explicit tall-screen direction; it is not a preference for filling blank space with decoration. It is a conversation-layout finding, not a header readability defect.

## Preserve

- Bounded single-line long project name at tablet widths, with persistent audience and Details affordance.
- Explicit audience names plus “only you two,” repeated near the input/status where useful.
- Strong project title, modest supporting status, quiet active-tab underline, and consistent Conversation / Tasks / Map / Docs vocabulary.
- Direct read-only explanation and source affordance, without a prominent false send action in the two reader captures.
- Compact phone author/time/message grouping and the visible saved-conversation identity above the read-only footer.

## Missing evidence and live checks

There is no open-Details screenshot proving the full long name is visible there; verify it live. The phone project selector, populated saved-work navigation, dense conversation/history, long multiline message, enlarged text and focus states are absent. Confirm Details/source navigation, reader permission enforcement, tab changes, scroll/return continuity, keyboard and touch targets, contrast, and responsive transitions in the running application. The tooltip overlapping “What matters” in the tablet captures appears to be a hover capture state; no persistent obstruction is inferred from these stills.

Screenshots do not certify keyboard behavior, accessibility/WCAG compliance, data correctness, installation, notifications, physical hardware or full Studio 11.6 functionality. This review makes no functional task approval.

## Additional immutable phone reader state

Reviewed 2026-10-01 with the same neutral job and constraints, without implementation, PR history or author rationale.

- Image: `/tmp/flux136-peer-final/136-state-material-reader-downgrade-390.png`
- Supplied viewport/runtime: 390 × 844, 100% zoom, Chromium emulation.
- SHA-256: `9907d2e6808a95e8e2dfb8032a51f6db825e1284d38de69c0f8c94c717c02262`.

**No additional material hierarchy or readability finding.** The project name, named two-person audience and Details remain legible on one compact header group. The active Conversation tab, “Project conversations” title and “No conversations yet” state establish location clearly. The main prose explicitly describes read access and the saved tasks/maps/docs/sources available to browse. The bottom surface repeats the audience and plainly states “Read-only”; there is no visible send action. Text wraps within the phone width without clipping. Preserve the direct permission explanation and this compact navigation/header arrangement.

The screenshot shows the conversation empty state and a document-icon affordance at the bottom, rather than an open saved-source list or source contents. The icon's accessible name, available touch area and actual source-opening behavior require live verification. The visible green outline does not establish keyboard semantics or WCAG compliance. The image cannot prove a permission downgrade took effect, writes are rejected, source state survives a role change, or saved sources are actually readable. No new functional approval is made.

## Current integration captures — project, reader and mixed-author history

Reviewed 2026-10-01. Neutral job: readers need to identify the project and audience, read saved human and agent history, and use available Sources/Details with compact, usable controls. Fresh visual evidence assessment without implementation, revision/PR history or author rationale. All captures supplied as 100% zoom, Chromium emulation. Evidence is tied to these exact immutable image hashes; no source commit was supplied to this reviewer.

| Image | Supplied viewport | SHA-256 |
| --- | --- | --- |
| `/tmp/flux136-merged-current/136-state-reader-1280-light.png` | 1280 × 800 | `f369faeac5e4e3a2da11774af034edf3d7ea6d279afd7296f7ac92b90c2b66c7` |
| `/tmp/flux136-merged-current/136-state-reader-saved-conversation-390.png` | 390 × 844 | `74b1b20bbbfd6df93df84f0a2226eea1507bda6f2f695754f3679a8910b9ab42` |
| `/tmp/flux136-merged-current/136-state-long-title-122-1280.png` | 1280 × 1180 | `58f92d194ce4434af718cbfab5381c5a65054d1b606724fd4967258d582b3292` |
| `/tmp/flux136-merged-actors/mixed-authors-reader-390.png` | 390 × 844 | `df7947952765434b67c4845c584d1957dc94a506be7716786460c3c261d56ffc` |

**Header and reader/history assessment:** no new material hierarchy or readability finding. The desktop long title remains bounded and the named audience/Details are legible beside it. Both phone captures preserve compact project identity, a wrapped audience and visible Details without obscuring the work tabs. The reader footer now directly states read access to the project, which remains understandable in the narrow layout. The single-message history is readable with author/time and its local Details affordance. In the mixed-author history, “Trial analyst · agent” visibly distinguishes the agent from “Casey Human”; separate avatars, times and message bubbles make order and authorship readable. The agent message's two-line wrap and the human reply's two-line wrap remain comfortably contained at 390px.

**One material visual finding remains in the current captures:** the 1280 × 1180 long-title empty-conversation view still places the invitation near y200–305 and the composer near y1115, with approximately 800px of blank space between them. This is the same tall empty-state composition problem documented above, now evidenced at desktop width; no additional issue is being counted. Keep the introduction and first-input surface visually connected on tall empty layouts while retaining compact navigation and readable audience.

Preserve the bounded project header, clearly named audience, explicit read-only statement, restrained active-tab underline, neutral message surfaces and explicit agent designation. The mixture of authors is readable without relying only on avatar color.

**Evidence limits:** the Sources control is visibly labeled on desktop and appears as a document icon on phone; these stills do not establish the phone icon's accessible name, activation or hit area. No open Details or Sources view is shown, so full-name disclosure, available source contents and source navigation remain unverified. Historical author identity does not establish current authority or audience membership. No permission enforcement, keyboard/screen-reader behavior, focus semantics, responsive transition, real hardware/scaling or full Studio 11.6 integration is certified. The two short histories do not establish readability of dense or long-form history. No code edits, GitHub messages or functional task approval were performed.
