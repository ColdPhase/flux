# Operating a self-hosted Flux

This section is for the person who runs a Flux instance started with the root
[`./flux`](../../flux) launcher (issue [#123](https://github.com/ColdPhase/flux/issues/123),
foundation 8.16). Everything runs in Docker: the launcher needs only POSIX `sh`, Docker with
Compose, `tar`, and `sha256sum` or `shasum`. It never installs PostgreSQL or Node.js on the
host and never touches another Compose project or a volume that is not this checkout's.

| Task | Command | Guide |
| --- | --- | --- |
| Back up database, files and settings | `./flux backup [--output DIR] [--keep N]` | [Backup and restore](backup-restore.md) |
| Restore a backup, here or on a new machine | `./flux restore <archive> [--migrate] [--revoke-agent-connections] [-y]` | [Backup and restore](backup-restore.md#restore) |
| Export one project as open JSON plus files | `./flux export <project> [--as EMAIL]`, `GET /api/v1/projects/:id/export` | [Project export](export.md) |
| Move to a newer version | `./flux upgrade [--pull] [-y]` | [Upgrade](upgrade.md) |
| Run a published release without the source (operators) | `docker compose --env-file docker/.env -f compose.yaml up -d --wait` | [Install from a release](install-release.md) |

Every command acts on this checkout's Compose project (`FLUX_PROJECT` in `docker/.env`) and uses the
ownership check of `./flux up`: it refuses a project that another checkout created, or one
with data but no owner record, unless `--force-project` is given. Commands that replace data
(`restore`, `upgrade`, like `reset` and `clean`) ask for confirmation; `-y` answers yes for
scripts.

Flux is in early development ([project status](../../README.md#project-status)). These tools
make local and small self-hosted instances recoverable; they are not yet a supported
production upgrade path between releases.

## Backup schedule

- **Back up before every upgrade.** `./flux upgrade` does this itself and keeps the archive.
- **Daily for an instance people use**, at a quiet time: a backup stops the API and worker for
  as long as the dump and the files archive take (seconds for a small instance), and restarts
  them. For example, a cron entry on the host:

  ```cron
  30 3 * * * cd /srv/flux && ./flux backup --keep 14 >> /var/log/flux-backup.log 2>&1
  ```

- **Copy archives off the machine.** A backup on the same disk does not survive the disk. Copy
  each `backups/*.tar` together with its `.sha256` to other storage (another host, encrypted
  object storage) and check it there with `sha256sum -c`.
- **Treat archives as secrets.** An archive holds every message, note and document, password
  hashes, session and push subscription rows, and a copy of `docker/.env` with the database password,
  the signing secret and the VAPID private key. It is written with mode `600`; keep it
  encrypted at rest when it leaves the machine.
- **After restoring an older backup**, access revoked since the backup is active again,
  including agent connections: use `--revoke-agent-connections`
  ([details](backup-restore.md#agent-connections-and-oauth-tokens)).
- **Test a restore now and then** into a second checkout (see [a fresh machine](backup-restore.md#restore-on-a-fresh-machine-or-checkout)).
  `./scripts/check_backup.sh` does exactly that on disposable copies.

## Disk hygiene

- `./flux backup --keep N` keeps the newest `N` archives of this project in the output
  directory and deletes older ones (and their `.sha256`). Without `--keep` nothing is deleted.
- Backups go to `backups/` and exports to `exports/` in the checkout by default (both ignored
  by git and by the Docker build context). `FLUX_BACKUP_DIR` or `--output` puts backups
  elsewhere, for example on a separate disk.
- A backup needs free space for about twice its size while it is written: the parts are staged
  in a hidden `.flux-backup-*.partial` directory next to the archive and removed afterwards.
- Docker keeps old images and the build cache. `./flux clean` removes this checkout's images
  (and data); `docker system df` shows the rest, and `docker builder prune --filter until=72h`
  reclaims build cache for the whole machine. Neither `backup`, `restore` nor `upgrade` prunes
  anything shared by other projects.
- The database volume grows with history (versions are never rewritten). Check it with
  `docker system df -v | grep <project>_pgdata`.
