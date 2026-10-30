import { Readable } from 'node:stream';
import { WORKSPACE_KEY_ROTATED_EVENT, WORKSPACE_KEY_ROTATION_STARTED_EVENT } from '@flux/contracts';
import { ConflictError } from '../access/errors.js';
import { envelopeVersion } from './envelope.js';
import { DecryptionFailedError } from './primitives.js';
import { WorkspaceLockedError } from './errors.js';
import { fileObjectVersion } from './files.js';
import { holderIdentity, holdersValid, recordTampering, SYSTEM, TamperedError, TamperSignal, zero, type Deks } from './holder-set.js';
import { holderMac, keyCommitment, sealDekToHolder } from './holders.js';
import { keyCheckValue, newDek, WorkspaceKey } from './keys.js';
import type { KeyPin } from './pin.js';
import type { WorkspaceSeal } from './ports.js';
import type { ProcessKeys } from './process-keys.js';
import { sealFor, unlockedRows } from './seal-for.js';
import type { EncryptionUnitOfWork, KeyRotationRepository } from './service-ports.js';

/**
 * Key rotation (F-030 S2c, #655; docs/product/encrypted-workspaces.md#rotation), run by the worker.
 *
 * - **Start** (pending to reencrypting), only while unlocked: verify every holder under DEK n, make DEK n+1, its
 *   commitment and check value, seal it to every member of the holder set (verified, an owner or admin, no tombstone;
 *   never under DEK n), rewrite their MACs under n+1, and add its unlock row. The keyring seals DEK n+1 before the
 *   transaction; if it cannot, the rotation stays pending.
 * - **Pass**: the S2a registry's tables in order, then files, in pages; each page is one transaction that opens the
 *   seal (`sealFor`, so a lock stops it) and writes compare-and-set. Progress commits with the page.
 * - **Finish**: only after one complete pass that changed nothing, and a last check under `workspace_keys` FOR UPDATE;
 *   then `VACUUM` the touched tables and `CHECKPOINT`.
 */
export interface RotationFileObjects {
  /** The stored object, or null when it is missing. */
  read(fileId: string): Promise<Buffer | null>;
  /** Writes the object anew (a new file in scratch, fsync, rename over the old one, directory sync). */
  replace(fileId: string, object: Buffer): Promise<void>;
}

export interface RotationMaintenance {
  vacuum(tables: string[]): Promise<void>;
  checkpoint(): Promise<void>;
}

export interface KeyRotationOptions {
  /** Rows per page (500). */
  pageSize: number;
  /** Files per page. */
  filePageSize: number;
  /** Pause between pages (20 ms), so a rotation never takes the database for itself. */
  pauseMs: number;
  /** The drain's lock timeout under the exclusive gate (1 s). */
  drainLockMs?: number;
  /** TEST ONLY hooks of a test deployment (crash mid-rotation; crash between a file's rename and its row update). */
  afterPage?: (pages: number) => Promise<void>;
  afterFileReplace?: (fileId: string) => Promise<void>;
}

export interface KeyRotationDeps {
  unit: EncryptionUnitOfWork;
  keys: ProcessKeys;
  files: RotationFileObjects | null;
  maintenance: RotationMaintenance;
  options: KeyRotationOptions;
  /** The key pin (`FLUX_KEY_PIN_SECRET`); without it no rotation starts (it could not pin the new version or verify holders). */
  pin: KeyPin | null;
}

export type StartOutcome = 'started' | 'idle' | 'locked' | 'tampered' | 'changed';
export type PassOutcome = 'finished' | 'locked' | 'idle' | 'stalled';

/** A value below the current version that does not open: the pass cannot move it. */
class StaleValueError extends Error {
  constructor(readonly place: string) { super('A stored value does not open'); this.name = 'StaleValueError'; }
}

