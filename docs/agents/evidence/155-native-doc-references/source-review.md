# Independent source review — native document reference picker

Reviewed head: `a61cf336b6bcef916dd8c1c36588fc4e14e810ca`.
Delta parent: `c4f01936e5cdc49eae8b0fe7978b7f8daf6126df`.
Scope: four-file delta, shared choice/read hooks, read-store fencing, native query adapter, containing DocEditor and router integration. Reviewer: independent subagent `/root/bounded_state_contract_review`; parent remains sole implementation writer. Date: 2026-10-03.

## Material finding

**[P1] Scope the containing private editor when account/project/document changes.** `LinkPicker.tsx:60–67` now changes its read ownership with the account/project, but its `onPick` still inserts into the unscoped containing DocEditor. `DocEditor.tsx:62–68` changes `storageKey` with the account and selected document/project while initializing `fields` only on its first mount; `DocEditor.tsx:88` subsequently persists those retained fields under the changed key. The router renders the same unkeyed DocEditor component for a surviving edit route; AppLayout/WorkReadProvider does not remount its children on account change. Therefore account A's unsaved body can remain visible to B, be copied into B's private session-storage slot, receive B's newly scoped reference, and be submitted using B's session. A surviving project/document parameter change has the analogous wrong-draft/wrong-target risk.

This editor behavior predates the four-file delta, but the slice explicitly requires account/project/private-editor fences in LP3, so the picker read fence alone cannot satisfy that requirement. Retire/remount the complete editor lifetime by account/project/document (and fence pending preview/save completions as appropriate), preserving each owner's draft only in that owner's existing storage slot. Verify with two contributors able to read/write the same project: type a distinct private body as A, open the picker and hold a native query, switch the cookie to B and revalidate the same edit route, then release the old response. A's body, picker state and delayed work must not appear or persist under B; B must get only B's draft/native observations, and returning to A must restore A's draft. Also exercise a same-component project/document parameter change. This is a source finding with a concrete reproduction proposal; I did not execute the scenario.

## Source assessment of the delta

No other material source finding in the reviewed scope:

- Three enabled native `doc_refs` choice hooks each request one 50-row page. Selecting a native type disables the other kinds. The store retains one observation rather than appending full work collections. All retains mixed discovery capped at 40; selecting a native kind exposes Next/Previous pages. No native command or final server authorization is changed.
- Native search uses the accepted literal title query and clears server title filtering for an existing kind-label prefix match, retaining that discovery behavior. Server wildcard escaping and per-kind selection remain in the accepted query/repository path.
- Native mapping preserves kind, ID and title. The existing editor insertion still escapes Markdown labels and uses the exact `flux:type/id` reference. Document self-exclusion and project-scoped sketch/recent-message discovery remain. Reader destination formatting is unchanged.
- Required loading/unavailable reads suppress the whole displayed list; failure has an explicit retry rather than a false empty or partial success. Retry preserves the picker query and existing editor text within the current lifetime. The generic read store has render-time ownership and generation/abort fences, and dispatch pauses while router revalidation is active. The finding above concerns the containing editor lifetime, not those native response fences.
- Active keyboard options are scrolled inside their own bounded list; native type pages have no old 40-option truncation. Phone options retain the existing minimum touch height. No rendered or accessibility pass is inferred from this source inspection.

## Evidence and remaining work

The new real-native browser source creates 105 objects of each native kind; asserts 50/50/5 pages without duplicate titles, off-page search and foreign-project exclusion, keyboard option exposure, six-kind exact reference insertion and persisted mentions, document self-exclusion, and required failure/retry without erasing editor text. Held old-query/account/private-editor coverage is not yet present, as the owner explicitly reported. Literal wildcard and kind-prefix semantics are inspected in source rather than proven by these current browser assertions.

Independently passed delta `git diff --check` and Python AST syntax parsing of `test_doc_references.py`. No Docker build, application or browser test was executed by this reviewer; the owner's running build/UI test session is not counted as reviewer runtime evidence.

LP3 is not accepted while the material editor ownership gap remains. This bounded review is not acceptance of all LP1–4, whole #155, the scale matrix, full parent loader migration, actual device/provider/release gates, or eligible GitHub approval. All original criteria remain required with pinned runtime evidence and normal independent evaluation.
