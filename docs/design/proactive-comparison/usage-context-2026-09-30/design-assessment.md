# Independent accounting design assessment — Flux #58

Date: 2026-09-30. Reviewed checkout: `/home/hubert/Develop/flux/.worktrees/58-proactive-comparison`, head `ffd1b62e4e2049cd52d07eae376b3e5803497205`. Reviewed task: `/tmp/flux-issue-58.json`, the owner’s bounded context proposal, current product/development contracts, the integration visual finding, and actual contract/core/database/server/browser/test consumers. Applied `flux-plan-task` and the repository architecture instructions. This is planning feedback, not an eligible GitHub approval, runtime verification, or acceptance of all #58 outcomes. No repository implementation or GitHub records were changed.

## Recommendation

Accept the additive context direction as a bounded improvement, provided the shared core projection enforces the authorization and exact-result boundary described below. Recognizable triggering-result and project names can resolve the existing visual finding: recent history currently leads with repeated status/time and opaque request IDs, making otherwise distinguishable requests difficult to recognize. The labels must lead the rendered row; adding hidden fields or placing names beneath the same repeated accounting details would not demonstrate that this finding was resolved.

The owner remains entitled to their own historical accounting after losing project access or disconnecting. This entitlement does not grant current access to project/result names. Keep every existing owner row, ID, status, timestamp, charge estimate, reservation and aggregate exactly as before; redact only the new context. Keep the existing newest-50 bound and no caller-selected owner. This change needs no schema migration, worker changes, provider calls, source-body reads, new event, or additional budget charge.

## Concrete interface and ownership

Add this field to `BackgroundComputeCandidateUsage` in `packages/contracts/src/proactive-outcomes.ts`:

```ts
/** Current readable trigger labels; unavailable or older-server payloads reveal no names. */
context?: { projectTitle: string; resultTitle: string } | null;
```

Optionality is rolling browser/server compatibility only. Every new-server candidate explicitly emits either the two-field object or `null`; new browser code treats absent identically to `null`. Do not add nullable individual names, historical snapshots, source titles, message bodies, prompts, answers, material metadata or provider request IDs. These are current labels for the exact triggering result, not a promise about the title when a historical run occurred. A rename appears on the next successful refresh; the exact result ID remains the destination.

Extend the outcome repository port with a focused metadata method, for example:

```ts
usageContext(projectId: string, resultId: string): Promise<{
  projectTitle: string;
  resultTitle: string;
} | null>;
```

Implement SQL in `packages/db/src/repositories/proactive-outcomes.ts`; orchestrate access and enrichment in `packages/core/src/proactive-comparison/outcomes.ts:usage`; retain existing server composition in `apps/server/src/proactive-comparison/outcome-adapter.ts`. Core must not import DB schema/query code or HTTP/browser concerns. The existing `GET /api/v1/background-compute-usage` and browser client receive the same DTO. Do not create a separate UI-only title endpoint or let browser project caches bypass the server projection.

Within the existing unit of work: first obtain the existing `ownerUsage(principal.id, now)` DTO. Form the unique project IDs from those returned candidates only; sort them and authorize sequentially using `requireProject(principal, projectId, 'read')`, which already invokes central `evaluateProject` with locks. Cache the allowed/denied decision within this request. For successful projects, resolve each unique `(projectId, resultId)` pair through the focused metadata method, retaining a request-local pair cache. Return candidates in their existing order with explicit context. A denied or missing project, missing result, or result that belongs elsewhere becomes `null`. Expected `NotFoundError` / `ForbiddenError` from the authorization step may become denied; arbitrary policy or storage failures must fail the request rather than silently present a successfully refreshed redacted history.

Do not authorize in parallel: sorted sequential acquisition fits the existing policy-lock transaction and limits lock-order risk. At most 50 returned candidate rows are enriched, with at most 50 unique project checks and 50 pair lookups. Do not enumerate owner project memberships or history outside the existing page in order to build labels.

The exact contract for “authorization before reading names” needs honest wording. Current `evaluateProject` in `packages/core/src/access/policy.ts` first reads workspace/actor access, acquires relevant access locks, then internally selects the entire project row while computing the access level; it suppresses that row on denial. Therefore this additive implementation can guarantee **no separate context metadata read before a successful central policy decision, and no names returned on denial**. It cannot truthfully claim that the trusted policy never reads the name column internally before determining authorization. Reusing that central policy is safer and less disruptive than introducing a second ACL calculation. If the accepted scope intends the stricter physical-query property, it requires an explicit separately reviewed policy refactor; do not certify that property from a metadata-port call-order test.

## Unsafe joins and hidden consumers

`ownerUsage` currently computes totals and its newest-50 page solely from `proactive_comparison_outbox` rows scoped to `owner_user_id`. Preserve those queries. Joining project/result tables into the base aggregate/page can drop historical rows, alter counts, or expose names before authorization. Even a left join selects names before the application permission check. Enrich after authorization instead.

