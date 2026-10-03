# Independent visual review — comparison outcomes and private usage

Date: 2026-09-30. Review method: `flux-review-visual`, using the supplied neutral brief, original screenshots, Studio v11 references and repository design guidance. No implementation source, Git history, PR/issue records, prior task review reports or implementation-author rationale was inspected; no application files were edited and no GitHub comments were posted. The normative v11 refinement document contains summaries of historical design findings; those were not used as evidence about this task.

## Scope and evidence boundary

Jo and Kai are building a bedside gesture lamp. Jo's optional personal agent offers a quiet camera/ToF comparison or insufficient evidence. Project readers need readable ordinary work/navigation, separate fact/interpretation/proposed work, cited versus checked sources and clear version/unavailable/excerpt cues. Jo needs understandable private local usage, known estimates versus possible uncertain charges, past request history and readable phone controls; a peer should see their own empty usage. Preserve Studio v11's compact calm working surface.

I inspected all **21 original application PNG files** under `/tmp/flux58-current-head-screens/`: 11 outcome images and 10 usage images, plus all three supplied reference images. Dimensions and SHA-256 hashes were calculated directly from the original bytes. There are **20 distinct application images**: `comparison-usage-1440-owner.png` and `comparison-usage-1440-history.png` are byte-identical. They do not provide two independently visible desktop states.

Producer-supplied application-source scope: `8d5dc1489fb6ba80bc23da185288aeaa5a6c816d`, with a reported clean build start and later documentation-only edits. This review ties its observations to the exact image bytes below and records that supplied scope; it does **not** independently establish checkout/build provenance or certify what code produced the images.

Supplied capture conditions: desktop 1440×900, independent mobile/touch phone 390×844 and independent touch tablet 1024×768; DPR 1, browser zoom 100%. PNG dimensions agree with those viewports. The `1440-text125` capture enlarges text to 125%, rather than changing browser zoom. Touch capability, DPR and zoom were supplied by the producer and cannot be established from PNG bytes alone. Screens are at different scroll positions; partial content directly beneath a fixed header is not treated as an overflow defect by itself.

## Visible assessment

The captured outcome views have a calm working scale. Collapsed suggestions stay close to ordinary work/results, with restrained separators and a clear Review or Inspect entry. Expanded outcomes make **Observed fact**, **Interpretation** and **Suggested next step** distinct. On phone they stack into a readable sequence instead of compressing into columns. Cited sources and checked sources have different headings and explicit version labels. The excerpt, full-source character count, one unavailable source and current-content caveat remain visible in the relevant detail/footer captures. Insufficient-evidence footers show Dismiss as the sole visible outcome action; the suggestion has the separate Edit / Use as work / Dismiss set on desktop/tablet.

Usage captures distinguish the payer, provider/model, key ending and local allowance from usage. The summary separates observed estimates, possible unknown amounts and active reservations; nearby copy explains that counted amounts overlap and are estimates, and that interrupted requests can still incur a charge. History visibly distinguishes **Did not run**, **Charge uncertain** and **Completed**, including the insufficient-evidence completion, observed estimates/tokens and earlier reservations with missing usage. The peer phone capture shows zero usage and a clear personal empty-history sentence. Controls and text stay within the narrow layout in the supplied frames. The 125% text outcome capture preserves readable wrapping for the fact, interpretation and long source titles.

The three v11 references contribute quiet surface/separator treatment, modest headings, stable navigation and useful reading space. They are comparison points, not templates: the supplied map references also contain deep indentation and distant actions, which are not reasons to reproduce those weaknesses here. The present work keeps the restrained reading surface even though its shell differs from the reference shell.

## One material visible finding

**1. Generic request-history rows lack a readable request/work identity.**

- **Location/evidence:** `comparison-usage-1440-owner.png` / the identical `1440-history.png`, `comparison-usage-1024-owner.png`, `comparison-usage-1024-history.png`, `comparison-usage-390-owner.png` and `comparison-usage-390-history.png`. In particular, the plain Completed entry at Sep 30, 06:00 UTC and the repeated Aug 30, 06:00 UTC Completed entries show an amount/tokens or earlier-reservation cue without naming the request, relevant project or work. A nearby completion with an insufficient-evidence description is easier to distinguish.
- **Visible symptom:** several entries share a generic status, timestamp and cost wording and look interchangeable. Their layout clearly identifies accounting state but does not identify what ran.
- **Consequence:** Jo can see that requests were counted but cannot visually trace several records back to the lamp work or distinguish one old request from another. This matters more as the visible history count reaches 50.
- **Improvement direction:** add a concise retained request/work label and, when applicable, its project or source destination within the existing row hierarchy. If old records have no recoverable context, use a truthful missing-context cue. Preserve status, timestamp, estimate/reservation and uncertainty wording; this does not need another card or a larger heading.

