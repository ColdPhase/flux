# Assistant join-question identity — #402 / PR #457

Date: 2026-10-13. Implemented at `813affc6d247fdfc9c27bd2a7dc1887c8f1b7c12` on `codex-hubert/402-assistant-identity`. This evidence-only branch is based directly on that implementation commit; it has no PR. It archives the remaining assistant-request identity correction, not a new issue or a new feature.

## Observable change

A manager Inbox row for a new assistant join request now uses the request-time assistant public name and identifies it as an Agent, with an explicit `for <owner>` identity group. The row uses a monochrome Kreska without a circular human-avatar holder. The request retains its project and contributor-access context and the existing Review action.

The request transaction stores one immutable identity snapshot per `(join_request_id, opening_version)` and links each manager notification to the same cycle. Reopening a closed request gets a new version and snapshot; it cannot overwrite the earlier request-time names. Inbox list and individual-item projections still require the recipient’s current project-read access. This adds no authority and exposes no private helper settings, token, or guessed legacy identity. Historical notifications without a snapshot remain unchanged and visibly unverified.

This is the residual identity/UI correction within the existing #402/#457 A1 work. It does not re-certify every AST criterion in the parent issue or the rest of the application.

## Verification at the pinned implementation

- Docker application build, TypeScript checks, and ESLint passed. ESLint reported three existing hook-dependency warnings in `drafts.ts`, `DocEditor.tsx`, and `createdDraft.ts`. The only later source edits before the exact-pin focused run were test-only query/assertion corrections.
- Focused Docker API/migration tests passed **12/12** at the pinned source. Coverage includes request deduplication; recipients sharing one snapshot; decline, rename, and reopen producing a fresh snapshot while preserving the old one; real notification linkage markers; current read permission on Inbox list and item; no grant before manager Allow; and migration upgrade/reverse preservation.
- The running-app join journey passed **2/2**: Chromium desktop at 1440×900 and WebKit phone emulation at 390×844. The journey checks Request → Inbox → Review/Allow, absence of a grant before Allow, denial for an ordinary reader, retry after a denied Allow, contributor grant afterward, keyboard activation, and 44 px phone targets. Compute uses fake metadata only, with no model calls or vendor spend.
- Independent exact-head source review: [PR #457 comment 6151591406](https://github.com/ColdPhase/flux/pull/457#issuecomment-6151591406), no remaining source blocker in this identity scope.
- Independent screenshot-only visual review: [independent-visual.md](independent-visual.md), scoped PASS for desktop and phone identity grouping, scan clarity, and the Review view. It does not certify interaction or accessibility.
- GitHub checks at handoff: Agent setup passed (run [38441047127](https://github.com/ColdPhase/flux/actions/runs/38441047127)); Application validation passed in 2m32s (run [38441047327](https://github.com/ColdPhase/flux/actions/runs/38441047327)).

The original PNG manifests omit a source SHA. [capture-provenance.md](capture-provenance.md) states that limit explicitly, records the actual desktop/phone viewports and screenshot checksums, and lists the pinned production/E2E source hashes. After capture, only the two API test files changed; the implementation and E2E source did not. The note records that source equivalence as author-reported, not as metadata independently embedded by the runner.

## Rendered evidence

The 16 screenshots below are lossless WebP encodings of the supplied PNGs. Pixel comparison returned zero differing pixels for every converted image.

| View | Inbox row crop | Needs-you Inbox | Open Review |
| --- | --- | --- | --- |
| Chromium desktop, light | [row](images/join-chromium-inbox-row-light.webp) | [Inbox](images/join-chromium-manager-needs-you-light.webp) | [Review](images/join-chromium-manager-review-light.webp) |
| Chromium desktop, dark | [row](images/join-chromium-inbox-row-dark.webp) | [Inbox](images/join-chromium-manager-needs-you-dark.webp) | [Review](images/join-chromium-manager-review-dark.webp) |
| WebKit phone, light | [row](images/join-webkit-inbox-row-light.webp) | [Inbox](images/join-webkit-manager-needs-you-light.webp) | [Review](images/join-webkit-manager-review-light.webp) |
| WebKit phone, dark | [row](images/join-webkit-inbox-row-dark.webp) | [Inbox](images/join-webkit-manager-needs-you-dark.webp) | [Review](images/join-webkit-manager-review-dark.webp) |

Additional collapsed manager-row and owner-request captures are included beside these in `images/`.

## Remaining handoff state

The implementation head is pushed to the existing PR. PR #457 currently reports `BEHIND` the base and `CHANGES_REQUESTED`; older formal review state has not been cleared by the source/visual notes. At the time of this evidence capture, the PR base SHA was `2262eb406620a9d13532ea31189f16cf3c1efa98`, while fetched `origin/main` was `3163f2e2192987c7dfc40a4535adbdbc6b1c8f45`. The next assigned composition must reconcile the current base and retain review evidence tied to its actual source. Eligible formal approval and completion of the pending Application validation check remain outstanding. Do not merge on the basis of this evidence branch.