Migration `0028_proactive_outbox.sql` references `result_id` to `project_results(id)` only; it does not enforce a composite project/result boundary. The metadata query must require both the candidate’s exact result ID and `project_results.project_id = requested projectId`, and join the project to that same result project. Matching workspace identities is appropriate to the existing scoped model. A result-only lookup followed by an independently authorized project lookup would allow a persisted misbound row to disclose a title from another project. Do not trust the candidate’s pair simply because its result ID has an FK. A missing/misbound pair yields `null`, preserving the row and its amounts.

Searches of actual usage DTO/path/`ownerUsage` consumers found the contracts, core use case, DB repository, server route/adapter, web API/settings/history view, and existing core/API/recovery/browser tests. No SDK, MCP, export, provider or worker consumes this new display context on this checkout. Test fixture DTOs may omit the optional field; new-server response assertions should require it explicitly. Do not touch `inspectedSources` redaction or publish its saved titles into accounting as a shortcut.

The browser’s `BackgroundComputeSettings` replaces usage state on successful refresh. Preserve whole-response replacement: merging old context into a new `null` response would retain private names after access loss. Avoid persistent/global title caches. On refresh failure, the existing view retains its last fetched figures and announces that fact; any retained names are part of the same stale snapshot, not newly authorized metadata. Already delivered data cannot be recalled by a later request. Do not promise immediate removal from every already-open browser on revocation unless an explicit invalidation mechanism is implemented and tested.

## Rendered behavior and accounting meanings

For available context, lead each existing compact history row with the result title and project title, rendered as React text. Keep status/time, stable request reference, existing uncertainty/reason/amount text, and the exact-ID `View result` link easy to inspect. Handle long titles and repeated titles without horizontal overflow or losing the full stable reference. The link’s accessible name can include authorized result context; unavailable context uses a generic name without a private fallback.

For absent/null context, show a concise explicit cue such as “Result context unavailable,” keeping the owner’s accounting row visible. Do not distinguish “private project exists” from missing/misbound metadata through different title-bearing messages. The existing generic link may continue to point to the accepted historical IDs because the destination reauthorizes and fails generically on denial; do not claim that an unavailable result is currently openable. Do not render old project/result names from route state, cached project objects, inspected-source snapshots, or result text.

The change must preserve the current five accounting amounts and their meanings: counted amounts overlap; observed cost is an estimate rather than an invoice; `unknown` retains possible charge; `reserved` is in flight; `completed` without observed usage is an earlier reservation, not active spend; persisted dispatch intent is not proof of sending or charging. A recognizable title must not make an uncertain run look settled, imply provider-confirmed charges, reset amounts on key replacement/disconnect, or imply a current right to open source evidence.

## Required evidence for the bounded change

1. **Core tests:** the caller is the signed-in human owner; agent/missing identity remains rejected. Trace authorization before the metadata call for each pair; denied projects cause no metadata call; sort/deduplicate project checks; cache pair reads; bound enrichment to returned rows. Expected denial/missing maps to explicit null, while unexpected authorization/storage errors propagate. Original order, IDs, timestamps, statuses, limits and every amount remain identical.
2. **Repository/API tests:** distinctive readable current project/result names appear for that owner only. A second owner gets only their own rows/totals. Revoke owner access and confirm names absent from the entire serialized payload while row IDs and amounts remain unchanged. Disconnect/replace the connection without resetting history. Test exact project/result misbinding, missing metadata, and renamed names. The result FK may prevent physically deleting a referenced result; use a focused repository fixture or port test for the missing case rather than disabling integrity globally. Do not rely solely on a UI assertion to establish payload privacy.
3. **Browser tests:** current server context and an older payload lacking it both render. Available names lead; null has the neutral cue; successful refresh from available to null removes old names. Preserve status/uncertainty/reservation details and exact-ID navigation. Verify keyboard and touch interaction, long realistic titles, desktop/phone/tablet density and no horizontal overflow. A failed refresh must retain the truthful stale-update message. These are the existing history surface’s bounded tests, not a redesign of the full shell.
4. **Independent visual evidence:** render the current tested commit with multiple realistically named available rows, one inaccessible/missing-context row, and mixed completed/unknown/in-flight cases at consistent desktop/phone/tablet settings. Ask the neutral evaluator whether recognition and compact hierarchy improved, not whether adding the proposed field was performed. A screenshot cannot establish authorization, accounting or link behavior.
5. **Documentation:** update `docs/product/background-compute.md` and `docs/development/proactive-comparison.md` before implementing the public contract, distinguishing current authorized optional labels from retained owner-private accounting. Record the tested commit and actual checks; do not describe this source inspection as a runtime pass.

The addition directly addresses the bounded accounting-clarity finding if these interface and rendered-behavior checks pass. It does not complete #58 by itself: real provider/production runtime and cost evidence, current-head independent code/visual review, the manual no-AI path, and all accepted permission/budget/recovery and device outcomes remain required. The draft partial PR status and any explicitly unavailable acceptance evidence stay truthful; no criterion should be reduced to make this projection change count as full acceptance.
