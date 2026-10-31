import type { WorkspaceEncryption, WorkspaceRole } from '@flux/contracts';

/** What the view needs about one sealed workspace for one reader (`@flux/db` `workspaceEncryptionRows().views`). */
export interface EncryptionViewInput {
  tampered: boolean;
  liveVersions: number[];
  unlocks: { keyVersion: number; bootId: string; unlockedAt: Date; unlockedBy: string | null; unlockedByName: string | null }[];
  myPassword: boolean;
  recoveryCode: boolean;
  keyChangedAt: Date | null;
  rotation?: 'none' | 'pending' | 'reencrypting';
  rotationProgress?: { rowsDone: number; rowsEstimate: number; startedAt: Date; stalled?: boolean } | null;
  /** The holders of the current version while a rotation runs (who the new key opens for). */
  rotationOpenFor?: { userId: string | null; name: string | null; kind: 'password' | 'recovery' }[];
  rotationReason?: { kind: string; userId: string | null; name: string | null } | null;
}

/** A sealed workspace whose key rows are missing reads as locked (fail closed). */
export const MISSING_ENCRYPTION_VIEW: EncryptionViewInput = { tampered: false, liveVersions: [], unlocks: [], myPassword: false, recoveryCode: false, keyChangedAt: null };

/**
 * `Workspace.encryption` for one reader (F-030 API). Unlocked only when every live version has an unlock row of
 * `bootId`, the boot under which the reading process can open keys (null: keyring unreachable or swap unsafe, so locked;
 * a caller that does not know it reads locked too). `myPassword` and `canUnlock` are filled for owners and admins only; who unlocked is named for everyone
 * but guests.
 */
export function presentEncryption(input: EncryptionViewInput, role: WorkspaceRole | null, bootId: string | null): WorkspaceEncryption {
  const rows = new Map(input.unlocks.map((row) => [row.keyVersion, row]));
  const unlocked = input.liveVersions.length > 0 && bootId !== null
    && input.liveVersions.every((version) => rows.has(version) && rows.get(version)!.bootId === bootId);
  const latest = unlocked ? input.unlocks.reduce<EncryptionViewInput['unlocks'][number] | null>((a, b) => (!a || b.unlockedAt > a.unlockedAt ? b : a), null) : null;
  const manager = role === 'owner' || role === 'admin';
  const named = role !== null && role !== 'guest' && latest?.unlockedBy && latest.unlockedByName;
  return {
    state: unlocked ? 'unlocked' : 'locked',
    unlockedAt: latest ? latest.unlockedAt.toISOString() : null,
    unlockedBy: named ? { id: latest!.unlockedBy!, name: latest!.unlockedByName! } : null,
    myPassword: manager && input.myPassword,
    canUnlock: manager && (input.myPassword || input.recoveryCode),
    recoveryCode: input.recoveryCode,
    rotation: rotationView(input, unlocked, role),
    keyChangedAt: input.keyChangedAt ? input.keyChangedAt.toISOString() : null,
  };
}

/**
 * The `rotation` wire field (S2c): null when none is pending or running. Paused while locked or pending (a removal while
 * locked waits for the next unlock); the percent is of the values the pass found below the new version at its start.
 */
function rotationView(input: EncryptionViewInput, unlocked: boolean, role: WorkspaceRole | null): WorkspaceEncryption['rotation'] {
  if (!input.rotation || input.rotation === 'none') return null;
  const progress = input.rotation === 'reencrypting' ? input.rotationProgress ?? null : null;
  const percent = progress ? (progress.rowsEstimate > 0 ? Math.min(99, Math.floor((progress.rowsDone / progress.rowsEstimate) * 100)) : 99) : 0;
  return { percent, paused: !unlocked || input.rotation === 'pending', startedAt: progress ? progress.startedAt.toISOString() : null,
    stalled: progress?.stalled === true,
    openFor: (role === 'owner' || role === 'admin') && input.rotation === 'reencrypting'
      ? (input.rotationOpenFor ?? []).map((h) => ({ userId: h.userId, name: h.kind === 'recovery' ? 'Recovery code' : h.name ?? 'Someone', kind: h.kind }))
      : [],
    reason: role !== null && role !== 'guest' && input.rotationReason && ['removed', 'demoted', 'holder_deleted'].includes(input.rotationReason.kind)
      ? { kind: input.rotationReason.kind as 'removed' | 'demoted' | 'holder_deleted', userId: input.rotationReason.userId, name: input.rotationReason.name }
      : null };
}
