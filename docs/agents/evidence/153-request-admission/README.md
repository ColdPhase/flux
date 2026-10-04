# Live request admission and recipient ordering (#153)

Tested runtime: `72367b38` (tree `d9898de32e13186951248790ae0304c20ad57df8`), branch
`claude-maurycy/153-request-admission`, based on protected main `d94f70e4`.
This commit adds only this documentation. Owner: Zamojski5. Independent
evaluation by PelikanFix16 is still required. Original AC1–AC5 stay open.
No public MCP action, client scheduling or UI is enabled. See the [plan](PLAN.md)
and the [contract section](../../../development/cowork-coordination.md#live-request-admission-2026-10-04-peer-review-required).

## What changed

- `app/apps/server/src/co-work/requests.ts` — `coWorkRequestInTransaction`
  composes #152's reserved `cowork.request` in the caller's transaction:
  1. #152 `prepare`;
  2. sorted sender and recipient slots;
  3. #171 graph locks;
  4. the complete sorted task set and the units;
  5. request storage;
  6. the `cowork.request_state` post-state hook;
  7. #152 `complete` (one debit and one receipt).

  Refusals throw inside the transaction, so nothing is persisted.
- `app/packages/core/src/co-work/admission.ts` — pure rules:
  - a strict `{ generation, leaseId, request }` payload;
  - the sender's live fence (state, generation, lease, runtime session, fresh DB time);
  - no self-addressing;
  - a live recipient connection and unit in the same canonical lineage;
  - GitHub references refused;
  - optional `distinct_owner` review separation.
- `app/packages/db/src/repositories/cowork-admission.ts` — the lock order, and
  slot inserts only for real connections in the workspace. Also the current
  readability of references at exact versions, and the canonical reads for
  the post-state hook.
- `app/packages/db/src/repositories/cowork-recovery.ts` — the reference rule is
  parameterized as `readableReferenceSet`. The recovery query is parameterized
  with the same column fragments, and the existing recovery tests pass unmodified.
  The generated SQL text was not diffed.
- `app/apps/server/src/co-work/graph.ts` — the production #171 lock provider
  (`lockProjectTaskGraphs` + `taskPrerequisiteIds`). It is shared by admission,
  and the claim policy can use it.
- `app/apps/server/src/co-work/grants.ts` — an exact `cowork.request` grant
  target is the sender's own unit with its actual role.

## Executed checks (Docker, isolated Compose projects, ports 19021–19028)

- **Image build, typecheck and lint** (`pnpm build && pnpm typecheck && pnpm lint` inside the
  image) pass. One pre-existing warning remains: `react-hooks/exhaustive-deps` in
  `apps/web/src/work/ProjectTasks.tsx`. That file is untouched; the warning is not an error.
- **New admission tests** at `1cf46f52` (run before an amend that changed only the commit message; identical tree `9ea4d9987a1489b83c48fb748244f3a415e3f14a`): `cowork-admission.test.ts`, **6/6**.
- **Affected set** at `72367b38`: 13 files, **102/102**, with 0 skipped, cancelled or todo.
  - The files are `cowork-admission`, `cowork-claims-core`, `cowork-execution`,
    `cowork-migration-arrival`, `cowork-recovery`, `cowork-requests-storage`,
    `cowork-storage`, `agent-execution-core`, `agent-execution`, `architecture`,
    `task-graph-core`, `mcp-work-actions` and `oauth-mcp`.
  - Existing recovery, storage and claim assertions are unchanged.
- **Full `./scripts/check_application.sh`** at `72367b38`: **EXIT 0**.
  - API: **661/661**, 0 skipped.
  - Every later browser/service phase passed: 3+1+1+1+1+6+1+1+1+1 = 17 tests.
    They cover PWA, access stream, actors, consent, restart and the unavailable
    Push/SMTP paths.
- **Foundation:** `check_agent_setup.py` passed. The host Python suite ran 67 tests,
  all OK. `git diff --check` is clean.
- Raw logs stay local (`w153-t2`, `w153-t4`, `w153-full`, `w153-mut`, `w153-mut2`) and
  are not published. The first affected-set attempt (`w153-t3`) passed no test
  files: zsh did not split the argument list, so the test runner found no files.
  That run is retained as an invocation error, not a test result.

## Negative controls proven by mutation

A detached copy of `1cf46f52`'s tree (`9ea4d998`) plus the strengthened F2 test (`w153-mut`) removed three guards:

- **M1:** only the sender slot is locked.
- **M2:** the lineage check is removed.
- **M3:** the sender fence is removed.

`cowork-admission.test.ts` against that copy: **6 tests, 3 pass, 3 fail**, each
for the intended reason:

| Guard removed | Failing test and reason |
| --- | --- |
| M3 sender fence | Sender fence test: `Missing expected rejection: COWORK_CLAIM_LOST`. |
| M2 lineage guard | Routing test: admission was not refused as unavailable. It failed later with `COMMAND_POSTSTATE_STALE`, because the post-state hook's lineage check rejected it. |
| M1 recipient slot | F2 test: B waited on `advisory` (the project graph lock) instead of `transactionid` (the recipient slot row). |

The first mutation run, before the F2 assertion was strengthened, passed F2
under M1. Two admissions in one project are also serialized by #171's project
graph advisory lock, so the test now asserts that B waits at the earlier
recipient slot row. The raw-storage control separately reproduces the
late-commit gap without either lock: the continuation from B returns only D,
and A, which committed earlier but has an older timestamp, is skipped.

## Remaining for #153

Not covered by this slice:

- Request claim, resolution and supersession; scheduling.
- Checkpoint producer and schema; reviewer and checkpoint claim eligibility.
- Native fenced publication and the final event flush.
- The #238 lifecycle/use fence.
- The #74 recipient adapter for GitHub references.
- MCP exposure and #160 Start/Resume.
- Real two-owner/three-connection supported clients.
- The Agents UI, device evidence and release evidence.

Units are still inserted by fixtures; no authorized unit creation command
exists yet. Re-issuing an existing intent under a new command ID returns the
existing request and delivery intent, but spends one grant use, as the contract states.
Trusted bearer fixtures are not proof of client integration.
