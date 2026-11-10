# Upgrade

```sh
git pull --ff-only && ./flux upgrade      # or: ./flux upgrade --pull
```

**v0.1 is not upgraded.** v0.1.0 had no users, so Flux v0.2 converts none of its data. If the instance was
written by v0.1, `./flux upgrade` refuses it and tells you to install v0.2 fresh: [see below](#from-v01-install-v02-fresh).
Everything else on this page is for an upgrade from one v0.2 version to a later one.

`./flux upgrade` moves this checkout's instance to the code in the checkout:

1. It asks for confirmation (`-y` answers yes) and reads the current schema from the database.
2. **Backup.** It runs [`./flux backup`](backup-restore.md) into `backups/` (or `--output
   DIR`), with one difference: API and worker **stay stopped** after the backup. Nothing can be
   written between the backup and the new version, so going back to the backup loses nothing.
3. **New version.** With `--pull` it runs `git pull --ff-only` and continues in the pulled
   launcher. It builds the image from the checkout (`FLUX_NO_CACHE=1` for a clean build).
   A release installation pulls the release's image instead ([upgrade a release](release-guide.md#upgrade)).
4. **Migrate forward.** `files-init`, then the one-shot migration applies every new
   `app/packages/db/migrations/NNNN_*.sql` in order, each in its own transaction.
5. **Health.** It starts API and worker, waits for their health checks, and checks that the API
   and the database report the checkout's schema.

Docker Engine 25 or newer is required (the health checks need `start_interval`; `docker compose up` refuses an older
engine, see [requirements](requirements.md#software)). The launcher checks it before it starts. Update the engine **before**
an upgrade, because a launcher that finds an old one after the backup has stopped API and worker reports `UPGRADE FAILED`
with the way back.

The downtime is the backup, the build and the migration. It prints
`Upgraded <project> from schema A to B` and keeps the backup.

The image checks the database's migration ledger before it migrates: every recorded version must
be a file of the image. If it refuses, keep the backup and restore its matching image and database.
Do not edit the ledger or rename a migration to make the check pass.

Schema history: v0.1's schema is the baseline migration `0001_v0_1_baseline.sql` (#779) and
`0002_first_time_user.sql` (#806), schema version 2. v0.2 starts with `0003_one_company_spaces.sql`, and later versions
add `0004` onwards. Development databases from before the baseline (pre-release builds) cannot be upgraded either: remove
them with `./flux clean` and start again.

## From v0.1: install v0.2 fresh

v0.1 had no users, so v0.2 converts no data and keeps no compatibility with it (founder direction, 2026-11-09, #1176). A
v0.1 instance carried over by migration would hold its old workspace but **no company**, and one Flux is one company: nobody
could reach Settings › Company, invite links or the list of spaces. So v0.2 refuses a v0.1 database everywhere it could meet one,
and changes nothing:

| Where | What happens |
| --- | --- |
| `./flux upgrade` | Reads the database's schema and, for a v0.1 database, stops **before** the confirmation, the backup and the stop of API and worker. It prints that the database was written by Flux v0.1, that v0.2 does not upgrade it, and what to do instead. Your data is as it was. |
| `./flux upgrade --pull` started by a v0.1 launcher | The old launcher does not know, so it takes its backup and stops API and worker first. The pulled v0.2 launcher then stops before it builds anything: `UPGRADE FAILED: the database was written by Flux v0.1, which v0.2 does not upgrade`, with the usual way back (check out the v0.1 files and `./flux restore` the backup). |
| `./flux up`, `docker compose up`, a [release install](install-release.md) | The one-shot `migrate` service refuses before any migration file runs: `FLUX_V01_DATABASE This database was written by Flux v0.1 (schema 2). Flux v0.2 does not upgrade it …`, exits 1, and API and worker do not start. Compose has replaced v0.1's API and worker by stopped containers by then, so v0.1 is down until you check out its v0.1.0 files and run `./flux up`. The data is untouched. |
| `./flux restore` | Refuses a v0.1 backup with and without `--migrate`, before it replaces any data. Restore it with a v0.1 checkout. |

A v0.1 database is one whose migration ledger stops before `0003` and that holds an account or a workspace. A first
installation that was interrupted after `0002` and before anybody signed up is not refused: it migrates on.

What to do:

1. **Keep what you need.** Using v0.1, `./flux export <space>` writes a space as open JSON plus files
   ([export](export.md)) and `./flux backup` an archive of the whole instance. Neither v0.1 nor v0.2 can import an export, so
   it is for reading and keeping; the backup restores only on a v0.1 checkout.
2. **Install v0.2 fresh.** Either in a new folder, with its own `FLUX_PROJECT`, volumes and port
   ([installation](install.md), or [from a release](install-release.md)), or in the same folder after `./flux reset`, which
   deletes this instance's data after you confirm. Do not point v0.2 at v0.1's volumes.
3. **Sign up first.** The first account on the new Flux sets up the company and owns it, then invite everyone else.

## When it fails

If any step fails, the launcher stops the API and worker, confirms that both are stopped, and
prints how to go back. What it says about your data depends on how far the upgrade got:

- **Before the new version started** (build, files volume or migration failed): the writers were
  stopped since the backup, so nothing was written after it.
- **After the new version started** (start, health or schema check failed): the new API and worker
  may have accepted work between the start time it prints and the failure. That work is not in the
  backup, and restoring the backup discards it; take another `./flux backup` first if you need it.
- **If a writer cannot be stopped**, it says so and names it; stop it yourself before restoring.

```text
UPGRADE FAILED: the migration failed
Your data from before the upgrade is in /srv/flux/backups/flux-backup-flux-3f2a9c1d-20260928T091502Z.tar (schema 10, commit 841ddc9…).
API and worker stayed stopped since that backup, so nothing was written after it.
To go back:
  git -C '/srv/flux' checkout 841ddc9…
  ./flux restore '/srv/flux/backups/flux-backup-flux-3f2a9c1d-20260928T091502Z.tar'
Or fix the cause in this checkout and run ./flux restore '…' --migrate to retry the upgrade.
```

A failed migration file rolls back its own transaction; earlier new migrations of the same
upgrade stay applied, which is why the instructions restore the backup rather than restarting
the old version on the partly migrated database.

## Tested with

`./scripts/check_backup.sh` starts the previous version (the newest `main` commit with other migrations since v0.2's first
one, `0003`, or `FLUX_UPGRADE_FROM`; before such a commit exists, this tree, upgraded to this tree plus one synthetic next
migration), seeds it, upgrades it with `./flux upgrade -y`, and checks the applied migrations, the backup it made and the data
through the API. It then adds a failing migration, checks that the upgrade fails with the restore instructions above, and
follows them. With `FLUX_UPGRADE_FROM=v0.1.0` it starts v0.1.0 with its demo instead and checks the refusals of the table
above: `./flux upgrade`, the migrator and `./flux restore` refuse it with the plain message, write no backup, change nothing,
and leave v0.1 running at schema 2. `FLUX_BACKUP_CASES=upgrade` runs only this part. The refusal itself is also covered by
`app/tests/app/migrate-v01-database.test.ts` (the real migrator and the restore gate on a scratch database that holds what
v0.1 wrote) and `app/tests/app/migration-ledger.test.ts`.
