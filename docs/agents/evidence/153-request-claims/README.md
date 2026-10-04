# Request claim, resolution and supersession (#153)

Tested head: `725ee900` (tree `6cf8a2ff3266756351c51ebf0e94f3d77ecd8cb2`), branch
`claude-maurycy/153-request-claims`. It is stacked on `claude-maurycy/153-request-admission`
(PR #246, `387d0d06`, not yet merged). Its application source is identical to
`0dd0d5cb`, where the affected set and the mutation proof ran. `725ee900` adds
only test files. Later commits change only documentation.
Owner: Zamojski5. Independent evaluation by PelikanFix16 is still required.
Original AC1–AC5 stay open. No public MCP action, client scheduling or UI is
enabled. See the [plan](PLAN.md) and the
[contract section](../../../development/cowork-coordination.md#request-claim-and-resolution-2026-10-04-peer-review-required).
Source hashes at the tested commit are in [source-sha256.json](source-sha256.json).

## Needs action before push

- **Migration `0049` reservation.** `0049` was free on main and on every
  remote and local branch on 2026-10-04 (0045 #154 files, 0046/0047 #228,
  0048 #238). The reservation still has to be posted on #153.
  `FLUX_SCHEMA_VERSION` is now 49, so any of 0045–0048 that lands later must
  keep 49. Any later migration that rewrites
  `agent_standing_grants_operation_check` must keep the two new operations.
- **#152 registry acceptance.** `cowork.request.claim` and
  `cowork.request.respond` are additions to PelikanFix16's operation registry.
  `cowork.request_state` is reused with its fields unchanged; only its doc
  comment now says "acting connection".
- **Open peer question.** Which grant authorizes the response publication
  itself. See the contract section.

## What changed

- `app/apps/server/src/co-work/responses.ts` —
  `coWorkRequestResponseInTransaction`, the recipient's composition. The steps
  are:
  1. #152 `prepare`;
  2. `coworkUnitRows.lock`, which takes the recipient slot, the #171 graph
     locks, the complete task set and the unit rows;
  3. the request row lock;
  4. the pure rules;
  5. reference readability;
  6. for a resolve, the injected `publishResponse` and the in-transaction
     readability check of the response;
  7. the conditional update;
  8. the `cowork.request_state` post-state hook;
  9. #152 `complete`.

  Replay is an observation: it rechecks readability, and the hook rejects a
  later transition or a changed claimed generation as stale.
- `app/packages/core/src/co-work/responses.ts` — strict payloads and the pure
  claim and respond rules: the live unit fence, addressing, the closed,
  version and expiry checks, an already claimed or lost request claim, and the
  response reference shape.
- `app/packages/db/src/repositories/cowork-responses.ts` — the request row
  lock, with fresh `clock_timestamp()`. It also holds:
  - conditional `claim`/`respond` updates that repeat the unit fence and the
    request version/state in SQL;
  - `supersede`;
  - the canonical read for the hook.
- `app/apps/server/src/co-work/requests.ts` — a *created* admission
  supersedes earlier `queued`/`deferred` requests with the same lineage,
  sender, recipient unit and kind. Their IDs are returned in
  `supersededRequestIds`.
- Registry: `contracts/agent-execution.ts`, the core `POSTCONDITIONS`,
  `co-work/grants.ts` (an exact target is the recipient's own unit) and
  migration `0049_cowork_request_responses.sql`, which widens the grant
  operation CHECK only.
- Tests:
  - `tests/app/cowork-request-responses.test.ts` is new (9 tests).
  - `tests/app/agent-request-response-migration.test.ts` is new: the 0049
    in-place upgrade. It covers the ledger and the refusals before 0049, then
    asserts that the live operation list equals `AGENT_OPERATIONS` exactly
    (the prior list plus the two operations). Historic rows stay
    byte-identical, unknown operations stay refused, and a re-run is
    idempotent.
  - `agent-doc-authors-migration.test.ts` now compares 0043 against a frozen
    0043 list instead of the moving contract list, as the 0038 test already
    does. The exact head-list equality moved to the 0049 test, not away.
  - `agent-execution-core.test.ts` gains the two exhaustive sample entries.
  - In `cowork-admission.test.ts`, the F2 test's pre-existing "old" request is
    now a `help` request. A later review to the same unit would otherwise
    supersede it by design. The F2 assertions are unchanged.

## Executed checks (Docker, isolated Compose projects, ports 19060–19065)

- **Image build, typecheck and lint** (`docker build --target build`, which runs
  `pnpm build && pnpm typecheck && pnpm lint`) pass. The pre-existing
  `react-hooks/exhaustive-deps` warning remains; it is not an error.
- **New file** `cowork-request-responses.test.ts` at `0dd0d5cb`: **9/9**.
- **Targeted set at `725ee900`**: `agent-request-response-migration`,
  `cowork-request-responses`, `agent-doc-authors-migration`,
  `agent-request-operation-migration` and `migration-ledger`, **17/17**, with
  0 skipped.
- **Affected set** at `0dd0d5cb`: 17 files, **118/118**, with 0 skipped,
  cancelled or todo. The files are `agent-doc-authors-migration`,
  `agent-execution-core`, `agent-execution`, `agent-request-operation-migration`,
  `architecture`, `cowork-admission`, `cowork-claims-core`, `cowork-execution`,
  `cowork-migration-arrival`, `cowork-recovery`, `cowork-request-responses`,
  `cowork-requests-storage`, `cowork-storage`, `mcp-work-actions`,
  `migration-ledger`, `oauth-mcp` and `task-graph-core`.
- **Full `./scripts/check_application.sh`** at `725ee900`
  (`FLUX_TEST_PORT=19060 FLUX_TEST_MAILPIT_PORT=19061`): **EXIT 0**.
  - API: **671/671**, 0 skipped. That is the previous 661 plus the 9
    request-response tests and the 0049 migration test.
  - Every later browser/service phase passed: 3+1+1+1+1+6+1+1+1+1 = 17 tests.
  - An earlier full run at `0dd0d5cb` also exited 0, with 670/670 and the same
    17 browser/service tests.
- **Foundation:** `check_agent_setup.py` passed. The host Python suite ran 67 tests,
  all OK. `git diff --check` is clean.
- Raw logs stay local (`w153c-t1`…`t5`, `w153c-full`, `w153c-full2`,
  `w153c-mut-*`) and are not published. The first two targeted runs failed in the test fixtures, not
  in the product:
  - Marek lacked project management, so he could not create his own grants.
  - The refusal helper started the attempt before its snapshot.
  - Senders named the stale recipient unit version.

  Those fixture faults were fixed before `0dd0d5cb`.

## Negative controls

Each refusal snapshots the request row (state, version, claimed generation,
reason, boundary, dependency, response) together with the connection's total
grant uses, its receipts and the project's result rows. The snapshot is taken
before the attempt starts and asserted unchanged afterwards.

- **Request claim:**
  - no unit claim, a wrong lease, a wrong generation, another runtime session,
    an expired unit lease: `COWORK_CLAIM_LOST`;
  - an unknown request, another unit of the same connection, another
    connection's live claim, or a request of another project addressed to
    this connection: `COWORK_REQUEST_UNAVAILABLE`;
  - a changed version: `COWORK_VERSION_CONFLICT`;
  - the wrong class: `COWORK_UNIT_NOT_FOUND`; an exact grant for the wrong
    role is refused at creation with 404;
  - extra or missing payload fields: `INVALID_INPUT`;
  - a changed source: `COWORK_SOURCE_UNAVAILABLE`;
  - an expired request: `COWORK_REQUEST_EXPIRED`;
  - already claimed: `COWORK_REQUEST_CLAIMED`;
  - declined or resolved: `COWORK_REQUEST_CLOSED`;
  - superseded: `COWORK_REQUEST_CLOSED`;
  - a `cowork.claim` or `cowork.request.respond` grant used for a claim:
    `AGENT_EXECUTION_UNAVAILABLE`.
- **Respond:**
  - unclaimed: `COWORK_REQUEST_NOT_CLAIMED`;
  - a wrong lease, or a request claim lost through a unit re-claim:
    `COWORK_CLAIM_LOST`;
  - a changed version: `COWORK_VERSION_CONFLICT`;
  - an invalid reason, mixed fields, a non-object response or an unknown
    outcome: `INVALID_INPUT`;
  - a missing, GitHub or stale-version response: `COWORK_RESPONSE_UNAVAILABLE`.
    The fixture had already inserted a result, and it rolled back;
  - a publication that throws, or an outer failure after the transition:
    everything rolls back;
  - a changed source refuses a resolve, while a `source_changed` decline
    succeeds and replays.
- **Supersession:** queued and deferred requests are superseded. Untouched are:
  - a claimed request;
  - another kind, another recipient unit, another sender;
  - a re-issued intent (`existing`).

  No budget is refunded.
- **Races:**
  - Supersession first: the claim waits on a `transactionid` row lock (the
    recipient slot). It then fails `COWORK_REQUEST_CLOSED`, with no debit and
    no receipt.
  - Claim first: the admission waits on the recipient slot row and supersedes
    nothing.
  - Two claims from one session: one effect, one `COWORK_VERSION_CONFLICT`,
    one debit, one receipt.

## Mutation proof

Each group was run on a detached copy of `0dd0d5cb` with the guards removed, using
only `cowork-request-responses.test.ts` (`w153c-mutate.py`, `w153c-mutrun.sh`;
not published). Within a group, each mutation affects a different test.

| Group | Guard removed | Result | Failing test and reason |
| --- | --- | --- | --- |
| A | M1: core live unit fence on request claim | 4 pass, 5 fail | Claim negative controls: a wrong lease returned the generic SQL `COWORK_REQUEST_CHANGED`, not `COWORK_CLAIM_LOST`. |
| A | M4: core "claimed under the live generation" respond rule | (same run) | Lease loss test: a respond after the unit re-claim returned `COWORK_REQUEST_CHANGED`, not `COWORK_CLAIM_LOST`. |
| A | M5: in-transaction response readability | (same run) | Respond negative controls: `Missing expected rejection: COWORK_RESPONSE_UNAVAILABLE`; the missing response was accepted. |
| A | M6: supersession includes `claimed` | (same run) | Supersession test: the claimed request was also superseded. Claim-first race: `a claimed request is never superseded`. |
| B | M2: request addressing (recipient connection/unit) | 7 pass, 2 fail | Claim negative controls: a request to another unit reached the SQL update (`COWORK_REQUEST_CHANGED`) instead of `COWORK_REQUEST_UNAVAILABLE`. |
| B | M8: post-state hook `claimed_generation` check | (same run) | Lease loss test: `Missing expected rejection: COMMAND_POSTSTATE_STALE`; the claim receipt replayed after the unit re-claim. |
| C | M3: "already claimed under the live generation" rule | 8 pass, 1 fail | Claim negative controls: `COWORK_REQUEST_CHANGED` instead of `COWORK_REQUEST_CLAIMED`. |
| D | M9: request reference readability on claim | 8 pass, 1 fail | Claim negative controls: `Missing expected rejection: COWORK_SOURCE_UNAVAILABLE`; a request with a changed source was claimed. |
| E | M7: supersession key without `kind` | 7 pass, 2 fail | The `help` request superseded the pending review, and the supersession test superseded the wrong set. |
| F | M10: the slot row lock in the shared unit lock path | 7 pass, 2 fail | Both claim/supersession races: the waiter blocked on `advisory` (the project graph lock) instead of `transactionid` (the slot row). |
| G | M1 + M11: both layers of the unit fence (core and SQL) | 8 pass, 1 fail | Claim negative controls: the unclaimed-unit claim was not refused with `COWORK_CLAIM_LOST`. It reached the update and was stopped only by the 0035 table CHECK `claimed_generation > 0`, as a raw constraint error. |

In group D's shell wrapper, the slot helper process exited with 137 after the
test run and its Compose cleanup had completed. The log contains the full
result and the cleanup lines.

The single-layer core mutations (M1–M4) still have the conditional SQL fence
as a second layer. The tests fail because they assert the specific domain
code, not a generic change. M1+M11 removes both layers of the unit fence.

The table CHECK only stops a claim on a *never-claimed* unit (generation 0).
It is not a general third layer: with both layers removed, a wrong lease on a
claimed unit would write. The mutation runs used `0dd0d5cb`; `725ee900` adds
only tests.

## Remaining for #153

- The production response publisher (#154 actor primitive), its grant, and
  the final event flush.
- Scheduling; the checkpoint producer; reviewer and checkpoint claim
  eligibility.
- The #238 lifecycle/use fence and the #74 GitHub recipient adapter.
- Authorized unit creation (units are still fixture rows).
- MCP exposure and #160 Start/Resume; real two-owner/three-connection clients.
- The Agents UI (#136), device evidence and release evidence.