This finding concerns visible traceability, not an assertion that request metadata exists, that the rows are incorrectly calculated, or that a destination is already available. No other material visible problem was found in the supplied frames. That result applies only to this captured scope.

## Preserve

- Compact project header/navigation, bounded reading width, quiet separators and short local controls.
- Separate facts, interpretation and proposed work; the quiet statement that the agent has not changed work or decisions.
- Distinct cited/checked source sections, version labels and honest excerpt/unavailable-source cues.
- Phone detail stacking and wrapped long source labels, rather than global text shrinking.
- Explicit payer/local allowance, estimates/uncertain charges/reservations, zero-charge non-execution, and history that survives connection replacement/disconnection according to the displayed wording.
- Clear personal empty usage/history for the peer. The image demonstrates the displayed empty state, not enforcement of privacy.

## Missing states and live-check questions

The image set does not show ordinary conversation reading/composing, source destinations/excerpts after opening, project Map/Docs content, permission loss during viewing, loading/failure of refresh, full connection replacement/disconnection flows, expanded recent-history tail or pagination, phone expanded-suggestion action footer, phone dark/enlarged-text usage, a virtual keyboard, or focus after all expand/collapse/return actions. The duplicated desktop owner/history image also leaves a distinct later desktop history position unobserved. These are evidence gaps, not proof of failure.

Live checks should establish:

- Do Review/Inspect, checked-source expansion and source return preserve reading position and show the expected content/version? Are unavailable sources withheld without exposing inaccessible titles/content, and is an inspected excerpt distinguishable from the full source?
- Can phone/tablet touch and keyboard users reach all controls, suggestion actions and the end of history? Does expanded content remain usable with larger text, keyboard overlays and changing orientation? Test focus/target sizes/contrast with the running interface rather than inferring compliance from these images.
- Does each person retrieve only their own connection, allowance and history across sessions and permission changes? Does the peer remain empty through actual data/API paths?
- Are UTC attempt limits, rolling-period counts, observed estimates, unknown possible charges, reservations and historical records accurate and persistent? Do refreshing, interrupted requests and replacing/disconnecting a connection produce the displayed distinctions? The screenshot review does not validate accounting or provider invoices.

No behavioral, accessibility, accounting, privacy/security, real-device installation/push or whole-task approval is issued by this visual review.

## Original application image inventory

Every file below was opened and visually inspected from its original PNG. All application files share the directory `/tmp/flux58-current-head-screens/`.

| File | Dimensions | SHA-256 |
| --- | --- | --- |
| `comparison-outcomes-1024-checked.png` | 1024×768 | `be7f67f23812af5c6b30705f4334d9c0c614ba4e1ed5cb995546034fba6643ca` |
| `comparison-outcomes-1024-collapsed.png` | 1024×768 | `0afb31fee902897ca1206f49c71ad7a2fe847e95e95bb4a6a672af47b02e7099` |
| `comparison-outcomes-1024-insufficient-footer.png` | 1024×768 | `e29862069012565e5d339fa49c37251bf9c6c3041cdc3e62623610e3a03bf761` |
| `comparison-outcomes-1440-checked.png` | 1440×900 | `eb17753ee93ce005477adb8480ed2ea499c9df8b03d98f22068b1eb230baea08` |
| `comparison-outcomes-1440-collapsed.png` | 1440×900 | `b9ca87579c2eb04335934f1dc7b76c95daa2181632a271f257399d116fb3e21b` |
| `comparison-outcomes-1440-dark.png` | 1440×900 | `8c5283a6f913f178b96de063be8532531d4164fae5d405b03f8b14593bdba535` |
| `comparison-outcomes-1440-insufficient-footer.png` | 1440×900 | `b732c16604369765c0dd6b662f127ff8bed1764d11f4f9b4071aa241755c5ea0` |
| `comparison-outcomes-1440-text125.png` | 1440×900 | `8d326de3912f0ca6c3fa6b9e60d713d4d046461c33ced789847e4fa31a9db298` |
| `comparison-outcomes-390-checked.png` | 390×844 | `aee8d6fe9e2dfa4848a6c664a79719c2db7a7954dd9b4acbab303fb7d5b9407e` |
| `comparison-outcomes-390-collapsed.png` | 390×844 | `2a0df0b216df125fa2aa2fb8b782e4e245d3c208dc159531fbc24d9b33d4ed92` |
| `comparison-outcomes-390-insufficient-footer.png` | 390×844 | `0b031c2a43b787213954908b71eacb00bbfa7838962b16ffab9eaeff106dbeac` |
| `comparison-usage-1024-history.png` | 1024×768 | `f798331af416d1eebd4f4af829c5993ab86e3dd21d9f0398cedfba1c0dd49c89` |
| `comparison-usage-1024-owner.png` | 1024×768 | `3daed98688c31ec2a77a6ae17c6119b751476dd973f552de3952bacf02ba6318` |
| `comparison-usage-1024-summary.png` | 1024×768 | `f45a78921cebf3911966c0648667d89a6450f7d675a990c8b843f9fbe76eed73` |
| `comparison-usage-1440-history.png` | 1440×900 | `40105859a0235b6386f6a55d2db628346ae5ca41de73c3a4a270ac52a6f53ed2` |
| `comparison-usage-1440-owner.png` | 1440×900 | `40105859a0235b6386f6a55d2db628346ae5ca41de73c3a4a270ac52a6f53ed2` |
| `comparison-usage-1440-summary.png` | 1440×900 | `7d1e9e2b3aa87ba54fc47b923f4f9caa874a7ca25cd461fe6e82e712c0d3f24c` |
| `comparison-usage-390-history.png` | 390×844 | `ba602e0507f115ab05a082f9390f83a1bbfd0a9070f35049ea9de2b6ebfaa82a` |
| `comparison-usage-390-owner.png` | 390×844 | `d55da561570b35a844c01dbab4a2432fa7c6ebe656963b68ad945b05bdf3bdbc` |
| `comparison-usage-390-summary.png` | 390×844 | `befd857a8ac574969e8303720214ae99ed19d4fc02380534b462037a31476b0e` |
| `comparison-usage-390-viewer.png` | 390×844 | `065f33384f2575895a91231771bc6647a1e2ffa1b253227a3226c7d9b3f96179` |

