# Upgrade compatibility

Founder direction, 2026-11-10 ([#1241](https://github.com/ColdPhase/flux/issues/1241)): an instance installed from **any release
from v0.2.0 on** upgrades to **any later release** without problems. Its data, files, settings, agents, encrypted spaces and sessions
stay, by `./flux upgrade` (a source checkout) or by the release's upgrade steps (a release installation). v0.1 is excluded: it
had no users, and v0.2 refuses it ([#1176](https://github.com/ColdPhase/flux/issues/1176)). The operator's side, including the
list of versions that upgrade to which, is [Upgrade](../operations/upgrade.md); this page is for the people who change Flux.

## What you must do when you change the schema

1. **Add a migration, never edit one that a release holds.** `app/packages/db/migrations/NNNN_*.sql` that is in a release tag is
   frozen: its bytes, its name and its number. Take the next free number above the highest released one (check `origin/main` and the
   open pull requests). A fix of a released migration is a new migration. `scripts/release/check_released_migrations.py` fails the
   pull request that edits, renames or deletes a released file, or numbers a new one at or below the highest released number.
2. **Write it for every earlier release's data.** Test the migration on the data of v0.2.0 (the oldest release that is upgraded) and
   of the newest one, not on an empty database: a constraint, a `NOT NULL` column without a default, a `UNIQUE` index, a foreign key
   or a changed type must hold for rows that earlier releases wrote, so the migration backfills or repairs them first. A column the
   old data lacks needs a value for every old row. A migration that passes on an empty database and fails on a release's data is
   exactly what the matrix finds (below).
3. **Keep it plain SQL.** A migration does not call, import or assume application code (a TypeScript function, a constant, a table that
   only the application creates, an extension the image may stop shipping), because the release that runs it may be several releases
   after the code it was written beside. Whatever a backfill needs, it computes in SQL from the rows.
4. **Do not rename or remove a setting silently.** Add a line to `docker/env-changes.txt` in the release that does it
   (`rename OLD NEW` or `remove NAME reason`), and name it in the release notes. A new setting has a
   default that keeps the old behaviour, and a new variable of `compose.yaml` is written `${NAME:-default}` unless it is required
   on purpose.
5. **Skipping and downgrading.** Migrations are applied in numeric order, each in its own transaction, from whatever the instance's
   ledger says, so a release that is two versions later gets the same history as one that took the steps. A downgrade is not
   supported and has no tests; the way back is the backup the upgrade took.
6. **A release adds its fixtures.** After a release is published, add the database it was dumped from (below) and the row of
   [Upgrade](../operations/upgrade.md#which-versions-upgrade-to-which).

## The checks

| Check | Where | What it proves |
| --- | --- | --- |
| `scripts/release/check_released_migrations.py` and `tests/test_released_migrations.py` | Repository checks (every pull request; the checkout fetches the release tags) and the first step of the matrix | Every migration file of every release from v0.2.0 on is byte-identical to the file of its tag; a new migration is numbered after the last released one. A clone without the tags fails in Actions rather than passing unchecked. |
| `app/tests/app/released-databases.test.ts` | `./scripts/check_application.sh` | The real migrator (`node tooling/dist/migrate.js`, as the `migrate` service runs it) runs on a database dumped from each release (`app/tests/app/fixtures/released-databases/<tag>.sql.gz`), applies every later migration, ends on the exact ledger of the files, loses no row of a content table and is a no-op the second time. |
| `./scripts/check_upgrade_matrix.sh` | Release acceptance ([evaluation](../agents/evaluation.md#at-release-acceptance)) and the `upgrade` job of `final-release.yml` | Every published release from v0.2.0 on upgrades to the candidate, by release installation and by source checkout, with the data below read back and new work accepted. |
| `scripts/release/smoke_artifacts.sh` | The `package` job of `final-release.yml` | Leg 1: a clean install of the packaged Compose files (`flux.tar.gz`'s `docker/compose.yaml` with the images of its `docker/release.env`), with its default settings and no overlay (the owner's `./flux` path is `scripts/release/smoke_launcher.sh`), with a backup and restore. Leg 2: the upgrade from the **previous** release to the candidate's own assets and image digest, with a backup and restore of both sides. Only leg 2 (and 3) sets the agents' switches and adds the provider mock. |
| `./scripts/check_backup.sh` | Backup and restore acceptance | `./flux upgrade` from the previous source version, the failing migration's restore instructions, and the v0.1 refusal. |

## The upgrade matrix

`./scripts/check_upgrade_matrix.sh` runs in Docker on throwaway projects (`FLUX_MATRIX_PORT`, `FLUX_MATRIX_PROJECT`) through the shared
slot limiter and publishes nothing. It builds the working tree into the candidate image, pushes it by digest to a throwaway registry on
127.0.0.1 and renders it into release assets with `scripts/release/prepare_assets.py`, as `scripts/release/dry_run.sh` does; or it takes
the workflow's `release-assets` (`FLUX_MATRIX_CANDIDATE_ASSETS`). For each published release before the candidate:

- **Release installation.** `gh release download` fetches the release's own assets (`FLUX_MATRIX_RELEASES_DIR` supplies them offline), checked
  against `SHA256SUMS`; the release is installed from its `compose.yaml` and `env.example`, its image by digest. `scripts/release/smoke_data.py seed`
  fills it through the public API with: the company; a member and a guest who joined by invite links; a restricted space that holds both and
  a thread of three people with a file attached; a direct message with a thread reply and a group conversation; a wiki page of three versions by
  two people; a map with three thoughts and two links; three tasks with due dates, one waiting for another and one for a person; notification
  settings with a muted space; a second signed-in device; an encrypted space with a message, locked; an owner AI connection with an API key, an
  agent with instructions, two remembered things, a weekly schedule and a switched-off one, and one agent run that completed. The agents run on
  `scripts/release/provider_mock.mjs`, an OpenAI-compatible service that `scripts/release/provider-mock.compose.yaml` adds to the release's own
  Compose file, as the release guide's "Agents on your own AI key" file adds the key. `smoke_data.py` uses only routes that v0.2.0 has, because it
  seeds the previous release; when v0.2.0 is no longer a "from" release, that is relaxed in the same change.
- The release is backed up (paired, writers stopped) and upgraded with the release guide's steps. `smoke_data.py verify --write` then reads
  every recorded item back (explicit fields, never whole responses), checks that the second device's session cookie still works, that the
  encrypted space unlocks with its password and reads, that the weekly schedule has three next times a week apart and ahead of now and the
  switched-off one none, and writes new work: a message of each kind, a wiki version, a task, a message in the encrypted space and a new
  agent run answered by the mock. The ledger must equal the candidate's files, every content table's rows must be unchanged, and no volume may
  be recreated. The upgraded instance and the pre-upgrade backup are restored into fresh volumes and read back.
- **Source checkout.** The release's tree (`git archive <tag>`) is started with `./flux up`, seeded, replaced by the candidate's tree (as `git pull` would,
  keeping `docker/.env`), moved with `./flux upgrade -y`, read back and written to.
- Every release goes straight to the candidate: with two or more earlier releases the older ones are the skip-version case.
- A leg that is switched off (`FLUX_MATRIX_SOURCE=0`, `FLUX_MATRIX_RELEASE_INSTALL=0`) is listed as `SKIPPED` in the result, the run says
  `NOT THE FULL MATRIX`, and it writes no list of tested releases, so the release workflow, which needs that list, fails instead of claiming an
  upgrade that did not run.

Once, against the oldest release: a migration that works on an empty database and fails on the data of a release
(`ALTER TABLE project_messages ADD CONSTRAINT … CHECK (false)`) is mounted into the candidate's `migrate` service. The upgrade must stop, `migrate` must
fail naming it, API and worker must not start, the ledger must lack it, and the paired backup taken with the old release's files must restore into fresh
volumes and read back and accept new work.

### Negative controls

Each failure the checks exist for makes them fail. `FLUX_MATRIX_CONTROL=edited-migration ./scripts/check_upgrade_matrix.sh` changes a released
migration in a copy of the tree and succeeds only when `check_released_migrations.py` refuses it; `FLUX_MATRIX_CONTROL=old-data` adds the
migration above to the upgrade of the oldest release and succeeds only when that upgrade fails at it. `tests/test_released_migrations.py` edits, deletes,
renumbers and lets two releases differ in a throwaway repository, and `tests/test_release_smoke_artifacts.py` loses each kind of content in turn.
`app/tests/app/released-databases.test.ts` runs a migration that fails on a release's data against the same dumps.

## Adding a release's fixture

After a release is published: `FLUX_MATRIX_DUMP_DIR=app/tests/app/fixtures/released-databases FLUX_MATRIX_ONLY=<tag> ./scripts/check_upgrade_matrix.sh` writes that release's
seeded database (`pg_dump --inserts`, without owners; about 75 KB compressed) beside the others; commit it with the row in
[Upgrade](../operations/upgrade.md#which-versions-upgrade-to-which). Nothing in a dump is secret: it holds a throwaway account and random passwords.
