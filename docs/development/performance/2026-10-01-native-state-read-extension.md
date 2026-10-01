# Preserve native state in bounded reads — #155 / #136

2026-10-01. Proposed additive contract extension, awaiting independent review.
No runtime implementation or completed acceptance is claimed here.

The [bounded read contract](2026-10-01-native-work-read-contract.md) provides
active work and blocked refs but omits the open-task and retained-history refs
delivered by accepted #169. Integrating main3abbd0f4 into #155 without addressing
this would lose reachable state objects. Preserve these behaviors while keeping
the read bounded; do not restore full native object collections in the header.

## Proposed observation

Extend `ProjectWorkSummary.state` with:

- `open: { count: number; first: WorkReadRef | null }`: unparked native status
  `open`; count equals `all.open`. First uses createdAt DESC, id DESC.
- `history: { completed: number; notPursued: number; parked: number;
  firstWork: WorkReadRef | null; decisionCount: number;
  firstDecision: WorkReadRef | null }`. Completed and notPursued count native
  done/not_pursued work without park metadata. Parked counts native work with
  park metadata, matching the accepted retained-history predicate. Native storage
  forbids parked work being done/not_pursued at the same time; finishing clears
  parking. Preserve that constraint and those command semantics. FirstWork is
  the newest native work of any status, firstDecision the
  newest native decision of any status, each ordered createdAt DESC, id DESC.
  decisionCount includes proposed/accepted/superseded native decisions,
  so a superseded-only project does not become an empty project.

Canonical DecisionStatus is proposed/accepted/superseded; this does not add a status.
Use at most three additional id/kind/title refs, aggregate counts and LIMIT1
queries. No body/rationale, relationship collection, per-item query or client
pagination is added. Every count/ref belongs to the same existing repeatable-read
observation with final current authenticated project.read authorization. Existing
Tasks all/mine predicates and totals remain unchanged. Counts are not authority
proofs, immutable snapshots or claim/checkpoint completeness.

## Rendering and verification

The native state row retains needs-you priority. Open work has an `N open task(s)`
part with a reachable native first work object, alongside current rules/actions.
Only when those state parts are absent does history show completed/not-pursued/
parked counts and open firstWork; if there is no work, retained decisions show
`N earlier decision(s)` and open firstDecision. The overview deduplicates full
kind/id identities, keeps current read-only copy and does not mislabel history
as in-progress. Empty is used only with no native work/decisions/results.
Keep pending/unavailable reads distinct from empty content. Preserve the narrow
blocked-count correction once independently accepted, including enlarged text.

Required implementation evidence: actual native SQL counts/ref ordering and
authorization for open, done, not_pursued, parked and superseded-only fixtures;
real parked-to-done/not_pursued transitions clear parking, and direct illegal
parked-finished storage is rejected. A synthetic predicate test is not a native
fixture and cannot require weakening that constraint. Include foreign/denied
projects and same-name owners unchanged. Run existing
`test_project_state` without weakening its native open/history/reader assertions,
plus bounded-read core/native regressions and the composed application checks.
Separately assess affected rendered phone/desktop views. This does not certify
the complete performance matrix, real PWA/client/device behavior or whole #155.

## Integration checkpoint

An initial merge inspection at #155 head8ded36a0 found seven conflicting files:
ProjectConversation, ProjectOverview, work/api, work/inline and the three package
export indices. The merge was aborted cleanly before creating a candidate; all
original work and preview18581 remain preserved. Resume after this extension's
review: retain bounded message/object/relation reads and typing, add accepted
genuine-agent attribution/clientCommandId/reader form guards, union native package
exports, then verify the composed result. No peer branch is modified.
