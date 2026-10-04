# Co-work claims and checkpoint storage — partial #153 evidence

Tested source: `4ca13c9d07a603f897d213a27c6916b3fecee1ce`, 2026-09-30 UTC.
Owner Zamojski5; independent eligible final evaluator PelikanFix16. PR166 remains
draft. [Contract](../../../development/cowork-coordination.md),
[issue](https://github.com/ColdPhase/flux/issues/153). All original AC1–5 remain.

## Executed checks

| Check | Result and actual scope |
| --- | --- |
| `docker build -f docker/Dockerfile --target test -t flux-cowork-storage:flux153-storage app` | PASS, build/typecheck/lint. |
| Isolated PostgreSQL migration through `node tooling/dist/migrate.js` | PASS, exact shipped001–025 +0035 ledger, schema35 and pg-boss43. Reserved absent026–034 are not claimed implemented. |
| `pnpm exec tsx --test --test-concurrency=4 tests/app/cowork-storage.test.ts tests/app/cowork-claims-core.test.ts tests/app/architecture.test.ts tests/app/migration-ledger.test.ts` in Docker on that database | **39/39 PASS**, 3.348s; no skips/cancellations. |
| `FLUX_TEST_PORT=19051 FLUX_TEST_MAILPIT_PORT=19052 ./scripts/check_application.sh` | **Complete command PASS**, terminal41766 exit0:357/357 application/core/API/SQL tests,53.103s;3/3 PWA;1/1 browser access; stored-session restart;1/1 Push-unavailable;1/1 SMTP-unavailable. Its own temporary project was cleaned by the configured script. |
| `python3 scripts/check_agent_setup.py`, `python3 -m unittest discover -s tests -p 'test_*.py'`, `git diff --check` | PASS, shared setup/local links,34 standard-library tests and whitespace. |

Storage checks use real PostgreSQL transactions and observed blocking PIDs.
They cover one connection's capacity across sessions/projects/roles, independent
connections, persisted DB expiry as receipt post-state, renewal waiting through
expiry, old versions/generations/leases/sessions, checkpoint association,
expired effect rollback, native associations/correlation uniqueness/JSON bound,
revocation versus checkpoint commit, lifecycle rollback, connection deletion
with retained progress and unchanged completed history. Replay core checks
reject changed post-state and recheck historical checkpoint readability.

The initial focused run was **34 PASS /2 FAIL** because two assertions matched
the outer Drizzle message instead of the actual PostgreSQL cause. They now
check SQLSTATE23503/23505/23514. That failed log is retained separately; it is
not counted as a pass. The complete corrected run includes the added lifecycle
tests and passed on its first execution.

Independent read-only source review found restrictive historical connection
FKs and missing SQL checkpoint associations. Both were fixed and re-reviewed
without remaining reported findings. That source review did not run these SQL
tests and is not eligible whole-issue peer acceptance.

## Remaining delivery

There is no integrated #152 current authorization/shared receipt/grant-use UoW,
#154 actor-aware publication/final event flush, addressed request/outbox/recovery,
public MCP endpoint, supported-client scheduler or final #136 UI in this increment.
The storage revocation race takes the required connection SHARE lock in a test;
it does not establish the still-pending actual runtime/grant adapter. Bulk
multi-connection lifecycle transactions may require whole-transaction deadlock
retry. Missing credentials never become authority through historical IDs.

Real two-owner/three-connection Start/Resume, loaded instructions, busy-peer
scheduling, actual provider/review bridge, cursor retention/recovery, immutable
authorship, export/import inert history, both dependency migration arrival orders
and the complete original acceptance remain required. Browser PWA checks do not
prove real Android/iPhone/iPad installation or notification delivery. No full
product/release completion follows from this backend evidence.

## Reproducibility

[Source and local-log hashes](source-sha256.json) pin actual inputs. Logs remain
on the author's host: `/tmp/flux153-storage-build-final.log`,
`/tmp/flux153-storage-tests-final.log`, `/tmp/flux153-storage-application.log`,
and `/tmp/flux153-storage-tests-initial-failed.log`. The isolated storage image
ID was `sha256:386ac12f3b1c058e83c22c727f07b0d6565797e2425d4ea22b3b8a039e1c2f66`.
No host application dependencies or services were installed. The full check
uses the repository's pinned Docker/Compose stack and default query timeouts;
no retry conceals an application failure.
