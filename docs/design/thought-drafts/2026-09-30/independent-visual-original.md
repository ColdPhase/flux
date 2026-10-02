# Independent visual review — Flux thought capture and inline edit

Date: 2026-09-30. Reviewer: independent visual reviewer `/root/visual_149`.

Reviewed source revision: `0739dc1968f3e7fff6f91bee7bdbd3351a43c267`, resolved read-only from `/home/hubert/Develop/flux/.worktrees/149-thought-drafts`.

**Verdict: one focused visual correction requested.** The draft and normal edit screens support the supplied brief across the reviewed themes and sizes. The two desktop recovery screens truncate the next-step message; resolve that finding before treating this screenshot set as visually accepted. This verdict covers visible presentation only and is not GitHub approval or functional acceptance.

## Brief and review boundaries

Neutral brief: private new-thought capture and existing inline edit on a compact knowledge map/list; clear intended parent/context, readable multiline text, visible Save/Cancel suitable for touch, useful density, and identifiable error/conflict state without hiding recoverable text.

All 20 requested PNGs in `/tmp/flux149-capture-verified-current` were opened and inspected. The supplied viewports are desktop 1440×900, phone 390×844, and tablet 820×1180, at browser zoom 100%. Both light and dark use the current Mint family; themes were described as following OS preference. Capture was described as coming from nine passing focused browser tests. I did not run or independently verify those tests, and their reported result did not determine this visual verdict.

The review used the neutral brief, screenshots and current visual contracts. I did not inspect implementation code, revision history or author rationale, and made no repository or GitHub edits.

Guidance read: `flux-review-visual/SKILL.md`, the complete foundation, product README, design README, current direction, Studio v11 refinement contract, and reference package index. Images inspected for reference: `supplied/screenshots/05-mapa-lista.png` for compact map-list grouping, and `inspection/conversation-1440-light-mint.png` / `inspection/conversation-1440-dark-mint.png` for the restrained Mint theme treatment. The supplied map-list reference is 1440×960; it informs character and grouping, not a matched before/after comparison.

## Material finding

1. **Recovery instructions are clipped in the desktop toolbar.** Location: `thought-edit-conflict-desktop.png` and `thought-edit-failure-desktop.png`, right side of the toolbar at roughly x1010–1380, y180. The conflict status ends visibly at “Your edit is kept; c…” and the failure status at “Your text is kept; check acc…”. Both states identify the problem and leave the edited text visible, but the recovery instruction disappears in the remaining width after seven actions. The user is left to infer whether to retry, check access, cancel, or resolve the newer version. Let the complete error/conflict message wrap in a row near Save/Cancel or the editor, while keeping ordinary selection/status text compact. This is an observable readability and recovery problem, not a preference for a different aesthetic.

No second or third material visual issue identified in the supplied scope.

## Useful elements to preserve

- New capture states name the connected thought in full and state “private until saved” immediately above the editor. The sketch/project audience remains visible, so the temporary private draft and eventual shared context can be understood together.
- Two lines of draft text remain readable in both themes and on the phone. The mint focus treatment and content-sized Save action give the editor a clear working emphasis without a large saturated panel.
- Save/Cancel remain fully visible beside each other in every normal draft/edit screenshot. Phone/tablet edit buttons have visibly generous vertical space, and the draft controls sit directly below the text. Actual touch hit areas require live verification.
- Inline editing preserves surrounding author and relation context. The selected row has a restrained theme-aware surface; named, underlined related-thought links remain easy to distinguish from ordinary text.
- The normal desktop draft occupies about 166 px vertically, leaving both existing thoughts visible. Tablet retains both thoughts and their relations; phone capture shows the first context thought below the editor and requires scrolling for more. The phone is dense above the draft, but the supplied text and controls stay readable and do not overlap. The repeated keyboard helper is a minor density opportunity, not an additional blocking finding.
- Conflict and failure screenshots keep recoverable edit text visible. The conflict screenshot also demonstrates two visible lines of retained content; the orange status uses words to identify the state.

## Missing states and live questions

The provided set does not show phone/tablet error or conflict, draft save failure, virtual keyboard open, enlarged text, very long drafts, an unlinked/root capture, restricted access, an open details/assistant panel, or ordinary inline edit in Map view. These remain outside the visual verdict. In the running application, separately verify keyboard/IME and Enter behavior, focus order, touch targets, keyboard-open reachability of Save/Cancel, draft recovery and cancel semantics, persisted API behavior and concurrency, access/privacy enforcement, and measured contrast/accessibility. Screenshots establish none of these behaviors.

## Reviewed screenshot inventory

All entries below are in `/tmp/flux149-capture-verified-current`; both names in each row were inspected.

