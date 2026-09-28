# Backup and restore

`./flux backup` and `./flux restore` (issue #123) replace the manual steps that the
[application foundation](../development/application-foundation.md#initial-backup-and-restore)
described. Both run PostgreSQL's own `pg_dump`/`pg_restore` inside the pinned database
container and read or write the files volume through the `files-archive` helper, a one-shot
Compose service (profile `ops`) on the same pinned PostgreSQL image with no network. Nothing
runs on the host except `sh`, `tar` and a SHA-256 tool.

## Backup

```sh
./flux backup                       # backups/flux-backup-<project>-<UTC time>.tar
./flux backup --output /mnt/backup --keep 14
```

1. **One point in time.** The API and worker are the only writers. The backup stops both,
   starts the database if needed, dumps it (`pg_dump --format=custom`) and archives the files
   volume (`tar -czf` of `/data/files`) while nothing can write, then restarts them. If they
   were not running, they stay stopped, and a database that was stopped is stopped again. If
   the backup fails, a trap restarts what it stopped, and no archive is written.
2. **Archive.** One uncompressed `tar` with four parts (the dump and files archive are already
   compressed), written with mode `600`, plus `<archive>.sha256` for checking copies:

   | Part | Contents |
   | --- | --- |
   | `manifest.json` | Format, time, project, schema and app version, checksums (below). |
   | `database.dump` | `pg_dump` custom format of the whole database, including the pg-boss queue schema. |
   | `files.tar.gz` | The files volume (uploaded files; the API's own health probe files are transient). |
   | `flux.env` | A copy of `.env`: the database password, signing secret and VAPID keys that sessions and push subscriptions depend on. |

3. **Manifest** (`formatVersion` 1). One key per line, so the launcher reads it without a JSON
   tool:

   ```json
   {
     "format": "flux-backup",
     "formatVersion": 1,
     "createdAt": "2026-09-28T09:15:02Z",
     "project": "flux-3f2a9c1d",
     "schemaVersion": 13,
     "appVersion": "0.1.0",
     "appCommit": "f1fa114…",
     "checkoutDirty": false,
     "image": "sha256:…",
     "postgresImage": "postgres@sha256:77f5…",
     "postgresVersion": "18.6",
     "consistency": "api and worker stopped during dump and files archive",
     "parts": [
       {"name": "database.dump", "bytes": 81234, "sha256": "…"},
       {"name": "files.tar.gz", "bytes": 512, "sha256": "…"},
       {"name": "flux.env", "bytes": 1893, "sha256": "…"}
     ]
   }
   ```

   `schemaVersion` is read from the database (`flux_schema_version`), not from the code.
   `appVersion` comes from `apps/server/package.json`. `appCommit` is the `com.flux.commit`
   label of the running image (set from `git rev-parse HEAD` when `./flux` builds it), or the
   checkout's commit, or `unknown` for a checkout without git. `image` is the image id of
   `flux-foundation:<project>`.

## Restore

```sh
./flux restore backups/flux-backup-flux-3f2a9c1d-20260928T091502Z.tar
./flux restore <archive> --revoke-agent-connections   # also end every agent connection and OAuth token
```

In this order, stopping at the first problem:

1. **Check the archive.** It must contain the four parts; each must match the size and SHA-256
   in the manifest. A damaged or edited archive is refused before anything changes.
2. **Check the version.** The archive's schema, app version and (when both are known) commit
   must match this checkout. A mismatch is refused unless `--migrate` is given, which restores
   and then migrates forward. A backup with a *newer* schema than the code is always refused:
   migrations only go forward, so check out the version that wrote it.
3. **Ownership and confirmation.** The ownership check of `./flux up` applies. If the project
   already has containers or volumes, the restore asks `Replace ALL data (database and files)
   … ?` (`-y` answers yes). Answering no changes nothing.
4. **Settings.** Without a `.env`, the restore writes one from the archive's `flux.env` with
   this checkout's `FLUX_PROJECT`; `FLUX_PORT`, `FLUX_PUBLIC_ORIGIN`, `FLUX_DEV_PORT` and
   `FLUX_MAILPIT_PORT` from the shell replace the archived values (for a new address or
   port). With the same `FLUX_AUTH_SECRET` and VAPID keys, signed-in sessions and push
   subscriptions keep working. An existing `.env` is kept, and the restore warns when its
   signing secret or VAPID key differ (everyone signs in again; devices turn push on again).
5. **Replace the data.** It builds this checkout, removes this project's containers and
   volumes (`down -v`, never another project's), starts an empty database, runs `pg_restore
   --no-owner --no-privileges --exit-on-error --single-transaction`, unpacks the files, runs
   `files-init` (owner `1000:1000` for the non-root API) and the migration, which applies
   forward migrations after `--migrate` and otherwise only validates the schema.
6. **Check.** It starts API and worker, waits for their health checks, and compares the API's
   `/api/v1/health` `schemaVersion` and the database's `flux_schema_version` with this
   checkout's schema. It prints both.

Restore keeps everything in the dump, including private notes, direct messages, sessions,
revoked sessions (they stay revoked), push subscriptions and notification rows. Access is
decided by the same policy rows, so permissions are exactly as they were.

### Agent connections and OAuth tokens

Personal agent connections (#52) and their OAuth clients, hashed refresh tokens, access token
rows and JWT signing keys are ordinary database rows, so a backup keeps them as stored and a
restore brings them back **as they were when the backup was taken**:

- a connection revoked *before* the backup stays revoked, and its bearer tokens stay denied;
- a connection or token revoked *after* the backup is **active again** after the restore, and
  so is anything else the owners changed since (grants, memberships, sessions).

When a restore brings back active connections, it prints `NOTE: N agent connection(s) are
active as of the backup`. After restoring an older backup, or whenever a token may have leaked,
run the restore with `--revoke-agent-connections`: after the migration and before API and
worker start, it revokes every agent connection and every OAuth access and refresh token
(`infra/operations.ts`, SQL in `packages/db/src/repositories/operations.ts`). People then
connect their agents again from `/connect-agent`. Changing `FLUX_AUTH_SECRET` in `.env` signs
everyone out of the browser as well, which is heavier; revoking the connections is the targeted
step for agents. Revoke sessions that ended after the backup through
`/api/v1/sessions` or ask people to sign out other sessions.

### Restore on a fresh machine or checkout

```sh
git clone https://github.com/ColdPhase/flux.git flux && cd flux
git checkout <appCommit from the manifest>   # or use --migrate with a newer checkout
./flux restore /path/to/flux-backup-….tar
```

The new checkout gets its own project name; the data and secrets come from the archive.

## Verified behavior

`./scripts/check_backup.sh` runs on disposable copies of the working tree with their own
Compose projects, ports and images, and removes them afterwards. It seeds `./flux demo` plus
conversations, a DM, a private note, a project sketch with links, work, a decision and a
result with links, a doc with two versions, a push subscription, a revoked and a live session,
two agent connections with OAuth bearers (one revoked before the backup, one right after it),
an outsider account and a 300 kB file in the files volume; backs up twice (`--keep 1`);
checks the manifest and checksums; checks that restore is refused without confirmation, for a
damaged archive, for an older schema without `--migrate` and for a newer schema; destroys the
volumes; restores into a **fresh** checkout without `.env`; and verifies through its API that
the project export, conversations, doc versions, DM messages, drafts, members and push
subscriptions equal the data before the backup, that the old session still works and the
revoked one does not, that sign-in works, that the private note stays private, and that the
outsider is denied the project, its export, the DM and the note. The bearer of the connection
revoked before the backup is still denied (`403` from `/mcp`); the one revoked after the backup
works again and the restore prints the note; a second restore with `--revoke-agent-connections`
denies both bearers and lists every connection as revoked. Fresh checkout B takes A's address
after A is destroyed, as a replacement machine would, because OAuth issuer and audience are
the public origin. The file must be byte for
byte identical and owned by the API user. The same script covers [upgrade](upgrade.md).

Not covered yet: very large databases (the dump is streamed through `docker compose exec`,
which is fine for gigabytes but untested there), point-in-time recovery (WAL archiving), and
backups while writers keep running. Notification preferences (#116) are not on `main` yet;
they are ordinary database rows and will be part of the dump.