### Per-image coverage

- `comparison-outcomes-1024-checked.png`: Tablet expanded fact/interpretation/proposed-work structure, cited and checked sources, excerpt/unavailable cues and action footer.
- `comparison-outcomes-1024-collapsed.png`: Tablet quiet suggestions above ordinary open work/results.
- `comparison-outcomes-1024-insufficient-footer.png`: Tablet insufficient-evidence checked-source footer, sole Dismiss action, work/results below.
- `comparison-outcomes-1440-checked.png`: Desktop expanded suggestion and beginning of long insufficient-evidence body.
- `comparison-outcomes-1440-collapsed.png`: Desktop two collapsed suggestions, filters, open work and four results.
- `comparison-outcomes-1440-dark.png`: Dark desktop expanded outcome hierarchy and long source labels.
- `comparison-outcomes-1440-insufficient-footer.png`: Desktop long insufficient-evidence text followed by checked-source/footer cues and Dismiss.
- `comparison-outcomes-1440-text125.png`: Desktop enlarged text: wrapped fact labels/interpretation and long source labels.
- `comparison-outcomes-390-checked.png`: Phone stacked fact/interpretation/proposal and cited/checked source lists with wrapped version labels.
- `comparison-outcomes-390-collapsed.png`: Phone navigation, quiet suggestions, work/results filters and open work.
- `comparison-outcomes-390-insufficient-footer.png`: Phone checked-source/version/excerpt/unavailable cues, Dismiss and ordinary work/results.
- `comparison-usage-1024-history.png`: Tablet older reservation/missing-usage history rows.
- `comparison-usage-1024-owner.png`: Tablet usage totals, explanatory text and recent status/amount rows.
- `comparison-usage-1024-summary.png`: Tablet saved connection/payer/allowance controls and beginning of usage.
- `comparison-usage-1440-history.png`: Desktop totals and first history records; identical bytes to owner image.
- `comparison-usage-1440-owner.png`: Desktop totals and first history records; identical bytes to history image.
- `comparison-usage-1440-summary.png`: Desktop saved connection/payer/allowance and usage summary.
- `comparison-usage-390-history.png`: Phone recent states plus an older reservation/missing-usage record.
- `comparison-usage-390-owner.png`: Phone usage amounts/explanation and first four recent records.
- `comparison-usage-390-summary.png`: Phone saved connection/payer/allowance controls and beginning of usage.
- `comparison-usage-390-viewer.png`: Peer phone zero usage, personal empty history and beginning of project-rule controls.

## Original reference inventory

All three originals were opened and visually inspected. Directory: `/home/hubert/Develop/flux/docs/design/references/studio-v11/inspection/`.

| File | Dimensions | SHA-256 |
| --- | --- | --- |
| `conversation-1440-light-mint.png` | 1440×900 | `4b7fb875c2fd8b42ed36367de92805db9b273a257c8f8ad4388f2584db525799` |
| `map-deep-after-1440.png` | 1440×900 | `b0498bd96abe55b407adbe8783acb825174b9a35d9e9ce3b543380a9762eefd7` |
| `map-deep-after-390.png` | 390×844 | `b56d75253b8cb9936f689ed6f3d99e0abe3edee6293c920b9f199fe4670f04c7` |
