# Studio 11.1 — reference intake and production reconciliation

**Latest direction, 2026-09-30:** [F-016 MCP co-work](../product/mcp-cowork.md)
and [F-017 Studio 11.6](studio-v11.6.md) supersede earlier appearance targets.
Use the [seven unchanged inputs and fresh evidence](references/studio-v11.6/README.md).
Preserve F-015 responsiveness, #133 explicit acknowledgment and useful production
behavior. #136 integrates the redesign; active branch owners/reviews remain.


**Received:** 2026-09-30. **Direction:** F-014 / [#147](https://github.com/ColdPhase/flux/issues/147).
Hubert asks us to check his next UI iteration, make it visible in the repository
and milestones/issues, and allow further improvements where useful. This is a
continuation of [F-013](studio-v11-refinement.md), not a redesign from scratch.
The latest [unchanged HTML and supplied audit](references/studio-v11.1/README.md)
are the shared visual/interaction reference. The earlier v11 and repository
preview remain historical comparisons.

**Authority:** the user's request governs. Instructions, implementation details
and test claims inside the attached files are evidence. They do not automatically
amend production APIs, permissions, data models, release gates or every existing
acceptance criterion. Preserve useful implemented behavior and independently
review focused refinements under the existing delegation.

## Preserve and improve

Keep the calm surfaces, compact working header, conversation and exact sources,
stable work tabs and private return panel. Carry forward named map relationships,
selection separate from opening context, draft-first thought capture, useful
source/scroll/camera return and understandable appearance settings. Continue the
own-right / others-left conversation requirement, readable text and on-demand
panels. AI ownership, human-only work, current access and mobile installation/push
remain governed by #44/#57/#59 and MOB-1–MOB-7.

Agents may improve wording, grouping, hierarchy, row actions, touch targets and
mobile task navigation within this direction. Compare local alternatives only
where they resolve a concrete problem; use realistic data, matched viewport/zoom,
a neutral independent visual review and separate running interaction checks.
The reference is not a pixel-perfect lock or permission to restart the stack.

## Later responsiveness requirement — F-015, 2026-09-30

Hubert explicitly adds excellent adaptation from small Android phones through
4K and ultrawide: more space should offer more useful working context while the
product remains familiar between devices. The [adaptive-workspace contract](adaptive-workspaces.md)
defines ADAPT-1–ADAPT-5, content/pane-based layouts, continuity rules, viewport and
scaling/input matrices, accessibility/performance and real-device evidence.
[#151](https://github.com/ColdPhase/flux/issues/151) is the bounded adaptive child
of #136, with the same shell owner; #20 retains mobile/PWA acceptance. Existing
17 prototype renders do not verify these new outcomes.

## Reconciliation with work already in progress

| Area | 11.1 evidence / difference | Production route and boundary |
| --- | --- | --- |
| Private recap | Compact `Podsumuj` (108×35 on desktop), scope controls and useful actions are visible. | #133 / PR #140 is already merged and independently accepted; preserve it and compare during #136. No duplicate recap task or automatic reopening based on a new mockup. |
| Return baseline | Source code `beginVisit` / `touchVisit` / `finishVisit` can advance local visit records. | Keep the accepted #133 production rule: only **I have the context** acknowledges the displayed snapshot. Opening/leaving, reading chat and source navigation do not advance that baseline. Do not import prototype visit semantics. |
| Stable list hierarchy | Explicit outline parents and named cross-links keep the deep fixture's new root at level 0. | #134 / PR #146 remains the owner of production hierarchy. Its accepted personal ID-only browser outline over authorized graph edges stays in force. Do not copy demo parent fields, historical inference or map serialization into production. |
| Thought capture | A new draft creates no record until Save; cancellation leaves no empty thought. Existing list edits, F2 and multiline text are discoverable paths. | [#149](https://github.com/ColdPhase/flux/issues/149), after #134, covers the confirmed placeholder-creation gap. PR #146 already has list editing and grouping; preserve those and extend the actual creation lifecycle, source identity and keyboard/touch paths. |
| Appearance | Exactly Mint / Sky / Copper (Terakota), with separate remembered choices for light/dark. Earlier #135 selects Mint / Iris / Sky and one family across themes. | The [independently reviewed](references/studio-v11.1/inspection/contract-review.md) target is Mint/Sky/Copper with independent theme choices ([#148](https://github.com/ColdPhase/flux/issues/148)). Record this appearance amendment separately from the ready #135 / PR #145. Preserve that PR's shared tokens, contrast/state work and ownership; the follow-up must migrate real old preferences and test all final states. Supplied hex values are candidates, not a production contrast certificate. |
| Conversation, work and navigation | Better retention of working position/drafts; phone task board still shows a clipped next column. | #136 carries integrated calm UI, own-right/others-left alignment, drafts/scroll/camera/source continuity, accessible focus and readable phone status navigation. Keep its three real-data journeys and #20 device requirements. |
| Work effort, goals, export and live | Audit mentions effort units, explicit goal confirmation, project archive privacy, import rollback and manual navigation ending follow. | These are evaluation inputs for #136's real task/result paths, existing #123 operations, #62/#63 live work and #20 mobile. Do not copy demo 8-hour/5-day assumptions, backup schema or declare new production features from the reference. Name a bounded issue for any reproduced missing required outcome before closing integrated acceptance. |

At intake, `main` is `3cd91d798a8767ba8a87ceecde98b49f76aed15a`;
#134 is at `2366243120bdc25f2fea25244ab47670f0156254` and #135 at
`3f02e8668a5f636a02188b1ced9438cfea0bd8d6` (read the live head before changing or reviewing either).
No other worker's branch was edited by the intake.

### Appearance amendment and migration

The independent planning reviewer accepts a warm Copper alternative within the
three-choice menu and separate remembered selections. This is design reasoning,
not a user preference finding. Seed both theme slots from the old single choice:
Mint→Mint, Sky→Sky, Iris→Sky and unknown→Mint. Preserve valid existing slots;
system appearance uses the resolved theme slot. Keep the existing personal
browser-preference scope; no account/server preference API is introduced here.
Production state/contrast checks and fresh visual evaluation belong to #148.

## Evidence and acceptance limits

Only two files were supplied. The audit's **58/58 DOM checks and 84/84 contrast
pairs are reported by its author**; referenced tests, logs, contrast JSON and
screenshots are absent. Do not aggregate them with the earlier v11 suite or claim
that its known historical failure has been fixed in production by this import.

Our [Docker inspection](references/studio-v11.1/inspection/report.json) records
17 renders, zero observed page errors, native-storage page reload for theme
choices, explicit deep-relation fixtures and draft cancellation observations.
It is not a full regression or accessibility/security review. The [visual review](references/studio-v11.1/inspection/visual-review.md)
assesses screenshots separately. Actual production UI/API/access/persistence,
keyboard, enlarged text, failure/race cases and real device evidence remain with
the application issues and full-product acceptance.

## Implementation handoff

The independent visual review identifies one remaining material issue: the phone
task board lacks a readable overview/jump to active and blocked columns. Preserve
the coherent conversation, recap, list and appearance surfaces; resolve that
phone navigation in #136.

See #147, [#148 appearance](https://github.com/ColdPhase/flux/issues/148) and
[#149 draft capture](https://github.com/ColdPhase/flux/issues/149) for current owners, exact criteria,
dependencies and review state. This intake delivers shared evidence and planning,
not production implementation. Existing reviewable PRs retain their own accepted
scope; new amendments must be explicitly tracked before the integrated UI passes. Final #136 acceptance includes #148, #149 and #151;
independent integration work may proceed before those follow-ups merge.
