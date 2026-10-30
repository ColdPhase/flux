import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { envelopeSample } from './key-rotation.js';

/**
 * Rows of encrypted workspaces (F-030, #655, migration 0119; docs/product/encrypted-workspaces.md). They satisfy the
 * ports of `packages/core/src/encryption` structurally (this package cannot import core). No row here ever holds a DEK,
 * KEK, boot key, password or recovery code: only wraps, sealed values, MACs, ids and times. They make no access
 * decision; the caller authorizes.
 */

/** One pinned removal record (0130). */
export interface RemovalRow { seq: number; holderId: string; userId: string | null; publicKey: string; removedVersion: number; pin: string }
type RemovalPinner = (record: { workspaceId: string; seq: number; holderId: string; userId: string | null; publicKey: string; removedVersion: number; previous: string }) => string;
let removalPinner: RemovalPinner | null = null;
/**
 * Installed once per API and worker process with core's `KeyPin.removal` (the secret never reaches this package as
 * data). Without it, removals stay plain tombstones until a process with the pin records them.
 */
export function configureRemovalPin(next: RemovalPinner | null) { removalPinner = next; }

export interface WorkspaceKeysRow {
  workspaceId: string;
  /** The pin of the last removal record (null: none). */
  removalHead: string | null;
  name: string;
  currentVersion: number;
  liveVersions: number[];
  rotation: 'none' | 'pending' | 'reencrypting';
  tamperedAt: Date | null;
  createdAt: Date;
}
export interface HolderRow {
  id: string;
  workspaceId: string;
  kind: 'password' | 'recovery';
  userId: string | null;
  kdf: unknown;
  publicKey: string;
  wrappedPrivate: string;
  holderMac: string;
  holderMacVersion: number;
  secretCheck: string;
  confirmedVersions: number[];
  pin: string | null;
}
export interface DekWrapRow { holderId: string; workspaceId: string; keyVersion: number; ephemeralPublic: string; sealedDek: string; confirm: string | null }
export interface KeyVersionRow { keyVersion: number; commitment: string | null; checkValue: string; pin: string | null }
export interface UnlockRowData { keyVersion: number; bootId: string; sealedDek: string; unlockedAt: Date; unlockedBy: string | null }
export interface EncryptionViewRow {
  workspaceId: string;
  tampered: boolean;
  liveVersions: number[];
  unlocks: { keyVersion: number; bootId: string; unlockedAt: Date; unlockedBy: string | null; unlockedByName: string | null }[];
  myPassword: boolean;
  recoveryCode: boolean;
  keyChangedAt: Date | null;
  /** S2c: the rotation state and, while one runs, its progress. */
  rotation: 'none' | 'pending' | 'reencrypting';
  rotationProgress: { rowsDone: number; rowsEstimate: number; startedAt: Date; stalled: boolean } | null;
}

/** A version list as a PostgreSQL integer[] literal (ints only). */
const versionsArray = (versions: readonly number[]) => `{${versions.filter((v) => Number.isSafeInteger(v)).join(',')}}`;
/**
 * The fair gate in front of `workspace_keys` (S2c review P2-1). Row locks are not queue-fair: back-to-back writers each
 * taking `FOR SHARE` can starve a rotation's start or finish, an unlock or a role change waiting for `FOR UPDATE`.
 * Every side first takes this transaction-scoped advisory lock (writers shared, the `FOR UPDATE` side exclusive);
 * PostgreSQL's lock manager queues a waiting exclusive request ahead of later shared ones, so new writers wait behind it.
 */
