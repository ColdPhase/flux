# #118 exact migration ledger: status and same-volume evidence

Date: 2026-10-04. Prepared by Zamojski5 (claude-maurycy) under the founder direction in
[#185](https://github.com/ColdPhase/flux/issues/185), taking over evidence work on
[#118](https://github.com/ColdPhase/flux/issues/118) (owner PelikanFix16) while he is away.
Branch `claude-maurycy/release-prep`. This is author evidence; PelikanFix16 evaluates it.

**Application under test.** The candidate in every run is a commit of this branch whose
`app/` and `docker/` trees equal `origin/main` [`662aec62`](https://github.com/ColdPhase/flux/commit/662aec62)
(after #225, migration 0045). The branch changes only `scripts/check_proactive_upgrade.sh`,
`scripts/proactive-upgrade-fixture.mjs` and documentation:
`git diff 662aec62 868de210 --stat -- app docker` prints nothing (checked 2026-10-04).

## Acceptance criteria on `main`

Line numbers are at `662aec62`.

| AC | State | Evidence |
| --- | --- | --- |
| AC-1 Unique numeric prefixes; the migrator records only the version it applied; SQL cannot add or remove another ledger row unnoticed | implemented (#130 `9d27e994`) | `app/packages/db/src/migrations/ledger.ts:12-29` (`parseMigrationManifest`: one file per prefix, strict `NNNN_name.sql`, a stale `FLUX_SCHEMA_VERSION` fails), `:58-65` (`assertMigrationSqlLedgerChange`), `:67-72` (`assertMigrationStepLedger`). `app/tooling/migrate.ts:13` (manifest), `:16` (advisory lock), `:22-34` (one transaction per file: SQL, ledger-delta check, own-version insert, step check, rollback on any error). Tests: `app/tests/app/migration-ledger.test.ts:36-42` (duplicate, invalid name, `.SQL`, version 0, stale constant), `:61-84` (legacy self-recording allowed; foreign insert or deletion rolls back). |
| AC-2 Startup and post-migration comparison with the image's files; phantom, missing and skipped files fail with an operator error; reserved gaps allowed | implemented (#130) | `ledger.ts:43-47` (`assertKnownMigrationVersions`), `:50-55` (`assertExactMigrationLedger`); `migrate.ts:18` (before applying), `:37` (after); API startup `app/apps/server/src/app.ts:63-64`; health on every request `app/apps/server/src/health/routes.ts:17` (503); worker startup `app/apps/worker/src/index.ts:15`; restore gate `app/tooling/operations.ts:39-51`. Tests: `migration-ledger.test.ts:24-34` (shipped files, embedded versions and the running database agree), `:44-52` (a lower file fills a gap), `:54-59` (phantom, missing, skipped fail even when the maximum is right). No contiguity check exists by design (AC-2 allows gaps); at the pin the files are 0001–0045 without a gap. |
| AC-3 Docker rehearsal of fresh install and same-volume upgrades in the real landing order, asserting tables and the exact set; injected duplicate and phantom fail closed | implemented for the landed order up to 0045 (this page); repeat at the release candidate | The #61-era order 0011–0020 was rehearsed in #130's review; 0021–0024 and the 0026–0032 gap fill on #118 (2026-09-29/10-02). This page adds the late arrivals 0035 and 0042 (lower than already-applied 0036–0041 and 0043–0044), 0043/0044, and 0045, plus fault injection on the upgraded volume and a schema comparison with a fresh install. Still open: 0046–0048 ([#239], [#244]) and the final candidate (T118-B), and an upgrade from a published rc (#77 T77-B). |
| AC-4 Operator action documented; check in the validation/release gate; PR and head linked | implemented (#130) | Operator steps: [application foundation, "Migration ledger mismatch"](../../../development/application-foundation.md#migration-ledger-mismatch-118); restore gate: [backup and restore](../../../operations/backup-restore.md#restore) step 3. Gates: `migration-ledger.test.ts` runs in `scripts/check_application.sh`; the health check (exact ledger) gates `up --wait` in `scripts/check_operator_compose.sh:79-92` and in the release workflow's `scripts/release/smoke_artifacts.sh:42-43`. The fast PR check `Application validation` runs only portable tests, so the database-backed ledger test is not in it. |

## What this branch adds

`scripts/check_proactive_upgrade.sh` (#58/#118), run at a committed head:

1. Row snapshots compare each table on the **baseline's columns**, so later migrations may
   add columns (0043 on materials, 0045 on messages) but not change or drop a recorded value.
   `agents` and `background_compute_connections` are now included.
2. The baseline stores an AI connection through its own API (old request shape before 0042);
   after the upgrade the candidate API must return it as 0042 defines: Anthropic,
   `claude-sonnet-5`, named "Anthropic · claude-sonnet-5", used for background comparisons,
   table price $2/$10 per 1M tokens checked 2026-09-28, original consent and key suffix
   (`scripts/proactive-upgrade-fixture.mjs`).
3. A fresh install of the candidate, migrated in order into a second database on the same
   server, must have the same `public` schema (`pg_dump --schema-only`) and ledger as the
   upgraded volume.
4. Faults injected on the upgraded volume, each required to fail with its operator error:
   phantom row 9999 (running API health 503; migrator, API and worker refuse);
   0035 removed from the ledger (health 503; API and worker refuse; the migrator's re-run
   fails and rolls back); an image directory with a duplicate prefix, a misnamed
   `0035-skipped_probe.sql`, or without the applied 0035 (migrator and API refuse before any
   SQL); the last file replaced by SQL that inserts ledger version 9998 (rolled back with its
   table). Afterwards the ledger is exact again, health is 200 and the retained rows equal
   their pre-fault snapshot.

## Runs

Both on 2026-10-04, Docker Desktop 29.1.2 (linux/arm64), each in its own Compose project,
ports and volumes, through the shared Docker slot wrapper; projects, volumes and image tags
were removed by the script afterwards. Trailing whitespace was stripped from the `.txt` logs
before [`sha256.txt`](sha256.txt) was written. Command:
`TMPDIR=<scratch> FLUX_UPGRADE_FROM=<baseline> FLUX_PROACTIVE_UPGRADE_PORT=<port> ./scripts/check_proactive_upgrade.sh`
at branch commit `868de210` (candidate; `app/` and `docker/` equal `662aec62`).

| Baseline | Baseline ledger | Applied to the existing volume, in this order | Result | Log |
| --- | --- | --- | --- | --- |
| `63a5c6b5` (#215, main just before #166) | {1–34, 36–41, 43, 44} | 0035 and 0042 (below already-applied 0036–0041, 0043, 0044), then 0045 | **pass** | [upgrade-from-63a5c6b5.txt](upgrade-from-63a5c6b5.txt) |
| `cbdf7e11` (#168, main before #193) | {1–34, 36–41} | 0035, 0042 (gap fills), 0043, 0044, 0045 | **pass** | [upgrade-from-cbdf7e11.txt](upgrade-from-cbdf7e11.txt) |

In both runs:

- the ledger went to exactly {1–45}; the PostgreSQL volume's creation time did not change;
- the 18 snapshots on baseline columns are equal before and after, including `project_messages`
  after 0045's new column and constraint and, from `cbdf7e11`, `project_materials` and
  `project_material_versions` after 0043;
- through the candidate API: the original session, material revisions, the historical
  citation, the private draft, work/decision/result links, the baseline AI connection exactly
  as 0042 defines it, a new rule and connection, enablement refused at
  `BACKGROUND_RUNTIME_UNAVAILABLE`, and manual work;
- a second `migrate` and restart left the ledger unchanged;
- a fresh install of the candidate has the same `public` schema (2839 DDL lines, empty diff)
  and the same ledger;
- all 14 faults were refused with the expected operator error (phantom row: health 503,
  migrator, API, worker; unrecorded 0035: health 503, API, worker, migrator re-run; duplicate
  prefix: migrator, API; misnamed file: migrator; image without applied 0035: migrator, API;
  foreign ledger insert: migrator, rolled back with its table); afterwards the ledger was exact,
  health 200 and the retained rows equal to their pre-fault snapshot.

Earlier attempts, kept out of the repository: the first run (candidate on `6f742eba`, before
#225) stopped in the fixture because the new rule asked for 3 runs a day while the baseline
connection allowed 2, so enablement correctly answered `BACKGROUND_BUDGET_TOO_LOW` (fixture
fixed in `4c659eb7`); a run at `4c659eb7`, before the schema comparison existed, passed.

### Backup, restore and upgrade (`check_backup.sh`)

Queued at the time of this commit; the result is added when the run finishes.

## Not covered here

- No negative control shows the schema comparison catching a difference; it is a plain
  `diff -u` of two `pg_dump --schema-only` outputs that both contained 2839 lines.
- 0042 also adds required columns to `personal_runs` and `proactive_comparison_proposals`.
  The baselines had no rows there (creating them needs a provider dispatch), so those
  rewrites are covered only by the SQL-level arrival test `app/tests/app/ai-connections-migration.test.ts`
  (column shape) and not by real rows.
- Migrations 0046–0048 in [#239] and [#244], the final release candidate (T118-B), an
  upgrade from a published rc (#77 T77-B), and amd64.


[#239]: https://github.com/ColdPhase/flux/pull/239
[#244]: https://github.com/ColdPhase/flux/pull/244
