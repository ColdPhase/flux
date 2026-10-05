# Independent source assessment — native reference-row backend

Reviewed exact head: `a4bc9d2508c48788a41014ee440d540e0045a0ce`.
Initial reviewed backend head: `a23f6e7bb6126d1b70b3730f903d5f5bcb834058`.
Accepted contract: `ffd11b619d18734773e076eab48989a98ec0ed3f`, recorded by owner at `d106a14d`.
Reviewer: independent subagent `/root/bounded_state_contract_review`, source only, no implementation edits. Date: 2026-10-03.

## Outcome

No material source finding in the bounded backend implementation at the reviewed head. This does not certify executed API/build/architecture checks, the unimplemented client migration, RR1–RR4 in full, whole #155 or eligible PR approval.

## Inspected implementation

- The closed parser permits only `objects`, validates raw 1..100 entries before normalization, rejects malformed/unknown kinds and duplicate query keys, and normalizes by existing kind/ID ordering. Reusing the extracted selector parser preserves existing relation-read fields and behavior.
- Selected membership is one bounded SQL values set scoped through the existing native project visibility predicate. Only same-project work/decision/result identities enter hydration; foreign and nonexistent identities both become submitted-kind/ID markers without content or reasons. The adapter snapshots its requested references before awaits.
- The core verifies unique row identity, native project/workspace/audience facts, canonical ordering of each partition, marker shape, and exact union equality to the normalized input. These checks enforce disjoint/exhaustive rows plus markers and the global <=100 bound; malformed, duplicate, omitted or metadata-bearing outcomes fail unavailable before the final fence.
- Found rows reuse current native bounded hydration and scalar prerequisite/relation aggregates. No detail body, implicit links, summary or project-wide object collection is requested by the new method. Existing work/decision versions, owner kind/ID/name, result attribution and native predicates are retained.
- Core observation remains one read-only repeatable-read transaction with observedAt, current project access and source-visibility fingerprint. The release requirements capture the assembled available partition. Outside that transaction, the final fence re-resolves the exact session and current central project policy, compares bounded current selected membership against the observed partition, checks the existing source digest, and retains the final exact-session/project-policy bracket. Membership drift returns non-disclosing 409 `work_read_changed`; project/session denial and required operation failures remain whole-request failures.
- The route uses existing session preparation/error mapping and private/no-store headers. Wire types belong to contracts, validation/orchestration/ports to core, membership SQL to DB, and composition to the server. The correction from the initial head uses existing DB structural `NativeWorkReadObject` rather than a new DB import of an unbuilt core declaration; it does not change runtime semantics or authorization.

## Source coverage and limits

Inspected new query/core/native test source. It covers raw boundaries/closed selectors, exact canonical mixed partitions and rejection of malformed adapter results, native long-field exclusion, human/agent owners and versions, 100 selected native rows without extra project rows, opaque foreign/missing outcomes, readable downgrade, denial, deleted/expired exact session, zero-link found-to-missing/foreign and marker-to-found drift, source-aggregate drift, and a real SQL failure becoming 503. Existing native hydration/final-fence behavior is reused rather than replaced. These are source coverage observations, not independently executed test results.

Independently checked exact HEAD, clean worktree, the full backend delta plus the import-only correction, and delta whitespace (`git diff --check` passed). No Docker/app/API/unit tests were run by this reviewer. The owner reported the initial build failed type resolution and a corrected build/query/core/native/architecture run is in progress; neither is counted as independent current-head PASS.

Client visible/focused-window selection, unavailable citation isolation, proposal accept/dismiss behavior, private composer/UUID/reader ownership, >100 citation reachability, network removal of the full parent collections and affected rendered/browser evidence remain pending. Original assistant/native state/task-plan/typing/scale, device/provider/MCP/release and whole-#155 gates are unchanged and require their own pinned evidence and normal eligible independent evaluation.
