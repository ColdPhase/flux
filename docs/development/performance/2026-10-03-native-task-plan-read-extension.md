# Preserve native task plans in bounded reads — #155 / #152 / #136

2026-10-03. Proposed additive integration contract; independent agreement and
runtime verification remain pending. This extends the [bounded read
contract](2026-10-01-native-work-read-contract.md) and preserves every original
#155 criterion. Owner: Zamojski5; eligible implementation evaluator: PelikanFix16.

The integration inspected #155 at `42a2a454e3da8d3fa5fa425ce1c702c57a8d66d7`
against main `55c54735ad7241017e18ae1a2777d35e718dc005`. Main now has native task
criteria, direct prerequisites and immutable plan intent. Restoring complete
project work collections would undo bounded reads; dropping these fields would
lose accepted task behavior. The attempted merge was saved and aborted without
changing either pushed head. This proposal governs the next integration.

## Observation

- Each `WorkRowProjection` adds `prerequisiteCounts: { total: number;
  unmet: number }`. Both are nonnegative integers; unmet is at most total, total
  is at most the native `WORK_LIMITS.dependencies` (currently 50). A prerequisite
  is met exactly while its current native status is done and it is not parked.
  Tasks without dependencies return zero/zero. Do not change work status, group
  membership or the existing all/mine totals because a prerequisite is unmet.
- Compute these scalars in a grouped batch for the already selected work IDs,
  never by fetching prerequisite bodies/collections for every row or issuing one
  query per task. Existing selected-row bound is 100. Scope joins to the same
  project and workspace; a malformed foreign or missing prerequisite is never
  evidence of fulfillment. Storage constraints remain authoritative; do not
  weaken them to build fixtures.
- `WorkDetailObject` for exactly one work item retains its canonical own fields:
  criteria, dependencyIds, prerequisites and planIntent, alongside existing own
  fields. Criteria use the native limit (20, each at most 1000 characters), direct
  prerequisite arrays use the native limit (50), IDs/order and each `met` value
  match the ordinary native work presenter. The plan intent remains the original
  material ID/version/intent key; it grants no permission or policy approval.
  No recursive/transitive graph, implicit links or project-wide graph is loaded.
- Counts and details share the existing read-only repeatable-read observation
  and final current session/project.read authorization. Dependency metadata is
  project information, with the same audience as the native task. Denied,
  revoked and foreign objects retain the existing fail-closed behavior. Counts
  are observations, never command preconditions or authorization proofs.

## Rendering and integration

Preserve the main Tasks waiting-prerequisite indicator using the bounded scalars;
keep native prerequisite names/status and criteria in the selected task panel.
Opening a prerequisite loads its native kind/id through the existing scoped
reader. Preserve native editing, finish guards, version conflicts and stable
clientCommandId retries; never infer permission from the counts. Panel intent
fences continue to prevent responses or commands for an earlier selection from
changing a later selection, including A → B → A.

Preserve main's project comparison suggestions, inspected sources, read-only
guards and native creation/result links. Their Work/Results jump counts come
from bounded project summary totals; reachable group anchors come from actual
bounded sections, with explicit navigation/loading when outside the displayed
page. Result names use displayed rows or existing inspected/cited source names,
with an honest fallback for an unloaded result; no full result collection is
fetched solely for a title map. Genuine-agent attribution, typing/message
associations, reading anchors, current open/history state and unioned native
package exports remain required.

## Required evidence

- **TP-1:** Native Docker SQL/API fixtures prove zero, mixed met/unmet,
  parked/unparked, done/reopened and 50-prerequisite boundaries; projection counts
  and one-object details agree with the canonical native presenter, including
  exact criterion/intent fields and ascending dependency IDs. Show the selected
  row/page bounds and absence of per-row graph hydration.
- **TP-2:** Current foreign/denied/revoked session/project tests, final access
  fence regressions and read-only transaction checks still pass. Missing or
  malformed prerequisite handling must fail closed, never silently mark met.
- **TP-3:** Docker browser checks exercise waiting indicators, selected criteria
  and prerequisite navigation, task mutation retries/conflicts and A → B → A
  response isolation. Comparison suggestion/source/jump actions and reader guards
  work without restoring full project collections. Preserve existing native
  state and real typing/anchor regressions, including reduced motion.
- **TP-4:** Run the relevant composed application checks at the integrated head,
  then obtain independent runtime and affected phone/desktop visual evaluation
  and eligible current-head PR review. Unrun checks remain explicitly pending.

This contract alone does not finish #155, the performance/device matrix, supported
provider/MCP client acceptance, PWA/Web Push or the complete application.
