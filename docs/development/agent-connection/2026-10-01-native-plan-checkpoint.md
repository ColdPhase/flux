# Native task plan checkpoint

Verified 2026-10-01 at tested head `fad6afb059a4b1694bbbdf1dfd89124f54a64577`
(production source unchanged since `7cb735fd21b96e5466f276d898d668a6ccb223a0`; later
commits change only tests and documentation), branch `codex-hubert/152-native-plan`,
stacked on PR #167's head `7f9bc63285b1ff0a5a15f85c0bfccc56b2873b36` (no PR yet; it is
opened after #167 merges). This records a partial #152 implementation (AC-2's native
task slice) for the
[native-plan contract](2026-10-01-native-plan-contract.md#implemented-at-the-native-plan-slice),
not whole-issue acceptance. This note and the two screenshots below are added after that
tested head and change no code.

## What was exercised

- Pure rules (`tests/app/task-graph-core.test.ts`, 8 checks): criteria/dependency/intent
  bounds and normalization, lock-order normalization, the bounded direct-prerequisite
  reader, cycle walk (self, direct, indirect, 300-task chains, early stop, safety limit),
  start eligibility for every state, the plan-intent decision and the canonical
  creation fingerprint.
- API and persistence (`tests/app/task-plan.test.ts`, 15 checks against the real
  PostgreSQL): bounded fields and absence for earlier tasks, replacement under
  `If-Match` with an immutable intent, guessed/foreign/self/cyclic prerequisites,
  start/finish eligibility (including `createResult` finishing, parked and `not_pursued`
  prerequisites, active-task replacement), same/changed/edited/moved plan intents,
  retry fingerprints, ten concurrent planners of one intent, opposite-order and ring
  dependency writers (no deadlock, exactly the legal edges win), claim-versus-writer and
  graph-only lock waits through the exported primitives, the pinned lock key and
  ordering observed in `pg_locks`, the reader's directness/ordering/boundedness and
  lock-freedom, fail-closed missing/foreign rows, `TASK_GRAPH_LIMIT` for 1,050 direct
  prerequisites and a 1,001-task chain, permissions (viewer, outsider, removed
  contributor, agent with and without a grant), a standing-grant `work.create` through
  the #152 execution port with receipt/debit/edges/intent/notice before one final event
  flush and complete rollback before and after that flush, database constraints
  (composite foreign keys, no self edge, one edge per pair, 50 per task, criteria CHECK,
  intent key/fingerprint CHECKs, immutable intents, project removal).
- Migration (`tests/app/task-plan-migration.test.ts`): the previous ledger (0001-0038)
  applied as the migrator does, three existing tasks (open, finished with a later
  update, blocked) unchanged column for column afterwards with empty criteria and no
  edges or intents, a writer using the previous column list still works, exact-ledger
  assertions, and an idempotent second application.
- MCP reads (`tests/app/oauth-mcp.test.ts`, extended): `flux_get_work` and
  `flux_list_work` return the canonical criteria, prerequisites with state and plan
  revision for a planned task and a null plan for an earlier one.
- Browser (`tests/app/e2e/task-plan.e2e.ts`, Chromium): list hint, **Done when**,
  **Waits for** with states in words, plan link, refusal text for an unmet start,
  keyboard Enter on a prerequisite, then a start after it is done, and a phone-width
  read-only viewer with no sideways scroll and touch-sized rows.

## Failing before, passing after

- Against the production code of `7f9bc63` (new tests kept) on a fresh ledger-38
  database: `task-graph-core` fails to load (`ELIGIBLE_STATUSES` is not exported),
  `task-plan` fails to load (no `apps/server/src/work/task-graph.ts`), the migration test
  fails (there is no 0039) and the browser journey fails at its first assertion (the
  list does not say the task waits). The production files were restored byte for byte
  afterwards.
- Single mutations of the new production code, each run against the 23 core/API tests:
  graph lock a no-op fails 5 (lock pin, ring/opposite-order writers, concurrent
  planners, claim-versus-writer waits); start/finish eligibility check removed fails 5;
  cycle walk never reporting the task fails 4; plan intent always creating fails 6; plan
  revision not compared fails 1. The `ORDER BY id` of the task lock pass is a code
  guarantee only: removing it changes nothing observable, because the planner already
  returns primary-key order for these sets.

## Same-volume upgrade rehearsal

A Compose database left at ledger 38 by the production code of `7f9bc63` (three tasks
written through its API) was migrated with this branch's image: the ledger became 39
contiguously, a digest of every task column was identical before and after
(`6d45328c2be5ceea4922d04e579f3264`), no criteria, edges or intents appeared, and the
API started with the exact-ledger check. `scripts/check_backup.sh` was **not run**.

## Command outcomes

All Docker runs used this checkout, their own Compose projects and ports
(19481/19482 application, 19483/19484 browser UI) behind the shared slot limiter, and
removed only what they created.

| Check | Outcome |
| --- | --- |
| `scripts/check_application.sh` at `fad6afb` (builds, TypeScript checks, lint, then tests) | **passed, exit 0**, 4 minutes: **399** application tests (375 at #167's head plus the 24 new), then Chromium PWA/offline (3), access-stream (1), genuine task actors (1), **task-plan (1)**, agent-connection consent (1), API restart persistence, push-unavailable (1) and SMTP-unavailable (1) phases |
| Portable gate: `docker build --target test` then `--network none` `architecture.test.ts` + every `*-core.test.ts` | **56/56 passed** (includes the 8 new core checks and the unchanged architecture allowlist) |
| Focused dev-image runs while developing (`task-plan` 15, `task-graph-core` 8, `task-plan-migration` 1, `oauth-mcp` 2, plus work, task-notices, task-discussions, agent-execution, agent-project-reads, agent-proposals, export, docs, returns, return-recap, safe-writes, conversation, search, architecture, ledger/migration suites) | all passed (121/121 in one group); the final test edits were re-run and then covered by the full run |
| `tests/ui` modules `test_work_decisions` (10), `test_project_surface` (8), `test_app_shell` (17) through a trimmed `scripts/check_ui.sh` | **35/35 passed**; the whole `check_ui.sh` was not run |
| `python3 scripts/check_agent_setup.py`, 34 Python unit tests, `git diff --check` | passed |

Logs are in the author's scratch directory and are not committed; the commands above
reproduce them.

## Rendered evidence

`2026-10-01-native-plan-evidence/task-plan-desktop.png` (1280px viewport, SHA256
`a7a0a54eb099425c243b465902810aad4943e6de7ed1c45b84123589ec1c0f62`) shows the Tasks list
saying "waits for 1 task" and the open details of a planned task with **Done when**,
**Waits for** (the open prerequisite first, states in words) and the plan revision link.
`task-plan-phone-viewer.png` (390px viewport, SHA256
`ba9bf2e58ab7a3f0b739d11cdbd0d15121a6c0f287861c772b0cbc17d32fe6d7`) is a read-only viewer
after the prerequisites are done. Both come from the passing journey. Fresh independent
visual assessment is requested; screenshots establish neither interaction nor
accessibility.

## Limits

- Not run: `scripts/check_backup.sh`, any real Codex or Claude client, real Android or
  iPhone devices. Browser evidence is Chromium with real authenticated sessions and
  the real task-detail components; it is not an accessibility audit.
- The MCP action tools stay disabled and #153's claim adapter is not implemented here;
  the claim-versus-writer test uses the exported primitives directly, as #153 will.
- Project export, search indexing and a browser form for authoring criteria and
  prerequisites are not part of this slice.
- The independent functional and rendered task-detail evaluation required by the
  contract is still to be done by a reviewer who is not the author.
