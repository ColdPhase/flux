# Encrypted spaces

People can make a space whose content is encrypted on the server (F-030,
[encrypted workspaces](../product/encrypted-workspaces.md), issue
[#655](https://github.com/ColdPhase/flux/issues/655)): Home → Details → People → **New space** →
**Encrypt this space**. This page is for the person who runs the server. It says what an encrypted
space needs from the install, what a backup, a restore and an upgrade do to it, and what it does not
protect.

**What it protects.** A copy of the data: a database dump, the volumes, a backup archive, logs, or the
whole server taken away switched off. **What it does not protect:** a running, unlocked server (root on
the host, a debugger, a memory snapshot of a live VM), and a host that hibernates or a VM that is
suspended to disk while a space is unlocked. Those keep the key in a memory image on disk.

## Install

Nothing to switch on. Every install runs a small `keyring` service next to `api` and `worker`, on an
internal network only these three join. The first `./flux up` writes its `FLUX_KEYRING_TOKEN` into
the new `docker/.env`, and `./flux upgrade` adds one to an older `docker/.env` that lacks it; neither
changes an existing token. An install from a release needs the variable set in its `.env`. Without a token
the keyring stays idle and an encrypted space cannot be made or unlocked ("Encrypted spaces aren't
available on this server right now: its key service isn't running").

**`FLUX_KEY_PIN_SECRET`** (from schema 130) pins every encrypted space's unlock passwords and key
versions, so rows planted in the database are refused. `./flux up` and `./flux upgrade` add it to
`docker/.env`, and it is never changed afterwards. It is not in the database: keep it with your backups
of `docker/.env`. Without it (or with one shorter than 32 characters) encrypted spaces cannot be made or
unlocked; **changing it makes every encrypted space refuse to unlock as tampered.**

## Restarts lock encrypted spaces

The unlocked key lives only in the memory of the running keyring, API and worker. When the **keyring,
the whole stack or the host** restarts (including `./flux upgrade`, which recreates every container,
and `docker compose down` then `./flux up`), every encrypted space is **locked**. Its people see
"Waiting to be unlocked", and an owner or admin unlocks it with their own unlock password, or the
recovery code, from that row. A restart of the API or the worker alone, including the one around
`./flux backup`, keeps spaces unlocked.

While a space is locked:

- nothing of it is shown or searched; its Inbox notifications carry no content (who and why only);
- work that needs its content, such as notifications, waits and runs after the next unlock;
- a key change (after an owner or admin left) pauses and continues after the next unlock.

## Upgrade

**Upgrading locks encrypted spaces; have an unlock password ready.** Before `./flux upgrade`, make sure
at least one owner or admin of each encrypted space can unlock it after the upgrade. See
[Upgrade](upgrade.md).

## Backup and restore

- **`./flux backup`** copies the database and the files as they are, so encrypted content stays
  encrypted in the archive. The archive's `flux.env` holds `FLUX_KEYRING_TOKEN`, which opens nothing
  without the running keyring.
- **`./flux restore`** needs the same `FLUX_KEY_PIN_SECRET` as the backup (it is in the archive's
  `flux.env`; an existing `docker/.env` with another value makes every restored space read as tampered).
- **`./flux restore`** brings encrypted spaces back **locked**. A space opens with an owner's or admin's
  unlock password **as it was when the backup was taken**, or the recovery code valid then. A password
  changed or set after the backup does not open the restored space. A backup whose passwords and
  recovery code are all lost cannot be read by anyone.
- A key change after someone left: the old backup still opens with the passwords of that time,
  including the password of the person who left. Delete old backups you no longer need.
- **After someone left: a fresh volume.** Once a key change finishes, new backups hold only the new key.
  A raw image of the disk can still hold old-key remnants in freed blocks, dead row versions and old
  WAL segments until they are reused; neither PostgreSQL nor a filesystem erases freed blocks. If that
  matters, use full-disk encryption, or move the instance to a fresh volume with `./flux backup` and
  `./flux restore` after the key change has finished (People → Encryption says "New key since …").
- **"Encryption keys were changed outside Flux. It stays locked."** Unlocking answers this when a
  space's key rows fail verification (an edit of the database, or a partial restore).
  Flux deletes and repairs nothing. Restoring **only** the tables `workspace_keys`,
  `workspace_holders`, `workspace_dek_wraps`, `workspace_key_versions` and `workspace_removed_holders`
  from the last good backup is enough, as long as no key change finished after that backup; otherwise
  restore the whole instance. The next unlock checks everything again.
- **"The key change can't finish: some stored data doesn't open."** A value of the space that the old
  key cannot open stops a key change from finishing; owners and admins get this Inbox notice and People
  shows it. Nothing is lost or exposed; the worker's log names the table and column (never content).
  Report it with that log line.
- **`./flux export`** refuses an encrypted space ("Garden club is encrypted. Export it from the app."),
  because it would write the content to the server's disk. A project's owner exports it from the app
  instead, as a download.

See [Backup and restore](backup-restore.md).

## Swap and hibernation

The unlocked key and the content being worked on are in the memory of `api`, `worker` and `keyring`.
If the system writes that memory to a disk, a server taken away switched off still holds the key. So:

- **Swap is enforced.** The shipped Compose files limit memory and swap to the same value for `api`,
  `worker` and `keyring` (`FLUX_API_MEMORY`, `FLUX_WORKER_MEMORY`, `FLUX_KEYRING_MEMORY`), so they cannot
  swap where the kernel accounts swap. Where it cannot be enforced (an older kernel without swap
  accounting) and swap is on, the keyring does not start and encrypted spaces stay locked ("This server
  can write memory to disk. Its operator needs to turn off swap or confirm it is encrypted."). Turn swap
  off, use only `zram`, or set `FLUX_SWAP_ACKNOWLEDGED=encrypted-swap` **only** when every swap device is
  encrypted with a key that is not stored on the disk.
- **Core dumps** are off for the three services.
- **Hibernation and suspend-to-disk are not covered.** Do not hibernate the host or suspend its VM to
  disk while an encrypted space is unlocked, and do not take VM memory snapshots of it. Lock the spaces
  first (People → Encryption → **Lock now**), or stop the stack.

## Losing every password

If every unlock password and the recovery code of a space are lost, its content is gone for good.
Nobody can recover it, including whoever runs the server. Owners keep the recovery code (shown once
when the space is made, and again when an owner makes a new one) somewhere safe.