| Viewport | State | Light | Dark |
| --- | --- | --- | --- |
| 1440×900 | Draft, List | `thought-draft-light-desktop-list.png` | `thought-draft-dark-desktop-list.png` |
| 1440×900 | Draft, Map | `thought-draft-light-desktop-map.png` | `thought-draft-dark-desktop-map.png` |
| 1440×900 | Edit, List | `thought-edit-light-desktop-list.png` | `thought-edit-dark-desktop-list.png` |
| 390×844 | Draft, List | `thought-draft-light-phone-list.png` | `thought-draft-dark-phone-list.png` |
| 390×844 | Draft, Map | `thought-draft-light-phone-map.png` | `thought-draft-dark-phone-map.png` |
| 390×844 | Edit, List | `thought-edit-light-phone-list.png` | `thought-edit-dark-phone-list.png` |
| 820×1180 | Draft, List | `thought-draft-light-tablet-list.png` | `thought-draft-dark-tablet-list.png` |
| 820×1180 | Draft, Map | `thought-draft-light-tablet-map.png` | `thought-draft-dark-tablet-map.png` |
| 820×1180 | Edit, List | `thought-edit-light-tablet-list.png` | `thought-edit-dark-tablet-list.png` |
| 1440×900 | Edit conflict, light | `thought-edit-conflict-desktop.png` | — |
| 1440×900 | Edit save failure, light | `thought-edit-failure-desktop.png` | — |


## Image identity at review

| PNG | Actual pixel dimensions | SHA-256 |
| --- | --- | --- |
| `thought-draft-dark-desktop-list.png` | 1440×900 | `9976d076d70041375dc90db4ee144e8eec8c042a24a1471bfa569413255d17b6` |
| `thought-draft-dark-desktop-map.png` | 1440×900 | `45a464d1a4ec5be0769e05a03e5f8f7af403a7f10c314244b9d286d4e1739d4e` |
| `thought-draft-dark-phone-list.png` | 390×844 | `e28cbaf00f63ab7d571d7d5080e0706204feab5cb8ce0b01f73d8d918e2fdc84` |
| `thought-draft-dark-phone-map.png` | 390×844 | `a557bd14d5311d658c81cd31343a51dc4bbb837f67e7d146fd9b53d05c59ed4f` |
| `thought-draft-dark-tablet-list.png` | 820×1180 | `488bac0210efdc6e65ad972d8d5b4973809f83d2ab6d5823bb4e53d22b870682` |
| `thought-draft-dark-tablet-map.png` | 820×1180 | `a778b01b71338164575995b9e8434b9f8bca0ed259ef3783cc03c77df98ba4a7` |
| `thought-draft-light-desktop-list.png` | 1440×900 | `c7ebd4ea84329a01266439ebedc2cb7962e4b286f00b0b70c3184b16faeba297` |
| `thought-draft-light-desktop-map.png` | 1440×900 | `db0dc5a5835477e6425233b3aacc1c08323201c48feb62c7c2329e7e9ea531aa` |
| `thought-draft-light-phone-list.png` | 390×844 | `df48bd62b36e230d32df316b88f5fcacb82431bcacfdcda5380a1624da2b827b` |
| `thought-draft-light-phone-map.png` | 390×844 | `df7578ba032520c8bc6c2934648fb64cd92270ebd5ca27cc158ae01402bd75bd` |
| `thought-draft-light-tablet-list.png` | 820×1180 | `fc2bebf68285e43e1429fffac4164507ceb0a09932e081fe12e7a13043e22c31` |
| `thought-draft-light-tablet-map.png` | 820×1180 | `8603f83a22e589c7403978e6c35af088962e0334a4f88f379a50166340ac4f34` |
| `thought-edit-conflict-desktop.png` | 1440×900 | `c8b780b47d3963c951471bd090e672681d03d39dcca20700ac224de0d897ea3d` |
| `thought-edit-dark-desktop-list.png` | 1440×900 | `29eb44118843678954a72fc6e3e9695b0728fbe3253a724a9f0e64e9c2041013` |
| `thought-edit-dark-phone-list.png` | 390×844 | `79085b886dc45560cfeb33ae861c65651f06b5f2257c416f5cd8ba118d4b9c0b` |
| `thought-edit-dark-tablet-list.png` | 820×1180 | `9769a7899ef98bfd7815069202c976c83f5e83d5c760a2d1eace5424fbd69f46` |
| `thought-edit-failure-desktop.png` | 1440×900 | `b18facdc2ee0b9bd3887cf6e29689bfaf7f5e170cc6f51a7b0d19a25ad5a37e7` |
| `thought-edit-light-desktop-list.png` | 1440×900 | `d3c3000bbd23b1b636a9531dc599c147713908cf3c3b754f07f7ef957421cdcb` |
| `thought-edit-light-phone-list.png` | 390×844 | `bf92bf2e72498c9c03c8f5296d426228d7a70acda3bb25f3089f0f19d099ab46` |
| `thought-edit-light-tablet-list.png` | 820×1180 | `c894a810978467eec48771cdebf248ec5dc2c7c47df5b502863fcb0e775e5454` |
