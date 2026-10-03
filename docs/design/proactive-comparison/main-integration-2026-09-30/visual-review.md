# Flux comparison outcomes and personal usage — independent appearance review

Reviewed 2026-09-30 using `.agents/skills/flux-review-visual/SKILL.md`, the full product foundation, product README and current normative design guidance in `docs/design/README.md`, `direction.md`, `studio-v11-refinement.md`, and the Studio v11 reference README. No application implementation, Git history, PR/issues, previous task-review files or author rationale were inspected. No application edits or GitHub posts were made.

## Scope and provenance

The neutral brief concerns Jo and Kai building a bedside gesture lamp. Ordinary human work must stay clear beside optional quiet camera/ToF suggestions. Readers need distinct fact, interpretation and proposed work; cited/checked sources with version, excerpt and unavailable cues. Jo needs understandable personal local usage, uncertain/observed amounts, recognizable past requests and a path to the triggering context. Another participant should see their own empty history. Preserve compact, calm Studio v11 character.

I inspected **all 21 immutable original PNGs individually at original resolution**, including their whole frames, through `view_image`. The directory contains 11 comparison-outcome frames and 10 personal-usage frames. All three requested original reference PNGs were also opened individually; no thumbnail/contact-sheet substitute was used. SHA-256 and image dimensions below are measured from the original files.

Capture provenance supplied by the producer: base `1ea1c6c121c66eb30149404b3ab916d9eb378686` plus the history UI working tree; those exact production UI sources were subsequently committed in `19d233bc41d784f19d2f01391fb65fc9a8dc72c7`. The producer states later edits affect tests/documentation only. These statements were not independently checked against source or Git history. This review is tied to the hashed captures and that supplied production-UI provenance; **it is not a clean full-head screenshot certification for 19d233b or any later head**.

Producer-declared capture conditions: desktop 1440×900; independent phone/touch 390×844 and tablet/touch 1024×768; DPR 1; 100% browser zoom. `comparison-outcomes-1440-text125.png` uses 125% text size, not browser zoom. Dimensions agree with those frame sizes. Image inspection cannot independently establish device mode, zoom or text-size settings. Several checked/footer/history frames are intentionally scrolled; their clipped upper/lower content is a viewport boundary, not evidence of an overflow defect.

This is appearance-only evidence. It does not approve behavior, privacy, accounting, accessibility, installation/device support, an entire functional task or release.

## Result

**One material visible finding remains: past requests are technically distinct, but difficult to recognize by their triggering work.** The supplied frames otherwise preserve compact readable work surfaces and show clear comparison/source and usage-status grouping. This statement is limited to the visible states listed below, not an application acceptance pass.

### Finding 1 — history emphasizes opaque IDs rather than recognizable work context

- **Location/evidence:** `comparison-usage-1024-history.png` and `comparison-usage-390-history.png`, with the same pattern in `comparison-usage-1440-history.png` and the owner frames. In the tablet/phone history, adjacent older requests repeat “Completed,” “Aug 30, 06:13 UTC,” “$0.05 earlier reservation · usage not recorded,” and “Attempt time was not recorded.” Their distinguishing text is “Request 7ce7e383,” “Request 0472d26e,” “Request c2b3d9cc,” and similar IDs. The two newer completed entries also share time, observed amount and token counts; one has an insufficient-evidence sentence while the other has no human-readable work description.
- **Visible symptom:** each row has a clean separator and a “View result” link, but no short title naming the comparison, project or triggering result. The stable ID gives a precise technical identity without helping the reader recognize which lamp experiment they remember.
- **Consequence:** Jo must retain or compare arbitrary IDs, or open several result links, to find the past request associated with a particular piece of work. That is avoidable recognition effort in a history intended to restore context.
- **Direction:** keep the ID, clear status/amount wording and nearby result route. Add a short human-readable triggering-context title or descriptor, where access permits, as the primary identifying text; keep the ID as secondary metadata. When context cannot be disclosed, use an explicit unavailable-context cue. Avoid adding large cards or exposing inaccessible titles. This is a hierarchy/recognition finding, not a claim about whether the existing link reaches the right context.

## Elements to preserve

