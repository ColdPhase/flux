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

1. **One point in time.** The API and worker are the only writers. The backup stops both and
   confirms that neither is still running; if `stop` fails or one keeps running it writes no
   archive and restarts only what it did stop. It then
   starts the database if needed, dumps it (`pg_dump --format=custom`) and archives the files
   volume (`tar -czf` of `/data/files`) while nothing can write, then restarts them. If they
   were not running, they stay stopped, and a database that was stopped is stopped again. If
   the backup fails, a trap restarts what it stopped, and no archive is written.
   One backup of a project runs at a time (lock directory `.flux-backup-lock-<project>`).
2. **Archive.** `flux-backup-<project>-<UTC second>-<8 random hex>.tar`, so two backups in the
   same second never share a name; an existing file is never replaced (`ln`, not `mv`). One uncompressed `tar` with four parts (the dump and files archive are already
   compressed), written with mode `600`, plus `<archive>.sha256` for checking copies:

   | Part | Contents |
   | --- | --- |
   | `manifest.json` | Format, time, project, schema and app version, checksums (below). |
   | `database.dump` | `pg_dump` custom format of the whole database, including the pg-boss queue schema. It holds the definition of `auth_idp_standing` but none of its rows: the identity provider's offline refresh tokens never leave the instance ([single sign-on](single-sign-on.md#standing-check)). |
   | `files.tar.gz` | The files volume (uploaded files; the API's own health probe files are transient). |
   | `flux.env` | A copy of `docker/.env`: the database password, signing secret and VAPID keys that sessions and push subscriptions depend on. |

3. **Manifest** (`formatVersion` 1). One key per line, so the launcher reads it without a JSON
   tool:

   ```json
   {
     "format": "flux-backup",
     "formatVersion": 1,
     "createdAt": "2026-09-28T09:15:02Z",
     "project": "flux-3f2a9c1d",
     "schemaVersion": 20,
     "appliedMigrations": [1, 2, 3, "…", 20],
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

   `schemaVersion` and `appliedMigrations` (the exact ledger, #118) are read from the
   database (`flux_schema_version`), not from the code. `schemaVersion` is the highest entry.
   `appVersion` comes from `app/apps/server/package.json`. `appCommit` is the `com.flux.commit`
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
2. **Check the version.** The app version and (when both are known) commit must match this
   checkout unless `--migrate` is given. A backup with a *newer* highest schema is always refused.
3. **Check the exact migration ledger** (#118), after building the image and before anything is
   replaced. The ledger is read from the dump itself (`pg_restore --data-only --table
   flux_schema_version`) and must equal the manifest's `appliedMigrations` and end at its
   `schemaVersion`. It is then compared with the image's migration files by
   `tooling/dist/operations.js migration-gate`, which uses the `@flux/db` ledger parser the migrator
   uses:
   - equal sets restore plainly;
   - a backup that lacks some of the image's migrations (an older version, including a gap below
     the highest version) needs `--migrate`, and the migrator applies exactly those;
   - a backup that records a version the image has no file for (another branch, or a newer build
     with the same highest number) is **always refused**: the migrator could never make it exact.
   Comparing only `max(version)` would let such a backup replace the data and fail afterwards.
4. **Ownership and confirmation.** The ownership check of `./flux up` applies. If the project
   already has containers or volumes, the restore asks `Replace ALL data (database and files)
   … ?` (`-y` answers yes). Answering no changes nothing.
5. **Settings.** Without a `docker/.env`, the restore writes one from the archive's `flux.env` with
   this checkout's `FLUX_PROJECT`; `FLUX_PORT`, `FLUX_PUBLIC_ORIGIN`, `FLUX_DEV_PORT` and
   `FLUX_MAILPIT_PORT` from the shell replace the archived values (for a new address or
   port). With the same `FLUX_AUTH_SECRET` and VAPID keys, signed-in sessions and push
   subscriptions keep working. An existing `docker/.env` is kept, and the restore warns when its
   signing secret or VAPID key differ (everyone signs in again; devices turn push on again).
6. **Replace the data.** It builds this checkout, removes this project's containers and
   volumes (`down -v`, never another project's), starts an empty database, converts the dump with
   `pg_restore --no-owner --no-privileges -f -` and replays it with `psql --single-transaction
   -v ON_ERROR_STOP=1`, with `public` on pg_dump's otherwise empty `search_path` (the #114
   `search_keys` function calls `show_trgm` unqualified; migration `0022_search_restore_path.sql`
   pins its path for new dumps, the replay keeps older backups restorable), unpacks the files, runs
   `files-init` (owner `1000:1000` for the non-root API) and the migration, which applies
   forward migrations after `--migrate` and otherwise only validates the schema.
7. **Check.** It starts API and worker, waits for their health checks (which verify the exact
   ledger since #118), and compares the API's `schemaVersion` and the database's ledger with the
   image's migration files. It prints both.

The ownership check and settings steps run before the build; the confirmation prompt comes after
the ledger check, so a refused archive never asks.

Restore keeps everything in the dump, including private notes, direct messages, sessions,
revoked sessions (they stay revoked), push subscriptions and notification rows. Access is
decided by the same policy rows, so permissions are exactly as they were.

### Notifications and email

Notification rows, preferences, mutes, the extra delivery address and its verification state,
the generator's cursor and the email outbox (#116, migration 0015) are in the dump. The worker
is stopped during the backup, so the cursor and the outbox match the events in it. After a
restore the worker continues from that cursor: events after it are notified once, and outbox
rows that were still `queued` at backup time are sent. If the original instance kept running
after the backup, an email it sent from such a queued row can be sent once more by the
restored instance; the notification id in `Message-ID` lets mail clients spot it.

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
(`app/tooling/operations.ts`, SQL in `app/packages/db/src/repositories/operations.ts`). People then
connect their agents again from `/connect-agent`. Changing `FLUX_AUTH_SECRET` in `docker/.env` signs
everyone out of the browser as well, which is heavier; revoking the connections is the targeted
step for agents. Revoke sessions that ended after the backup through
`/api/v1/sessions` or ask people to sign out other sessions.

### Agent runtime slots

When the agent runtime is on ([operator guide](agent-runtime.md), F-022 T3), each slot has its own
volume, which holds owners' Claude Code and Codex logins, written by the CLIs themselves. **`./flux backup`
never includes a slot volume or the tools volume, on purpose:** the archive would then carry every
owner's vendor login, and a login copied to another machine stops working anyway, because the vendors
rotate refresh tokens and two copies invalidate each other. The archive's `flux.env` does hold the
runtime's service and slot secrets; they only let Flux's own services talk to each other.

A restore replaces the database and the files volume but leaves the slot volumes as they are. When the
worker starts, it compares the restored bindings with what each slot holds: a binding whose directory is
gone shows the owner *Sign in again*, and a directory that has no binding in the restored database is
signed out (best effort) and deleted, after which that slot restarts before anyone else can use it.
A disk-level or host snapshot is different: it does capture the slot volumes and their logins.

### Restore on a fresh machine or checkout

```sh
git clone https://github.com/ColdPhase/flux.git flux && cd flux
git checkout <appCommit from the manifest>   # or use --migrate with a newer checkout
./flux restore /path/to/flux-backup-….tar
```

The new checkout gets its own project name; the data and secrets come from the archive.

## Verified behavior

`./scripts/check_backup.sh` runs on disposable copies of the working tree with their own
Compose projects, ports and images, and removes them afterwards. Its ports start at
`FLUX_BACKUP_TEST_PORT` (default 19571) and use that port and the next eight; set it when
another check already uses that range. `./scripts/check_runtime.sh` (production-mode stack:
worker job, migration and restart keep data) listens on `FLUX_RUNTIME_TEST_PORT`
(default 18090). It seeds `./flux demo` plus
conversations, a DM, a private note, a project sketch with links, work, a decision and a
result with links, a doc with two versions, a push subscription, a revoked and a live session,
two agent connections with OAuth bearers (one revoked before the backup, one right after it),
a read DM notification, notification preferences with quiet hours and a muted DM,
an outsider account and a 300 kB file in the files volume; makes `docker compose --env-file docker/.env stop` fail (a PATH
shim) and checks that no archive is written and the untouched API is not restarted; runs two
backups in the same UTC second (a `date` shim) and checks both archives exist, then prunes with
`--keep 1`; checks the manifest, its exact ledger and checksums; checks that restore is refused
without confirmation, for a damaged archive, for a manifest whose ledger disagrees with its dump,
for a newer schema, and, before any data is replaced, for a ledger version the image has no file
for (the checkout drops a migration below the highest); restores an exact ledger plainly; destroys the
volumes; restores into a **fresh** checkout without `docker/.env`; and verifies through its API that
the project export, conversations, doc versions, DM messages, drafts, members and push
subscriptions, inbox items with their read state, notification preferences and agent connections
equal the data before the backup, that the old session still works and the
revoked one does not, that sign-in works, that the private note stays private, and that the
outsider is denied the project, its export, the DM and the note. The bearer of the connection
revoked before the backup is still denied (`403` from `/mcp`); the one revoked after the backup
works again and the restore prints the note; a second restore with `--revoke-agent-connections`
denies both bearers and lists every connection as revoked. Fresh checkout B takes A's address
after A is destroyed, as a replacement machine would, because OAuth issuer and audience are
the public origin. The file must be byte for
byte identical and owned by the API user. The same script covers [upgrade](upgrade.md).

GitHub provider credentials, bindings and pending authorization flows (#74) are
always revoked after exact migrations and before API/worker restart, independently
of `--revoke-agent-connections`. The original source/link history is retained as
unavailable; reconnect your own account and explicitly select repository bindings.
This prevents a provider authorization revoked after the backup from silently
becoming active again. It does not broaden the portable project export contract.

Not covered yet: very large databases (the dump is streamed through `docker compose --env-file docker/.env exec`,
which is fine for gigabytes but untested there), point-in-time recovery (WAL archiving), and
backups while writers keep running, and email outbox rows (`check_backup.sh` runs without SMTP;
the outbox is covered by the dump like every other table).
