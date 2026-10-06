# Independent source re-review — settled document editor effects

Reviewed head: `0dad85c0b74a28ef882e4673d984bf02e1c38e3c`.
Delta parent: `8ac82c405d9b20d6f20470a168247acdfddc9cfa`.
Original picker slice baseline: `c4f01936e5cdc49eae8b0fe7978b7f8daf6126df`.
Owner-reported P2 runtime baseline: `24737708` (abbreviated pin supplied by owner; not the reviewed head).
Reviewer: independent subagent `/root/bounded_state_contract_review`, source only. Date: 2026-10-03.

## Outcome

No remaining material source finding in this bounded re-review. The prior P1 editor ownership and P2 save-completion findings are addressed in source at the exact reviewed head. This does not constitute executed runtime acceptance, complete LP1–4/#155 acceptance, or eligible GitHub approval.

## Repair assessment

- The existing account/project/document key still owns the complete stateful editor lifetime and its private storage. A returning A→B→A editor gets a new lifetime; old mounted refs and waiters remain retired. Owner draft/base/attempt storage and native reference identity remain unchanged by this delta.
- `DocEditor.tsx` now records navigation/revalidator settlement in a layout effect. Successful save publication and conflict/error publication both wait for that settlement. If the destination commits a different editor or leaves the editor route, cleanup marks the old lifetime unmounted, resolves its pending waiters, and clears the queue; its continuation cannot clear private retry storage, navigate, or publish conflict state. Revalidation that retains the same keyed lifetime can settle and complete normally. Busy remains set until the current continuation finishes, avoiding a second save while a completed command is waiting for ownership.
- This covers the identified interval where the old editor remains mounted while destination loaders are pending. Neither queuing nor retirement alters the already authorized native command or its persisted UUID; a retired save leaves the owner's same-key retry state intact.
- The scheduled insertion focus restoration checks the original textarea is still connected and that focus is on the body or that same textarea. It therefore does not focus a detached editor or steal newer title/other-field focus. Existing Markdown insertion, chosen ID/type, and private editor body remain unchanged.
- The new effects have no command dispatch in effect setup. Initial StrictMode cleanup/setup has no user-created queued saves to revive; account/project/document replacement creates distinct refs. The settlement queue is bounded by the editor's single busy save and is released on idle or cleanup. I found no new material lifecycle or conflict-handling gap in the inspected source.

## Regression semantics and limits

The new test 08 holds a successful native A save and both B project-loader responses, releases the save while B is still loading, checks the requested B URL and A retry UUID, then releases B and checks its blank private editor and preserved A UUID. This targets the prior P2 before destination commit rather than only after unmount. Required failure/retry, project/document private drafts, account switch with held native response, query A→B→A, retired-save retry, and the pending-loader save scenario now run both desktop 1440 and emulated phone 390. Earlier >100 native paging and six-kind insertion scenarios already cover both widths.

The native persisted mutation and same-key retry assertions remain real API/database behavior when these tests execute. Emulated phone tests are not actual device acceptance. These browser-held responses also do not independently establish an abort-ignoring transport; the read store's inspected generation fences retain their separate source/unit evidence. Same-lifetime settlement and the focus guard are coherent in source, but this review does not claim an independently executed focused runtime check for them.

Independently inspected the two-file delta and surrounding editor/save/conflict/private-storage code. Delta `git diff --check` and Python AST syntax parsing of `test_doc_references.py` passed. The owner-provided `/tmp/flux155-doc-save-navigation-baseline.log` contains test 08's old-implementation failure, with the URL redirected to the saved A reader; I inspected that excerpt but did not run the baseline.

No current application/build/browser test was executed by this reviewer. The owner's current 15-test Docker run was pending when assigned and is not counted here as independent current-head PASS. Neutral rendered assessment, remaining full parent migration/scale/native task/state gates, all original #155 criteria and applicable device/provider/release outcomes remain required. Normal eligible independent final review remains with the designated peer.