- **Ordinary work remains present.** The desktop collapsed task frame shows both quiet suggestions, the open work item and all four result titles in one viewport. Tablet/phone keep the same tabs and local actions. The phone shows the open work item before the results continue below the fold. The agent has a small in-place role rather than a competing dashboard or hero.
- **Explicit comparison semantics.** “Observed fact,” “Interpretation” and “Suggested next step” are easy to distinguish through text labels and placement. On phone the fields stack in reading order without visible overlap. “Use as work” is visibly distinct from inspecting or dismissing an outcome; “Insufficient evidence” stays an understandable separate result.
- **Source distinctions are unusually clear.** “Sources cited” and “Checked sources 5” have separate hierarchy. Checked version numbers, the excerpt/full-source-size cue, an unavailable-source count and the current-content versus checked-version explanation are visible in the supplied checked/footer frames. Keep these explicit labels and the grouped source disclosure. On phone the longer source titles wrap; their version text remains present.
- **Usage semantics and empty history.** The simple rows separate attempts, rolling counted allowance, observed estimate, unknown possible amount and reservation. The overlap/non-invoice explanation is visible, as are “Did not run,” “Charge uncertain,” insufficient evidence and older unrecorded-usage states. The other participant’s phone frame visibly has zero requests and “No background requests have been recorded for you”; that is useful truthful empty-state wording, not proof of access enforcement.
- **Calm scale.** Small working-view headings, thin separators, restrained panels and ordinary text keep the supplied light and dark desktop frames coherent. The 125% text frame wraps longer content while retaining its visible grouping. Preserve that organization rather than globally shrinking text.

## Original-reference comparison evidence

The original Studio v11 conversation frame contributes the compact place/audience/goal line, stable work tabs, quiet neutral surfaces, recognizable authors and source-linked work within an ordinary conversation. The reviewed Flux frames retain a compact title/navigation hierarchy and the same low-drama relationship between human work and optional agent material, though the reference is not a template for the task-list layout.

The two original deep-map frames were inspected as whole images. They demonstrate the restrained dark surface and readable work text, while also showing the long-row action distance and deep phone indentation that the current normative refinement document explicitly asks to improve. Those weak points are not treated as requirements to reproduce. None of the 21 current frames shows a map, so this review cannot judge current graph/list hierarchy or relation presentation.

## State coverage and visible limits

| Capture group | Visible observations |
| --- | --- |
| Outcome collapsed: 1440 / 1024 / 390 | Suggestions sit above ordinary work/results; local Review/Inspect routes and work filtering remain visible. Phone titles wrap within the frame. |
| Outcome checked: 1440 / 1024 / 390 | Epistemic fields, cited and checked groups visible; phone stacks fields, with long source/version links wrapping. Scrolled tablet/phone frames intentionally begin within the expanded detail. |
| Outcome insufficient footer: 1440 / 1024 / 390 | Checked source footer, unavailable/excerpt/version explanations and Dismiss action are visible; ordinary work follows below. The desktop frame also shows the long repeated-body stress content above the footer. |
| Outcome dark: 1440 | Expanded comparison/source content retains visible hierarchy on neutral dark surfaces. This is a visual observation, not measured contrast compliance. |
| Outcome text125: 1440 | Enlarged text wraps fact/interpretation labels and links; no visible overlap in the captured area. Footer actions and the next outcome fall below this frame. |
| Usage summary: 1440 / 1024 / 390 | Connection/allowance block precedes local usage. The desktop frame reaches the Recent requests heading; tablet reaches the reservation row; phone reaches the first usage metric. No additional screenshot covers phone enlarged text or usage dark mode. |
| Usage owner: 1440 / 1024 / 390 | Totals/explanations lead into status-separated recent requests. IDs and View result links are visible; recognizable context titles are absent. |
| Usage history: 1440 / 1024 / 390 | Multiple repeated completed requests and older unrecorded usage are visible. Dates, IDs and result links remain within frame; finding 1 concerns recognition rather than clipping. |
| Usage other participant: 390 | Own zero totals, empty history and project-rule setup visible. No owner request row is visible in this frame. |

## Gaps and questions for separate live checks

- Follow “View result” for current, older, uncertain, failed and insufficient-evidence requests. Confirm the exact triggering context/destination, an understandable return route and behavior when that context becomes unavailable. A visible link alone cannot establish any of those behaviors.
- Confirm actual request identity, ordering, dates, local-usage calculations, reservation transitions and estimate uncertainty. The identical stress-fixture timestamps and displayed amounts are not accounting evidence.
- Check that another participant cannot receive the owner’s connection, request metadata or history through UI/API paths. The supplied empty frame shows only one visual state.
- Exercise source opening/version/excerpt semantics and revoked/unavailable cases. The screenshot labels cannot establish what data was inspected or what version is actually opened.
- Verify keyboard/focus, touch actions, independent scrolling, responsive transitions, text enlargement across phone/tablet and long names/content. No DOM measurements, screen reader, contrast-compliance or hardware checks were performed here.
- Add live-state evidence for loading/refresh failure, history-empty owner, unavailable result destinations and changing permissions. Usage dark/enlarged-text frames and full phone comparison-body/top-of-detail states are absent from this supplied set. Installation and OS notifications require separate actual device evidence.

## Original capture inventory