const KEY_TABLES = ['workspace_keys', 'workspace_holders', 'workspace_dek_wraps', 'workspace_key_versions', 'workspace_unlocks',
  'workspace_removed_holders', 'workspace_rotation_progress', 'project_files'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sameVersions = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function rotationRows(ports: { rotation?: KeyRotationRepository }): KeyRotationRepository {
  if (!ports.rotation) throw new Error('This unit of work has no rotation rows');
  return ports.rotation;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/**
 * One file of the files step. The object's header names its version, so after a crash between the rename and the row
 * update the resumed step only updates the row. Returns whether the row moved to `current`.
 */
export async function rotateFileObject(seal: WorkspaceSeal, objects: RotationFileObjects, file: { id: string; keyVersion: number }, current: number,
  setVersion: (fileId: string, from: number, to: number) => Promise<boolean>, afterReplace?: (fileId: string) => Promise<void>): Promise<boolean> {
  const object = await objects.read(file.id);
  if (!object) return false; // nothing stored (yet): nothing to re-encrypt
  if (fileObjectVersion(object) !== current) {
    const cipher = seal.fileCipher(file.id);
    if (!cipher) throw new Error('A sealed workspace has a file cipher');
    const plaintext = cipher.open(object);
    try {
      const fresh = await collect(Readable.from([plaintext]).pipe(cipher.encryptor()));
      await objects.replace(file.id, fresh);
    } finally { plaintext.fill(0); }
    await afterReplace?.(file.id);
  }
  return setVersion(file.id, file.keyVersion, current);
}

export function createKeyRotation({ unit, keys, files, maintenance, options, pin }: KeyRotationDeps) {
  /** Pending to reencrypting (the start). */
  async function start(workspaceId: string): Promise<StartOutcome> {
    const read = await unit.run(async (ports) => {
      const k = await ports.rows.keys(workspaceId);
      if (!k || k.rotation !== 'pending') return null;
      return { k, state: (await ports.rows.sealState(workspaceId, { lock: false }))!, holders: await ports.rows.holders(workspaceId),
        wraps: await ports.rows.dekWraps(workspaceId), managers: await ports.rows.managers(workspaceId) };
    });
    if (!read) return 'idle';
    if (!pin) return 'locked';
    const rows = await unlockedRows(read.state, keys);
    if (!rows) return 'locked';
    const deks: Deks = new Map();
    let dek: Buffer | null = null;
    try {
      try {
        for (const version of read.k.liveVersions) deks.set(version, (await keys.key(workspaceId, rows.get(version)!)).exportDek());
      } catch { return 'locked'; }
      if (!holdersValid({ ...read, keys: read.k }, deks, pin)) {
        await recordTampering(unit, workspaceId, read.k.name, read.holders).catch((error) => { if (!(error instanceof TamperedError)) throw error; });
        return 'tampered';
      }
      const n = read.k.currentVersion;
      const next = n + 1;
      dek = newDek();
      const fresh = dek;
      let unlock: { bootId: string; sealed: string };
      try { unlock = await keys.sealForUnlock(workspaceId, next, fresh); } catch { return 'locked'; } // the keyring is down: stays pending
      const key = WorkspaceKey.fromDek(workspaceId, next, fresh);
      try {
        await unit.run(async (ports) => {
          const r = rotationRows(ports);
          const k = await ports.rows.keys(workspaceId, { lock: 'update' });
          if (!k || k.rotation !== 'pending' || k.currentVersion !== n || !sameVersions(k.liveVersions, read.k.liveVersions)) {
            throw new ConflictError('The workspace keys changed meanwhile', 'ENCRYPTION_CHANGED');
          }
          const m = { keys: k, holders: await ports.rows.holders(workspaceId), wraps: await ports.rows.dekWraps(workspaceId),
            managers: await ports.rows.managers(workspaceId) };
          if (!holdersValid(m, deks, pin)) throw new TamperSignal();
          const tombstones = await ports.rows.tombstones(workspaceId);
          // The holder set: every row verified above whose id and public key have no tombstone (a restored row is skipped,
          // and its stale MAC then makes the next unlock refuse).
          const set = m.holders.filter((holder) => !tombstones.some((t) => t.holderId === holder.id || t.publicKey === holder.publicKey));
          const commitment = keyCommitment(deks.get(n)!, workspaceId, next, fresh);
          const checkValue = keyCheckValue(key);
          await ports.rows.insertKeyVersion({ workspaceId, keyVersion: next, commitment, checkValue,
            pin: pin.version({ workspaceId, keyVersion: next, checkValue, commitment }) });
          for (const holder of set) {
            const box = sealDekToHolder(fresh, holder.publicKey, { workspaceId, holderId: holder.id, keyVersion: next });
            await ports.rows.insertDekWrap({ holderId: holder.id, workspaceId, keyVersion: next, ...box, confirm: null });
            await ports.rows.updateHolderMac(holder.id, { confirmedVersions: holder.confirmedVersions, holderMacVersion: next,
              holderMac: holderMac(fresh, next, holderIdentity(holder)) });
          }
          await r.advance(workspaceId, next);
          await r.resetProgress(workspaceId, next, r.tables()[0]!.table);
          await ports.rows.upsertUnlock(workspaceId, { keyVersion: next, bootId: unlock.bootId, sealedDek: unlock.sealed,
            unlockedBy: rows.get(n)?.unlockedBy ?? null }); // who unlocked stays named
          await ports.event(SYSTEM, workspaceId, WORKSPACE_KEY_ROTATION_STARTED_EVENT, { version: next, holders: set.map((holder) => holder.id) });
        });
      } catch (error) {
        if (error instanceof TamperSignal) {
          await recordTampering(unit, workspaceId, read.k.name, read.holders).catch((e) => { if (!(e instanceof TamperedError)) throw e; });
          return 'tampered';
        }
        if (error instanceof ConflictError && error.code === 'ENCRYPTION_CHANGED') return 'changed';
        throw error;
      }
      return 'started';
    } finally {
      zero(deks); dek?.fill(0);
    }
  }

  /** One page; null when there is nothing to do here. */
  /** Re-encrypts the stale sealed values of one page of rows, compare-and-set; returns how many changed. */
  async function reseal(r: KeyRotationRepository, seal: WorkspaceSeal, table: { table: string; columns: { column: string; field: string; kind: string }[] },
    rows: { identity: string[]; values: Record<string, unknown> }[], current: number): Promise<number> {
    let changed = 0;
    for (const row of rows) {
      for (const column of table.columns) {
        const stored = row.values[column.column];
        const envelope = column.kind === 'json' ? (stored as { $sealed?: unknown } | null)?.$sealed : stored;
        const version = envelopeVersion(envelope);
        if (version === null || version >= current) continue;
        let plaintext: string;
        try { plaintext = seal.open(column.field, row.identity, envelope as string); }
        catch { throw new StaleValueError(`${table.table}.${column.column}`); }
        const value = seal.seal(column.field, row.identity, plaintext);
        if (await r.compareAndSet(table.table, row.identity, column.column, stored, column.kind === 'json' ? { $sealed: value } : value)) changed++;
      }
    }
    return changed;
  }
  async function resealFiles(r: KeyRotationRepository, seal: WorkspaceSeal, stale: { id: string; keyVersion: number }[], current: number): Promise<number> {
    let changed = 0;
    for (const file of stale) {
      try {
        if (await rotateFileObject(seal, files!, file, current, (id, from, to) => r.setFileVersion(id, from, to), options.afterFileReplace)) changed++;
      } catch (error) {
        if (error instanceof DecryptionFailedError) throw new StaleValueError('project_files.object');
        throw error;
      }
    }
    return changed;
  }

  /**
   * The drain before the finish (S2c delta review P2-A). Pages skip rows a writer holds, so under steady writes a hot
   * row (the project row every write share-locks) could be skipped by every pass. Here, under the **exclusive** fair
   * gate, no new write can start, and writes take the gate before their first row lock, so the rows still held are
   * released by writes already inside: the drain waits for them (with a short lock timeout) and re-encrypts what is
   * left. 'busy' when a lock wait timed out.
   */
  async function drain(workspaceId: string): Promise<'drained' | 'busy' | 'idle' | 'locked'> {
    try {
      return await unit.run(async (ports) => {
        const r = rotationRows(ports);
        const k = await ports.rows.keys(workspaceId, { lock: 'update' });
        if (!k || k.rotation !== 'reencrypting') return 'idle';
        let seal: WorkspaceSeal;
        try { seal = await sealFor(ports.rows, keys, workspaceId, { write: true }); } catch (error) {
          if (error instanceof WorkspaceLockedError) return 'locked';
          throw error;
        }
        await r.lockTimeout(options.drainLockMs ?? 1_000);
        const current = k.currentVersion;
        for (const table of r.tables()) {
          let cursor: string[] | null = null;
          for (;;) {
            const rows = await r.stalePage(table.table, workspaceId, current, cursor, options.pageSize, { skipLocked: false });
            await reseal(r, seal, table, rows, current);
            if (rows.length < options.pageSize) break;
            cursor = rows[rows.length - 1]!.identity;
          }
        }
        if (files) {
          let cursor: string | null = null;
          for (;;) {
            const stale = await r.staleFiles(workspaceId, current, cursor, options.filePageSize);
            await resealFiles(r, seal, stale, current);
            if (stale.length < options.filePageSize) break;
            cursor = stale[stale.length - 1]!.id;
          }
        }
        return 'drained' as const;
      });
    } catch (error) {
      const code = (error as { code?: unknown; cause?: { code?: unknown } }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
      if (code === '55P03') return 'busy'; // lock_timeout
      throw error;
    }
  }

  async function page(workspaceId: string): Promise<'page' | 'verified' | 'locked' | 'idle'> {
    return unit.run(async (ports) => {
      const r = rotationRows(ports);
      let seal: WorkspaceSeal;
      try { seal = await sealFor(ports.rows, keys, workspaceId, { write: true }); } catch (error) {
        if (error instanceof WorkspaceLockedError) return 'locked';
        throw error;
      }
      if (!seal.sealed) return 'idle';
      const k = await ports.rows.keys(workspaceId);
      if (!k || k.rotation !== 'reencrypting') return 'idle';
      const progress = await r.progress(workspaceId, { lock: true });
      if (!progress || progress.targetVersion !== k.currentVersion) return 'idle';
      const current = k.currentVersion;
      const tables = r.tables();
      const steps = [...tables.map((t) => t.table), 'files'];
      let { step, cursor, rowsDone, passes, passChanges } = progress;
      let index = steps.indexOf(step);
      if (index < 0) { index = 0; step = steps[0]!; cursor = null; }
      let changed = 0;
      let full: boolean;
      if (step !== 'files') {
        const table = tables[index]!;
        const rows = await r.stalePage(table.table, workspaceId, current, cursor, options.pageSize);
        changed += await reseal(r, seal, table, rows, current);
        if (rows.length) cursor = rows[rows.length - 1]!.identity;
        full = rows.length === options.pageSize;
      } else {
        const stale = files ? await r.staleFiles(workspaceId, current, cursor?.[0] ?? null, options.filePageSize) : [];
        changed += await resealFiles(r, seal, stale, current);
        if (stale.length) cursor = [stale[stale.length - 1]!.id];
        full = stale.length === options.filePageSize;
      }
      rowsDone += changed; passChanges += changed;
      if (!full) {
        if (index + 1 < steps.length) { step = steps[index + 1]!; cursor = null; }
        else if (passChanges === 0) return 'verified'; // verify invariant: a complete pass that changed nothing
        else { passes += 1; passChanges = 0; step = steps[0]!; cursor = null; }
      }
      await r.saveProgress(workspaceId, { step, cursor, rowsDone, passes, passChanges });
      return 'page';
    });
  }

  /** Records once that the rotation cannot finish, and tells the holders (no content: a table and column name). */
  async function stalled(workspaceId: string, on: string): Promise<'stalled'> {
    console.error(JSON.stringify({ warning: 'Key rotation cannot finish', workspaceId, on }));
    await unit.run(async (ports) => {
      if (!await rotationRows(ports).stall(workspaceId, on)) return;
      const k = await ports.rows.keys(workspaceId);
      const managers = new Set(await ports.rows.managers(workspaceId));
      const holders = await ports.rows.holders(workspaceId);
      for (const userId of new Set(holders.map((h) => h.userId).filter((id): id is string => !!id && managers.has(id)))) {
        await ports.rows.insertSecurityNotice({ userId, workspaceId, eventId: null,
          title: `${k?.name ?? 'This space'}'s key change cannot finish yet. Ask your server's operator.` });
      }
    });
    return 'stalled';
  }

  async function finish(workspaceId: string): Promise<boolean | { stalled: string }> {
    const done = await unit.run(async (ports): Promise<boolean | { stalled: string }> => {
      const r = rotationRows(ports);
      const k = await ports.rows.keys(workspaceId, { lock: 'update' });
      if (!k || k.rotation !== 'reencrypting') return false;
      const progress = await r.progress(workspaceId, { lock: true });
      if (!progress || progress.targetVersion !== k.currentVersion) return false;
      // Under FOR UPDATE no writer can seal meanwhile, so this last check is exact.
      if (await r.anyStale(workspaceId, k.currentVersion)) {
        await r.saveProgress(workspaceId, { step: r.tables()[0]!.table, cursor: null, rowsDone: progress.rowsDone, passes: progress.passes + 1, passChanges: 0 });
        return false;
      }
      // A copy of an old-version envelope outside the registry would outlive the old key's deletion and stay openable
      // with it: refuse to finish while any table holds one for this workspace (S2c review P1-2).
      const leftover = await r.leftover(workspaceId, k.liveVersions.filter((v) => v < k.currentVersion));
      if (leftover) return { stalled: leftover };
      await r.finish(workspaceId, k.currentVersion);
      await ports.event(SYSTEM, workspaceId, WORKSPACE_KEY_ROTATED_EVENT, { version: k.currentVersion });
      return true;
    });
    if (done === true) {
      keys.forget(workspaceId); // drops the old versions' key objects; the next seal loads the current one
      await maintenance.vacuum([...new Set([...KEY_TABLES, ...unitTables()])]);
      await maintenance.checkpoint();
    }
    return done;
  }
  let registryTables: string[] = [];
  const unitTables = () => registryTables;

  /** The re-encryption pass from the stored cursor to the finish, or until locked. */
  async function pass(workspaceId: string): Promise<PassOutcome> {
    let pages = 0;
    let busy = 0;
    for (;;) {
      let outcome: Awaited<ReturnType<typeof page>>;
      try { outcome = await page(workspaceId); } catch (error) {
        // An old-version value that does not open (planted or damaged) would stop every pass here: say so (S2c review P3).
        if (error instanceof StaleValueError) return stalled(workspaceId, error.place);
        throw error;
      }
      if (outcome === 'locked' || outcome === 'idle') return outcome;
      if (outcome === 'verified') {
        const drained = await drain(workspaceId);
        if (drained === 'locked' || drained === 'idle') return drained;
        if (drained === 'busy') {
          // Writes held a row past the lock timeout three times in a row: say so, and let the next sweep try again.
          if (++busy >= 3) return stalled(workspaceId, 'write load (a row stayed locked)');
          await sleep(options.pauseMs * 10);
          continue;
        }
        busy = 0;
        const done = await finish(workspaceId);
        if (done === true) return 'finished';
        if (done !== false) return stalled(workspaceId, done.stalled);
        continue;
      }
      pages += 1;
      await options.afterPage?.(pages);
      await sleep(options.pauseMs);
    }
  }

  return {
    start,
    pass,
    /** Start when pending, then the pass; returns what stopped it. */
    async run(workspaceId: string): Promise<StartOutcome | PassOutcome> {
      if (!registryTables.length) registryTables = await unit.run(async (ports) => rotationRows(ports).tables().map((t) => t.table));
      const started = await start(workspaceId);
      if (started === 'locked' || started === 'tampered') return started;
      return pass(workspaceId);
    },
    /** Workspaces with a pending or running rotation. */
    active: () => unit.run(async (ports) => rotationRows(ports).active()),
  };
}
export type KeyRotation = ReturnType<typeof createKeyRotation>;
