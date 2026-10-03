# Selected native reference rows — #155 proposal

2026-10-03. Proposed technical extension of the accepted native work-read
contract; owner Zamojski5 on existing branch/draft PR170, final eligible task
reviewer PelikanFix16. Required original outcome: assistant citations and linked
proposal work retain native identity/title/owner/version without loading the
complete project work graph. No native command or product authority change.
Implementation starts only after independent contract assessment; no founder gate.

## Closed read projection

`GET /api/v1/projects/:projectId/work-reference-rows` permits only `objects`,
using the existing comma-separated native `work:uuid,decision:uuid,result:uuid`
syntax. Check the raw1..100 reference bound before deduplication/sort. Reject
unknown/repeated/malformed query fields, unsupported
kinds, and oversized input; normalization cannot turn invalid input into success.
No cursor, limit, search, account ID, title/body or private-source input.

Return `{ projectId, observedAt, access, items: NativeWorkRow[], unavailable }`:
each normalized requested identity has exactly one outcome: its same-project row
or a marker `{ kind, id }` containing only the submitted identity. Each partition
is in canonical kind/ID order; rows plus markers exactly cover the normalized
input and total <=100. Nonexistent and foreign identities have identical markers;
no reason, actual project, foreign-existence fact or content is disclosed.
Reuse current bounded native row hydration/aggregates;
no implicit links or full outcome/rationale/evidence, no summary/full-project
object enumeration, no per-row detail request. Data comes from one native
repeatable-read observation with the existing final current-policy fence.
Observe selected found/marker membership in that transaction. The final fence
rechecks this bounded membership alongside current session/project policy and
the existing source-visibility digest. Selected membership drift returns a
non-disclosing changed-observation error and requires refresh. Session/project
denial, DB/hydration/name/aggregate failures and policy failures reject the whole
request; only genuinely absent same-project identities become markers.
Existing entity APIs and final command authorization remain unchanged.

## Client and acceptance

- RR1: current account/project/selector/generation owns one observation. Pause
  dispatch and hide actionable old metadata during identity revalidation; retire
  old reads even for A→B→A/abort-ignoring transport. Retry retains composer,
  selected native reference, pending native command UUID and reader position.
- RR2: select at most100 distinct native identities from actual visible assistant
  citations/proposals plus the focused/interacted reference; preserve all answer
  text/citation links and native destinations even outside this metadata window.
  Focus/scroll reaches any other reference; no silently dropped citation or
  implicit global native collection/cache. Current metadata supplies labels and
  proposal owner/role checks. Isolate an unavailable historical reference from
  valid rows. Loading/transport failure, an observed opaque unavailable target,
  and a successfully read `owner:null` are distinct. Unknown transport ownership
  cannot enable accept. For an unavailable target, accept stays unavailable and
  existing authorized dismissal remains reachable separately under the native
  server's final authority; never treat unavailable as unowned or grant an agent
  extra authority. Preserve human owner/manager/viewer and genuine-agent behavior.
  Current mutable row versions do not rewrite committed citation revisions.
- RR3: after all former native work consumers migrate, remove `ProjectShell.work`
  and its complete native collection loader. Keep people/docs/sketch behavior and
  native summary/page/state reachability. This is removal of a legacy dependency,
  not weaker native APIs, frozen demo data or looser acceptance.
- RR4: Docker API tests prove raw bounds, exact requested rows and identity/order,
  mixed valid/nonexistent/foreign references with indistinguishable markers,
  read-denial/current policy/found-marker drift, no full long-text/link hydration
  and <=100 total outcomes. Real browser tests cover off-old-page native work citations,
  title/owner changes, owner/manager/viewer/agent proposal controls, required
  failure/retry, held account/project/query scope, private composer/native UUID,
  meaningful reader position, unchanged cited revisions alongside current row
  versions, missing-target rejected accept and legitimate dismissal, and >100
  distinct source reachability (early/middle/late destinations) on desktop and
  emulated phone. Verify network absence of legacy full native collections
  separately from DOM labels; preserve existing assistant and ProjectState journeys.

The original #155 scale/motion/typing matrix, superseded-only native fixture,
whole integrated release and real provider/device/MCP/install evidence remain
required. Mock-provider runs only prove native integration with that mock, not
real-model/provider acceptance. Original criteria are not reduced by this slice.
