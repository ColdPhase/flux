import { DecryptionFailedError } from './primitives.js';
import { openField, sealField, type FieldPlace } from './envelope.js';
import { fileEncryptor, openFileObject } from './files.js';
import { WorkspaceLockedError } from './errors.js';
import { identitySeal, sha256Hex, type WorkspaceSeal } from './ports.js';
import type { WorkspaceKey } from './keys.js';
import type { ProcessKeys, UnlockRow } from './process-keys.js';

/** What `sealFor` reads in the operation's own transaction. */
export interface SealState {
  name: string;
  encrypted: boolean;
  tampered: boolean;
  currentVersion: number;
  liveVersions: number[];
  unlocks: UnlockRow[];
}

/** Rows only (`@flux/db` `workspaceEncryptionRows`); with `lock` the unlock rows are read `FOR SHARE`. */
export interface SealStateReader {
  sealState(workspaceId: string, options: { lock: boolean }): Promise<SealState | null>;
}

/**
 * Whether every live version has an unlock row of the boot this process knows. A row of another boot sends one
 * boot check to the keyring first (the keyring may have restarted since the last heartbeat).
 */
export async function unlockedRows(state: SealState, keys: ProcessKeys): Promise<Map<number, UnlockRow> | null> {
  // `tampered` is for display and alerting only; unlock verifies everything itself (F-030, not sticky).
  if (!keys.swapSafe || !state.liveVersions.length) return null;
  const rows = new Map(state.unlocks.map((row) => [row.keyVersion, row]));
  if (state.liveVersions.some((version) => !rows.has(version))) return null;
  if (state.liveVersions.some((version) => rows.get(version)!.bootId !== keys.bootId)) await keys.refresh(); // negative-cached while the keyring is down
  if (!keys.bootId || state.liveVersions.some((version) => rows.get(version)!.bootId !== keys.bootId)) return null;
  return rows;
}

/**
 * `sealFor(tx, workspaceId, { write })` (F-030 Enforcement): the identity seal for a workspace that is not sealed; for
 * a sealed one the real seal when every live version is unlocked under the current boot, or `WorkspaceLockedError`
 * (423). There is no plaintext fallback. Writes read the unlock rows `FOR SHARE` first, before every other lock, so a
 * Lock is ordered strictly before or after each write. Stale rows are deleted by the heartbeat, not here, so a failed
 * operation's rollback cannot keep them.
 */
export async function sealFor(reader: SealStateReader, keys: ProcessKeys, workspaceId: string, options: { write: boolean }): Promise<WorkspaceSeal> {
  const state = await reader.sealState(workspaceId, { lock: options.write });
  if (!state || !state.encrypted) return identitySeal(workspaceId);
  const rows = await unlockedRows(state, keys);
  if (!rows) {
    keys.forget(workspaceId);
    throw new WorkspaceLockedError(workspaceId, state.name);
  }
  const byVersion = new Map<number, WorkspaceKey>();
  try {
    for (const version of state.liveVersions) byVersion.set(version, await keys.key(workspaceId, rows.get(version)!));
  } catch {
    keys.forget(workspaceId);
    throw new WorkspaceLockedError(workspaceId, state.name);
  }
  return realSeal(workspaceId, state.currentVersion, byVersion);
}

/** The seal over a workspace's live keys: new values under the current version, reads by the envelope's version. */
export function realSeal(workspaceId: string, currentVersion: number, keys: ReadonlyMap<number, WorkspaceKey>): WorkspaceSeal {
  const current = keys.get(currentVersion);
  if (!current) throw new DecryptionFailedError();
  const keyFor = (version: number) => keys.get(version);
  const place = (field: string, identity: readonly string[]): FieldPlace => ({ workspaceId, field, identity });
  const open = (field: string, identity: readonly string[], envelope: string) => openField(keyFor, place(field, identity), envelope);
  return {
    sealed: true, workspaceId, currentVersion,
    seal: (field, identity, value) => sealField(current, place(field, identity), value),
    open,
    digest: (field, identity, bytes) => sealField(current, place(field, identity), sha256Hex(bytes)),
    digestMatches: (field, identity, stored, bytes) => {
      try { return open(field, identity, stored) === sha256Hex(bytes); } catch { return false; }
    },
    fileCipher: (fileId) => ({
      encryptor: () => fileEncryptor(current, fileId),
      open: (object) => openFileObject(keyFor, workspaceId, fileId, object),
    }),
  };
}
