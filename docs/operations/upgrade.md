# Upgrade

```sh
git pull --ff-only && ./flux upgrade      # or: ./flux upgrade --pull
```

`./flux upgrade` (issue #123) moves this checkout's instance to the code in the checkout:

1. It asks for confirmation (`-y` answers yes) and reads the current schema from the database.
2. **Backup.** It runs [`./flux backup`](backup-restore.md) into `backups/` (or `--output
   DIR`), with one difference: API and worker **stay stopped** after the backup. Nothing can be
   written between the backup and the new version, so going back to the backup loses nothing.
3. **New version.** With `--pull` it runs `git pull --ff-only` and continues in the pulled
   launcher. It builds the image from the checkout (`FLUX_NO_CACHE=1` for a clean build).
   Release images (#77) are not published yet; when they are, this step can pull them instead.
4. **Migrate forward.** `files-init`, then the one-shot migration applies every new
   `packages/db/migrations/NNNN_*.sql` in order, each in its own transaction.
5. **Health.** It starts API and worker, waits for their health checks, and checks that the API
   and the database report the checkout's schema.

The downtime is the backup, the build and the migration. It prints
`Upgraded <project> from schema A to B` and keeps the backup.

## When it fails

If the build, migration, start or health check fails, the API and worker stay stopped and it
prints how to go back, for example:

```text
UPGRADE FAILED: the migration failed
Your data from before the upgrade is in /srv/flux/backups/flux-backup-flux-3f2a9c1d-20260928T091502Z.tar (schema 10, commit 841ddc9…).
API and worker are stopped, so nothing was written after that backup. To go back:
  git -C '/srv/flux' checkout 841ddc9…
  ./flux restore '/srv/flux/backups/flux-backup-flux-3f2a9c1d-20260928T091502Z.tar'
Or fix the cause in this checkout and run ./flux restore '…' --migrate to retry the upgrade.
```

A failed migration file rolls back its own transaction; earlier new migrations of the same
upgrade stay applied, which is why the instructions restore the backup rather than restarting
the old version on the partly migrated database.

## Verified behavior

`./scripts/check_backup.sh` starts a checkout of the **previous main's schema**: the newest
commit on `main`'s first-parent history whose set of migrations differs from this tree's
(`FLUX_UPGRADE_FROM=<ref>` picks another). Observed on 2026-09-28: with `main` at `f18c0cb`
the previous main is `705ed25` (schema 13) and the upgrade applied `0015_notifications.sql`;
an earlier run with `main` at `705ed25` started from `f1fa114`, which had `0013_docs.sql` but not
the later-merged `0011_agent_connection.sql` and `0012_agent_oauth.sql`, and applied both, so
migrations numbered below the current maximum are applied too. It seeds that version's `./flux demo`, replaces the
checkout's files with this tree (as `git pull` would, keeping `.env` and the data), checks that
`./flux upgrade` without confirmation does nothing, runs `./flux upgrade -y`, and verifies the
reported schema change, an `Applied migration` line for every migration the old version lacked,
the backup's schema, that this pre-upgrade backup (a subset of the new image's migrations) is
refused by restore without `--migrate` and restored with it, and through the API the demo conversation, DM,
private note and sketch, a new doc, and the export. It then adds a failing migration, checks that
the upgrade fails with the restore instruction for its backup, removes the migration and follows
the instruction; the demo data is verified again.