All paths in this table are relative to `/tmp/flux58-history-context-screens/`; each image was inspected individually. Hashes identify the immutable originals, not derived previews.

| Original PNG | Dimensions | SHA-256 |
| --- | --- | --- |
| `comparison-outcomes-1024-checked.png` | 1024×768 | `be7f67f23812af5c6b30705f4334d9c0c614ba4e1ed5cb995546034fba6643ca` |
| `comparison-outcomes-1024-collapsed.png` | 1024×768 | `0afb31fee902897ca1206f49c71ad7a2fe847e95e95bb4a6a672af47b02e7099` |
| `comparison-outcomes-1024-insufficient-footer.png` | 1024×768 | `e29862069012565e5d339fa49c37251bf9c6c3041cdc3e62623610e3a03bf761` |
| `comparison-outcomes-1440-checked.png` | 1440×900 | `45e3893f9b6376faca5a6f3e1742e02742221049ab3f718620821eb311369304` |
| `comparison-outcomes-1440-collapsed.png` | 1440×900 | `f4eb7897ce793dd5059bf1e27aaeaf480ae4209314e4427d6cdc34c3fbff60c7` |
| `comparison-outcomes-1440-dark.png` | 1440×900 | `a6dc914e5c058b1214ea106f65c3c067e81a8e23c53dc838c9d62627541e939f` |
| `comparison-outcomes-1440-insufficient-footer.png` | 1440×900 | `0a9b304be09468edec7de0a52323d3b25e09a1a22ae54c812819c4ad55dbeb79` |
| `comparison-outcomes-1440-text125.png` | 1440×900 | `4a13f7e92f3c6b0398d68daa9d0f77b8087f407b4581b2740adebc02b3caec57` |
| `comparison-outcomes-390-checked.png` | 390×844 | `aee8d6fe9e2dfa4848a6c664a79719c2db7a7954dd9b4acbab303fb7d5b9407e` |
| `comparison-outcomes-390-collapsed.png` | 390×844 | `2a0df0b216df125fa2aa2fb8b782e4e245d3c208dc159531fbc24d9b33d4ed92` |
| `comparison-outcomes-390-insufficient-footer.png` | 390×844 | `0b031c2a43b787213954908b71eacb00bbfa7838962b16ffab9eaeff106dbeac` |
| `comparison-usage-1024-history.png` | 1024×768 | `430a3bf42bd1acc3b1bf1efdd27f803f3853fbbbdace7706efddbdee737b7f93` |
| `comparison-usage-1024-owner.png` | 1024×768 | `293f8b04dc29786caa62d60c0994da54e71245aa0f1df04b5a1d960d3a51ae08` |
| `comparison-usage-1024-summary.png` | 1024×768 | `f45a78921cebf3911966c0648667d89a6450f7d675a990c8b843f9fbe76eed73` |
| `comparison-usage-1440-history.png` | 1440×900 | `b6e1e2cfe2f166a5b8f92929eb81d5193987a68f4f60a90bf042f3564e80ef1f` |
| `comparison-usage-1440-owner.png` | 1440×900 | `5f808ff9dfbfde88b64aa309d50914ce2adda6187635acd05ec121978921ef90` |
| `comparison-usage-1440-summary.png` | 1440×900 | `49074f996ecd564681ab029e95d92ba6cdcd0b7c3d4d41050887f4edab8c93c1` |
| `comparison-usage-390-history.png` | 390×844 | `d4ad570bf6b7d6d7dfad7b3089620253384b9ce8e34144ca4edf63ac014b2156` |
| `comparison-usage-390-owner.png` | 390×844 | `7225d6486c0545166dd9440b8d399799b0f9701715fe563d2098f6e60b1aa8ce` |
| `comparison-usage-390-summary.png` | 390×844 | `befd857a8ac574969e8303720214ae99ed19d4fc02380534b462037a31476b0e` |
| `comparison-usage-390-viewer.png` | 390×844 | `e930fe9d1b299d03d363faf3f2127d9a8836958f674b04847a63554d89639c66` |

## Original reference inventory

These original files were opened individually at original resolution. Paths are relative to `/home/hubert/Develop/flux/docs/design/references/studio-v11/inspection/`.

| Original reference PNG | Dimensions | SHA-256 |
| --- | --- | --- |
| `conversation-1440-light-mint.png` | 1440×900 | `4b7fb875c2fd8b42ed36367de92805db9b273a257c8f8ad4388f2584db525799` |
| `map-deep-after-1440.png` | 1440×900 | `b0498bd96abe55b407adbe8783acb825174b9a35d9e9ce3b543380a9762eefd7` |
| `map-deep-after-390.png` | 390×844 | `b56d75253b8cb9936f689ed6f3d99e0abe3edee6293c920b9f199fe4670f04c7` |
