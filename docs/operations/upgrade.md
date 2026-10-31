# Upgrade

```sh
git pull --ff-only && ./flux upgrade      # or: ./flux upgrade --pull
```

`./flux upgrade` moves this checkout's instance to the code in the checkout:

1. It asks for confirmation (`-y` answers yes) and reads the current schema from the database.
2. **Backup.** It runs [`./flux backup`](backup-restore.md) into `backups/` (or `--output
   DIR`), with one difference: API and worker **stay stopped** after the backup. Nothing can be
   written between the backup and the new version, so going back to the backup loses nothing.
3. **New version.** With `--pull` it runs `git pull --ff-only` and continues in the pulled
   launcher. It builds the image from the checkout (`FLUX_NO_CACHE=1` for a clean build).
   Release images are not published yet; when they are, this step can pull them instead.
4. **Migrate forward.** `files-init`, then the one-shot migration applies every new
   `app/packages/db/migrations/NNNN_*.sql` in order, each in its own transaction.
5. **Health.** It starts API and worker, waits for their health checks, and checks that the API
   and the database report the checkout's schema.

The downtime is the backup, the build and the migration. It prints
`Upgraded <project> from schema A to B` and keeps the backup.

The image checks the database's migration ledger before it migrates. If it refuses a partial,
mixed or unsupported footprint, keep the backup and restore its matching image and database. Do not edit the ledger or rename a migration to make the check pass.

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

`./scripts/check_backup.sh` starts the previous schema of `main`, seeds it, upgrades it to this tree
with `./flux upgrade -y`, and checks the applied migrations, the backup it made and the data through
the API. It then adds a failing migration, checks that the upgrade fails with the restore
instructions above, and follows them.