export async function keyGate(db: DbExecutor, workspaceId: string, mode: 'shared' | 'exclusive') {
  const name = `flux-workspace-keys:${workspaceId}`;
  if (mode === 'shared') await db.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${name}, 0))`);
  else await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

const rowsOf = async <T>(db: DbExecutor, query: SQL) => (await db.execute(query)).rows as unknown as T[];
/** Raw `execute` rows carry timestamps as text; every timestamp leaves this module as a Date. */
const at = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const atOrNull = (value: unknown): Date | null => (value === null || value === undefined ? null : at(value));
const unlockRows = (rows: UnlockRowData[]) => rows.map((row) => ({ ...row, unlockedAt: at(row.unlockedAt) }));
const lockClause = (lock: 'update' | 'share' | undefined) => (lock === 'update' ? sql` FOR UPDATE` : lock === 'share' ? sql` FOR SHARE` : sql``);

const HOLDER = sql`id, workspace_id AS "workspaceId", kind, user_id AS "userId", kdf, public_key AS "publicKey", wrapped_private AS "wrappedPrivate",
  holder_mac AS "holderMac", holder_mac_version AS "holderMacVersion", secret_check AS "secretCheck",
  confirmed_versions AS "confirmedVersions", pin`;
const UNLOCK = sql`key_version AS "keyVersion", boot_id AS "bootId", sealed_dek AS "sealedDek", unlocked_at AS "unlockedAt", unlocked_by AS "unlockedBy"`;

export function workspaceEncryptionRows(db: DbExecutor) {
  const self = {
    /** Whether the workspace is sealed (false for a missing one). */
    async sealed(workspaceId: string): Promise<boolean> {
      const [row] = await rowsOf<{ sealed: boolean }>(db, sql`SELECT workspace_sealed(${workspaceId}::uuid) AS sealed`);
      return row?.sealed === true;
    },
    /** What `sealFor` reads: with `lock` the unlock rows `FOR SHARE`, before every other lock of a write. */
    async sealState(workspaceId: string, options: { lock: boolean }) {
      // Lock order of a write to a sealed workspace: workspace_keys, then the unlock rows, both FOR SHARE, so a
      // rotation's start or finish (FOR UPDATE) and Lock now are each ordered strictly before or after it.
      if (options.lock) {
        await keyGate(db, workspaceId, 'shared');
        await db.execute(sql`SELECT 1 FROM workspace_keys WHERE workspace_id = ${workspaceId} FOR SHARE`);
      }
      const unlocks = unlockRows(await rowsOf<UnlockRowData>(db, sql`SELECT ${UNLOCK} FROM workspace_unlocks WHERE workspace_id = ${workspaceId}
        ORDER BY key_version${options.lock ? sql` FOR SHARE` : sql``}`));
      const [row] = await rowsOf<{ name: string; encrypted: boolean; tampered: boolean; currentVersion: number | null; liveVersions: number[] | null }>(db, sql`
        SELECT w.name, w.encrypted, k.tampered_at IS NOT NULL AS tampered, k.current_version AS "currentVersion", k.live_versions AS "liveVersions"
        FROM workspaces w LEFT JOIN workspace_keys k ON k.workspace_id = w.id WHERE w.id = ${workspaceId}`);
      if (!row) return null;
      return { name: row.name, encrypted: row.encrypted, tampered: row.tampered || (row.encrypted && row.currentVersion === null),
        currentVersion: row.currentVersion ?? 0, liveVersions: row.liveVersions ?? [], unlocks };
    },
    async keys(workspaceId: string, options: { lock?: 'update' | 'share' } = {}): Promise<WorkspaceKeysRow | null> {
      if (options.lock) await keyGate(db, workspaceId, options.lock === 'update' ? 'exclusive' : 'shared');
      const [row] = await rowsOf<WorkspaceKeysRow>(db, sql`SELECT k.workspace_id AS "workspaceId", w.name, k.current_version AS "currentVersion",
        k.live_versions AS "liveVersions", k.rotation, k.tampered_at AS "tamperedAt", k.created_at AS "createdAt", k.removal_head AS "removalHead"
        FROM workspace_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE k.workspace_id = ${workspaceId}${options.lock ? sql` FOR ${options.lock === 'update' ? sql`UPDATE` : sql`SHARE`} OF k` : sql``}`);
      return row ? { ...row, tamperedAt: atOrNull(row.tamperedAt), createdAt: at(row.createdAt) } : null;
    },
    holders: (workspaceId: string) => rowsOf<HolderRow>(db, sql`SELECT ${HOLDER} FROM workspace_holders WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`),
    dekWraps: (workspaceId: string) => rowsOf<DekWrapRow>(db, sql`SELECT holder_id AS "holderId", workspace_id AS "workspaceId", key_version AS "keyVersion",
      ephemeral_public AS "ephemeralPublic", sealed_dek AS "sealedDek", confirm FROM workspace_dek_wraps WHERE workspace_id = ${workspaceId}`),
    keyVersions: (workspaceId: string) => rowsOf<KeyVersionRow>(db, sql`SELECT key_version AS "keyVersion", commitment, check_value AS "checkValue", pin
      FROM workspace_key_versions WHERE workspace_id = ${workspaceId} ORDER BY key_version`),
    unlocks: async (workspaceId: string, options: { lock?: 'update' | 'share' } = {}) =>
      unlockRows(await rowsOf<UnlockRowData>(db, sql`SELECT ${UNLOCK} FROM workspace_unlocks WHERE workspace_id = ${workspaceId} ORDER BY key_version${lockClause(options.lock)}`)),
    async workspaceByCreation(createdBy: string, creationId: string): Promise<{ id: string; name: string } | null> {
      const [row] = await rowsOf<{ id: string; name: string }>(db, sql`SELECT id, name FROM workspaces WHERE created_by = ${createdBy} AND creation_id = ${creationId}`);
      return row ?? null;
    },
    /** The workspace (encrypted), its owner and its key row at version 1. The AI policy trigger writes `blocked`. */
    async insertSealedWorkspace(row: { id: string; name: string; createdBy: string; creationId: string }) {
      await db.execute(sql`INSERT INTO workspaces (id, name, created_by, encrypted, creation_id) VALUES (${row.id}, ${row.name}, ${row.createdBy}, true, ${row.creationId})`);
      await db.execute(sql`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES (${row.id}, ${row.createdBy}, 'owner', ${row.createdBy})`);
      await db.execute(sql`INSERT INTO workspace_keys (workspace_id) VALUES (${row.id})`);
    },
    async insertKeyVersion(row: { workspaceId: string; keyVersion: number; commitment: string | null; checkValue: string; pin: string }) {
      await db.execute(sql`INSERT INTO workspace_key_versions (workspace_id, key_version, commitment, check_value, pin)
        VALUES (${row.workspaceId}, ${row.keyVersion}, ${row.commitment}, ${row.checkValue}, ${row.pin})`);
    },
    async insertHolder(row: HolderRow) {
      await db.execute(sql`INSERT INTO workspace_holders (id, workspace_id, kind, user_id, kdf, public_key, wrapped_private, holder_mac, holder_mac_version,
          secret_check, confirmed_versions, pin)
        VALUES (${row.id}, ${row.workspaceId}, ${row.kind}, ${row.userId}, ${JSON.stringify(row.kdf)}::jsonb, ${row.publicKey}, ${row.wrappedPrivate},
          ${row.holderMac}, ${row.holderMacVersion}, ${row.secretCheck}, ${versionsArray(row.confirmedVersions)}::integer[], ${row.pin})`);
    },
    /** A new key pair or password for an existing holder, in place (deleting a password holder would leave a rotation pending). */
    async updateHolder(id: string, row: Pick<HolderRow, 'kdf' | 'publicKey' | 'wrappedPrivate' | 'holderMac' | 'holderMacVersion' | 'secretCheck' | 'confirmedVersions' | 'pin'>) {
      await db.execute(sql`UPDATE workspace_holders SET kdf = ${JSON.stringify(row.kdf)}::jsonb, public_key = ${row.publicKey}, wrapped_private = ${row.wrappedPrivate},
        holder_mac = ${row.holderMac}, holder_mac_version = ${row.holderMacVersion}, secret_check = ${row.secretCheck},
        confirmed_versions = ${versionsArray(row.confirmedVersions)}::integer[], pin = ${row.pin}, updated_at = now() WHERE id = ${id}`);
    },
    async updateHolderMac(id: string, row: Pick<HolderRow, 'holderMac' | 'holderMacVersion' | 'confirmedVersions'>) {
      await db.execute(sql`UPDATE workspace_holders SET holder_mac = ${row.holderMac}, holder_mac_version = ${row.holderMacVersion},
        confirmed_versions = ${versionsArray(row.confirmedVersions)}::integer[], updated_at = now() WHERE id = ${id}`);
    },
    async insertDekWrap(row: DekWrapRow) {
      await db.execute(sql`INSERT INTO workspace_dek_wraps (holder_id, workspace_id, key_version, ephemeral_public, sealed_dek, confirm)
        VALUES (${row.holderId}, ${row.workspaceId}, ${row.keyVersion}, ${row.ephemeralPublic}, ${row.sealedDek}, ${row.confirm})`);
    },
    removals: (workspaceId: string) => rowsOf<RemovalRow>(db, sql`SELECT seq, holder_id AS "holderId", user_id AS "userId", public_key AS "publicKey",
      removed_version AS "removedVersion", pin FROM workspace_removals WHERE workspace_id = ${workspaceId} ORDER BY seq`),
    /**
     * Turns the tombstones without a record into pinned removal records, chained after the last one, and moves the
     * head. The caller holds `workspace_keys` FOR UPDATE. 'broken' (nothing written) when the existing chain does not
     * verify: appending would launder a deletion. 0 without a configured pin.
     */
    async recordRemovals(workspaceId: string): Promise<number | 'broken'> {
      if (!removalPinner) return 0;
      const pinner = removalPinner;
      const records = await self.removals(workspaceId);
      const [keys] = await rowsOf<{ head: string | null; version: number }>(db, sql`SELECT removal_head AS head, current_version AS version FROM workspace_keys
        WHERE workspace_id = ${workspaceId}`);
      if (!keys) return 0;
      let previous = '';
      for (const [index, record] of records.entries()) {
        if (record.seq !== index + 1 || record.pin !== pinner({ ...record, workspaceId, previous })) return 'broken';
        previous = record.pin;
      }
      if ((records.length ? previous : null) !== keys.head) return 'broken';
      const fresh = await rowsOf<{ holderId: string; userId: string | null; publicKey: string }>(db, sql`SELECT t.holder_id AS "holderId", t.user_id AS "userId",
        t.public_key AS "publicKey" FROM workspace_removed_holders t WHERE t.workspace_id = ${workspaceId}
        AND NOT EXISTS (SELECT 1 FROM workspace_removals r WHERE r.workspace_id = t.workspace_id AND r.holder_id = t.holder_id) ORDER BY t.removed_at, t.holder_id`);
      let seq = records.length;
      for (const row of fresh) {
        seq += 1;
        const pin = pinner({ ...row, workspaceId, seq, removedVersion: keys.version, previous });
        await db.execute(sql`INSERT INTO workspace_removals (workspace_id, seq, holder_id, user_id, public_key, removed_version, pin)
          VALUES (${workspaceId}, ${seq}, ${row.holderId}, ${row.userId}, ${row.publicKey}, ${keys.version}, ${pin})`);
        previous = pin;
      }
      if (fresh.length) await db.execute(sql`UPDATE workspace_keys SET removal_head = ${previous} WHERE workspace_id = ${workspaceId}`);
      return fresh.length;
    },
    tombstones: (workspaceId: string) => rowsOf<{ holderId: string; publicKey: string }>(db, sql`SELECT holder_id AS "holderId", public_key AS "publicKey"
      FROM workspace_removed_holders WHERE workspace_id = ${workspaceId}`),
    envelopeSample: (workspaceId: string, version: number) => envelopeSample(db, workspaceId, version),
    /** Replaces every DEK wrap of one holder. */
    async replaceDekWraps(holderId: string, rows: Omit<DekWrapRow, 'holderId'>[]) {
      await db.execute(sql`DELETE FROM workspace_dek_wraps WHERE holder_id = ${holderId}`);
      for (const row of rows) await db.execute(sql`INSERT INTO workspace_dek_wraps (holder_id, workspace_id, key_version, ephemeral_public, sealed_dek, confirm)
        VALUES (${holderId}, ${row.workspaceId}, ${row.keyVersion}, ${row.ephemeralPublic}, ${row.sealedDek}, ${row.confirm})`);
    },
    async setConfirm(holderId: string, keyVersion: number, confirm: string) {
      await db.execute(sql`UPDATE workspace_dek_wraps SET confirm = ${confirm} WHERE holder_id = ${holderId} AND key_version = ${keyVersion}`);
    },
    async upsertUnlock(workspaceId: string, row: Omit<UnlockRowData, 'unlockedAt'>) {
      await db.execute(sql`INSERT INTO workspace_unlocks (workspace_id, key_version, boot_id, sealed_dek, unlocked_by)
        VALUES (${workspaceId}, ${row.keyVersion}, ${row.bootId}, ${row.sealedDek}, ${row.unlockedBy})
        ON CONFLICT (workspace_id, key_version) DO UPDATE SET boot_id = EXCLUDED.boot_id, sealed_dek = EXCLUDED.sealed_dek,
          unlocked_by = EXCLUDED.unlocked_by, unlocked_at = now()`);
    },
    async deleteUnlocks(workspaceId: string): Promise<number> {
      return (await db.execute(sql`DELETE FROM workspace_unlocks WHERE workspace_id = ${workspaceId}`)).rowCount ?? 0;
    },
    /**
     * After a keyring restart: deletes every unlock row of another boot, and the remaining rows of any workspace with a
     * live version that has no current row. Returns each affected workspace once, with who had unlocked it.
     */
    async dropStaleUnlocks(currentBoot: string, observedAt: Date): Promise<{ workspaceId: string; unlockedBy: string | null }[]> {
      // Rows written after `observedAt` belong to a boot newer than the one the caller saw; they are never touched.
      return rowsOf(db, sql`WITH stale AS (
          SELECT u.workspace_id FROM workspace_unlocks u JOIN workspace_keys k ON k.workspace_id = u.workspace_id
          WHERE u.unlocked_at <= ${observedAt.toISOString()}::timestamptz AND NOT EXISTS (SELECT 1 FROM workspace_unlocks n
            WHERE n.workspace_id = u.workspace_id AND n.unlocked_at > ${observedAt.toISOString()}::timestamptz) AND (u.boot_id <> ${currentBoot}::uuid
             OR EXISTS (SELECT 1 FROM unnest(k.live_versions) v WHERE NOT EXISTS (
               SELECT 1 FROM workspace_unlocks c WHERE c.workspace_id = u.workspace_id AND c.key_version = v AND c.boot_id = ${currentBoot}::uuid)))
        ), deleted AS (
          DELETE FROM workspace_unlocks u USING (SELECT DISTINCT workspace_id FROM stale) s WHERE u.workspace_id = s.workspace_id
          RETURNING u.workspace_id, u.unlocked_by, u.key_version
        )
        SELECT DISTINCT ON (workspace_id) workspace_id AS "workspaceId", unlocked_by AS "unlockedBy" FROM deleted ORDER BY workspace_id, key_version DESC`);
    },
    /** Work that waited while the workspace was locked, oldest first (ids only). */
    async waits(workspaceId: string): Promise<{ id: string; queue: string; payload: Record<string, unknown> }[]> {
      return rowsOf(db, sql`SELECT id, queue, payload FROM sealed_job_waits WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`);
    },
    async deleteWait(id: string) {
      await db.execute(sql`DELETE FROM sealed_job_waits WHERE id = ${id}`);
    },
    /** Sets `tampered_at` once; true when this call set it. */
    async markTampered(workspaceId: string): Promise<boolean> {
      return ((await db.execute(sql`UPDATE workspace_keys SET tampered_at = now() WHERE workspace_id = ${workspaceId} AND tampered_at IS NULL`)).rowCount ?? 0) > 0;
    },
    async clearTampered(workspaceId: string) {
      await db.execute(sql`UPDATE workspace_keys SET tampered_at = NULL WHERE workspace_id = ${workspaceId} AND tampered_at IS NOT NULL`);
    },
    /**
     * The shared password limiter: under a per-person advisory lock, prunes rows older than the window, counts the rest
     * (failures and checks in flight) and, below the limit, records this check's row. The caller releases it on success.
     */
    async reserveAttempt(workspaceId: string, userId: string, limit: number, windowSeconds: number): Promise<{ id: string } | { retryAfterSeconds: number }> {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flux-password-attempts:${workspaceId}:${userId}`}, 0))`);
      await db.execute(sql`DELETE FROM password_attempts WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
        AND at < now() - make_interval(secs => ${windowSeconds})`);
      const [row] = await rowsOf<{ count: number; retry: number | null }>(db, sql`SELECT count(*)::int AS count,
        ceil(extract(epoch FROM (min(at) + make_interval(secs => ${windowSeconds}) - now())))::int AS retry
        FROM password_attempts WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`);
      if ((row?.count ?? 0) >= limit) return { retryAfterSeconds: Math.max(1, row?.retry ?? windowSeconds) };
      const id = randomUUID();
      await db.execute(sql`INSERT INTO password_attempts (id, workspace_id, user_id) VALUES (${id}, ${workspaceId}, ${userId})`);
      return { id };
    },
    async releaseAttempt(id: string) {
      await db.execute(sql`DELETE FROM password_attempts WHERE id = ${id}`);
    },
    async grant(workspaceId: string, userId: string, options: { lock?: boolean } = {}): Promise<{ grantedBy: string; expiresAt: Date } | null> {
      const [row] = await rowsOf<{ grantedBy: string; expiresAt: Date }>(db, sql`SELECT granted_by AS "grantedBy", expires_at AS "expiresAt"
        FROM workspace_wrap_grants WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND expires_at > now()${options.lock ? sql` FOR UPDATE` : sql``}`);
      return row ? { grantedBy: row.grantedBy, expiresAt: at(row.expiresAt) } : null;
    },
    async putGrant(workspaceId: string, userId: string, grantedBy: string, seconds: number): Promise<Date> {
      const [row] = await rowsOf<{ expiresAt: Date }>(db, sql`INSERT INTO workspace_wrap_grants (workspace_id, user_id, granted_by, expires_at)
        VALUES (${workspaceId}, ${userId}, ${grantedBy}, now() + make_interval(secs => ${seconds}))
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at
        RETURNING expires_at AS "expiresAt"`);
      return at(row!.expiresAt);
    },
    async deleteGrant(workspaceId: string, userId: string) {
      await db.execute(sql`DELETE FROM workspace_wrap_grants WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`);
    },
    async memberRole(workspaceId: string, userId: string): Promise<'owner' | 'admin' | 'member' | 'guest' | null> {
      const [row] = await rowsOf<{ role: 'owner' | 'admin' | 'member' | 'guest' }>(db, sql`SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`);
      return row?.role ?? null;
    },
    /** Owners and admins now (the holder set's role rule). */
    async managers(workspaceId: string): Promise<string[]> {
      return (await rowsOf<{ userId: string }>(db, sql`SELECT user_id AS "userId" FROM workspace_members WHERE workspace_id = ${workspaceId} AND role IN ('owner', 'admin')`))
        .map((row) => row.userId);
    },
    async userName(userId: string): Promise<string | null> {
      const [row] = await rowsOf<{ name: string }>(db, sql`SELECT name FROM auth_users WHERE id = ${userId}`);
      return row?.name ?? null;
    },
    /** One Inbox notification of reason `security` (content-free; never pushed or e-mailed). */
    async insertSecurityNotice(row: { userId: string; workspaceId: string; title: string; eventId: string | null }) {
      await db.execute(sql`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, event_id, ai_origin)
        VALUES (${randomUUID()}, ${row.userId}, ${row.workspaceId}, 'workspace', ${row.workspaceId}, ${row.title}, '', NULL, 'security', ${row.eventId}, false)`);
    },
    /**
     * A demotion or removal of an owner or admin (in the role change's transaction): deletes their password holder.
     * `last` when it is the workspace's only password holder (nothing is deleted; the caller refuses).
     */
    async dropUnlockPassword(workspaceId: string, userId: string): Promise<'none' | 'deleted' | 'last'> {
      const holders = await rowsOf<{ userId: string | null }>(db, sql`SELECT user_id AS "userId" FROM workspace_holders
        WHERE workspace_id = ${workspaceId} AND kind = 'password' ORDER BY id FOR UPDATE`);
      if (!holders.some((holder) => holder.userId === userId)) return 'none';
      if (holders.length === 1) return 'last';
      await db.execute(sql`DELETE FROM workspace_holders WHERE workspace_id = ${workspaceId} AND kind = 'password' AND user_id = ${userId}`);
      return 'deleted';
    },
    /** The `encryption` field of each sealed workspace for one reader (null user for an agent). Plain workspaces are absent. */
    async views(workspaceIds: string[], userId: string | null): Promise<Map<string, EncryptionViewRow>> {
      if (!workspaceIds.length) return new Map();
      const ids = sql.join(workspaceIds.map((id) => sql`${id}::uuid`), sql`, `);
      const rows = await rowsOf<Omit<EncryptionViewRow, 'unlocks'> & { unlocks: { keyVersion: number; bootId: string; unlockedAt: string; unlockedBy: string | null; unlockedByName: string | null }[] | null }>(db, sql`
        SELECT k.workspace_id AS "workspaceId", k.tampered_at IS NOT NULL AS tampered, k.live_versions AS "liveVersions",
          (SELECT json_agg(json_build_object('keyVersion', u.key_version, 'bootId', u.boot_id, 'unlockedAt', u.unlocked_at, 'unlockedBy', u.unlocked_by,
             'unlockedByName', a.name) ORDER BY u.key_version) FROM workspace_unlocks u LEFT JOIN auth_users a ON a.id = u.unlocked_by
             WHERE u.workspace_id = k.workspace_id) AS unlocks,
          EXISTS (SELECT 1 FROM workspace_holders h WHERE h.workspace_id = k.workspace_id AND h.kind = 'password' AND h.user_id = ${userId}) AS "myPassword",
          EXISTS (SELECT 1 FROM workspace_holders h WHERE h.workspace_id = k.workspace_id AND h.kind = 'recovery') AS "recoveryCode",
          (SELECT max(v.created_at) FROM workspace_key_versions v WHERE v.workspace_id = k.workspace_id AND v.key_version > 1) AS "keyChangedAt",
          k.rotation, (SELECT json_build_object('rowsDone', p.rows_done, 'rowsEstimate', p.rows_estimate, 'startedAt', p.started_at, 'stalled', p.stalled_at IS NOT NULL)
            FROM workspace_rotation_progress p WHERE p.workspace_id = k.workspace_id AND p.target_version = k.current_version) AS "rotationProgress"
        FROM workspace_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE w.encrypted AND k.workspace_id IN (${ids})`);
      return new Map(rows.map((row) => [row.workspaceId, { ...row, keyChangedAt: atOrNull(row.keyChangedAt),
        rotationProgress: row.rotationProgress ? { rowsDone: Number(row.rotationProgress.rowsDone), rowsEstimate: Number(row.rotationProgress.rowsEstimate),
          startedAt: at(row.rotationProgress.startedAt), stalled: row.rotationProgress.stalled === true } : null,
        unlocks: (row.unlocks ?? []).map((unlock) => ({ ...unlock, unlockedAt: new Date(unlock.unlockedAt) })) }]));
    },
  };
  return self;
}
export type WorkspaceEncryptionRows = ReturnType<typeof workspaceEncryptionRows>;
