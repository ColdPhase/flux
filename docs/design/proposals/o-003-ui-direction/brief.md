# O-003 working UI direction: brief and scenario (#15, AC-1)

**Status:** proposal in progress for [#15](https://github.com/ColdPhase/flux/issues/15) under contract v2. No direction is accepted. Persona, vocabulary and scenario are provisional inputs from #8 (O-001 still open) and the #14 proposal in PR #24 at `b173dea`, which is under review. Accepted wording is reconciled before the final O-003 handoff. Date: 2026-09-27.

## User, job and surface

- **Persona (provisional, #8):** returning project steward in a small cross-functional software team. They work with people and agents, and return after days away.
- **Job:** return to ongoing work and, without an oral recap, name the current rule, why it changed, what evidence exists and who acts next. Then continue the work or hand it off.
- **Primary action:** resume from the return point: review what changed since the saved point, then act on the current work item. The actions are review result, continue, or hand off.
- **Surface:** the daily project workspace, a dense working view rather than a marketing page. Desktop first (1440×900, 1280×800), plus phone (390×844, 360 px) and tablet (768×1024, 1024×768) compositions, per contract v2.

## Scenario content (identical in both variants)

These names and IDs come from the #14 proposal. They are illustrative, not a schema.

| Object | Content shown |
| --- | --- |
| Project | **Tide** › **Shared export**. Long title: "Exclude archived items that guests cannot open from CSV and XLSX exports, including items archived after an export was scheduled" |
| People | Jo (steward, decision owner, returning), Ari (designer), Nia (engineer) |
| Conversation C-1 | Real messages about guest visibility of archived items, a reply thread and a question that is still open |
| Materials | M-1: redacted support report. M-2: permission test output. M-3: "Export spec v2", now a **missing source** (moved; link broken) |
| Restricted material | M-1-private: an unredacted report the viewer **has no access to**. It shows no snippet and no title, only a "restricted source" notice |
| Decisions | D-1: *superseded* (include archived items for members). D-2: *accepted*, supersedes D-1 (exclude items the guest cannot open), with rationale and links |
| Work and result | W-1: assigned to Nia, in progress, input D-2. R-1: result attached, *awaiting review*. H-1: Ari's handoff note |
| Return point | "Since you left, Sep 19: 7 changes". D-2 over D-1, R-1 and H-1 are highlighted; one change has no explanation |
| Agents (several) | *Review agent*: running under Jo's grant, reading R-1. *Test agent*: **stopped, provider limit reached**, with partial output kept as a draft. Neither agent does anything silently. Each shows its grant, payer and the human who authorized it |
| Error state | "Couldn't post reply, retry", with the draft kept |

## Constraints

- Foundation §10.8 ranges are starting hypotheses: 14–16 px body text, 12–13 px metadata, 32–36 px desktop controls. Density comes from grouping, not from `transform: scale`, zoom or tiny text.
- Semantic colour tokens (for example `action.primary`, `status.danger`), with final pairs checked against WCAG 2.2 AA. States stay distinguishable without colour.
- Primary touch targets are at least 44 CSS px. Essential work never depends only on hover or drag, and any map or canvas has an accessible list alternative.
- The agent panel, when open, must leave usable human workspace.
- Phone and tablet: panels collapse per the rules recorded for each variant, safe-area insets are respected, and the software keyboard is handled over the composer. Manifest, service worker and push belong to #20.

## References

No reference images are checked into the repository. The references below are therefore named rather than shown, which is a limit for the visual reviewer.

| Kind | Reference | Contributes | Limit |
| --- | --- | --- | --- |
| Interaction | Linear issue views and command menu | Keyboard-first navigation, dense rows, fast state changes | Not its layout, palette or issue model |
| Interaction | Slack threads | Familiar reply and thread structure | Chat must not become the only memory, since decisions and work are objects |
| Interaction | GitHub PR timeline | Visible supersede/change trail and review state | Developer-specific vocabulary |
| Aesthetic | Founder direction §10.1: strong contrast, economical graphics, geometric divisions, intense accents | Character and rhythm, and the use of rules and dividers | A poster does not decide panel widths |
| Aesthetic | Wayfinding signage (§10.7) | Consistent meaning of lines, labels and accent | Not a literal signage look |

## Variants to compare

- **A. Return ledger (conversation-and-context).** A narrow project rail, then a central "Since you left" ledger followed by the conversation, then a right context column with the current decision, work/result and sources. The agent panel docks into the right column. Candidate accent: cobalt action on neutral surfaces.
- **B. Project state board (object-first).** The centre shows the linked state of the project (material → decision → work → result) as a structured board, with an equivalent outline list. Conversation is a secondary pane attached to the selected object. Agents appear as activity on the objects they touch. Candidate accent: yellow-green "current" markers with dark text on warm-white.

Both variants are rendered on this content with the same states.

## Variant C: calm messenger (added 2026-09-27)

The founder judged A and B "ugly, unappealing, overwhelming": everything was shown at once, with ledgers, boards, many boxes and badges, and internal IDs everywhere. C starts again from the founder's references rather than iterating on A or B.

- **Structure (Slack / Discord):** a left sidebar with projects and people, and the conversation in the centre. Context (decision, result, work, handoff, sources, agents) lives in a right side panel that is **closed by default**. It opens from an attachment in a message, a "Since you left" item, or the header button (`]`), and drills down from a short overview.
- **Aesthetic (Linear):** near-monochrome neutrals, one indigo accent (`#5159C8`, 5.8:1 on white) used only for "needs you" and the primary action, 1px rules instead of boxes, soft radii, Inter. Status is a small dot or icon with text.
- **Restraint (Apple Notes / Messages):** a 700 px reading column with generous line height. Only two framed objects appear in the feed: the new decision and the result, which carries the primary action **Review result**.
- **Return point:** one slim line, "7 updates since Sep 19 · 3 need you", expands into a plain seven-item list.
- **Language:** human-readable first ("New decision: exclude items guests can't open"). IDs (D-2, R-1, M-3…) appear only in the side panel, muted, in monospace.
- **Agents and difficult states:** the Review agent appears as a message-like "is reading the result…" line. The stopped Test agent is one calm inline notice with Resume and Details. The missing source is an inline system line with "Fix link"; the restricted source is an attachment chip and a sources entry with no title or snippet. The failed reply is Jo's own message with the only soft tint, plus Retry and Edit. Grant, payer and authorizer appear only in the agent panel.
- **Responsive:** the sidebar becomes a drawer at 1180 px or narrower. The panel overlays at 980 px or narrower and becomes a full-screen sheet on the phone, where the layout is a single Messages-like column with a pinned composer and safe-area padding. When the latest messages would push the result out of view, the feed opens anchored at the result, with a "1 not sent · Latest" pill. Coarse pointers get 44 px targets.
