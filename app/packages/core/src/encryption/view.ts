import type { WorkspaceEncryption, WorkspaceRole } from '@flux/contracts';

/** What the view needs about one sealed workspace for one reader (`@flux/db` `workspaceEncryptionRows().views`). */
export interface EncryptionViewInput {
  tampered: boolean;
  liveVersions: number[];
  unlocks: { keyVersion: number; bootId: string; unlockedAt: Date; unlockedBy: string | null; unlockedByName: string | null }[];
  myPassword: boolean;
  /** When a holder's grant for this reader to set a first password ends (a valid one only). */
  grantUntil: Date | null;
  recoveryCode: boolean;
  keyChangedAt: Date | null;
}

/** A sealed workspace whose key rows are missing reads as locked (fail closed). */
export const MISSING_ENCRYPTION_VIEW: EncryptionViewInput = { tampered: false, liveVersions: [], unlocks: [], myPassword: false, grantUntil: null, recoveryCode: false, keyChangedAt: null };

/**
 * `Workspace.encryption` for one reader (F-030 API). Unlocked only when every live version has an unlock row of
 * `bootId`, the boot under which the reading process can open keys (null: keyring unreachable or swap unsafe, so locked;
 * a caller that does not know it reads locked too). `myPassword`, `canUnlock` and `passwordGrantUntil` are filled for owners and admins only; who unlocked is named for everyone
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
    passwordGrantUntil: manager && !input.myPassword && input.grantUntil ? input.grantUntil.toISOString() : null,
    recoveryCode: input.recoveryCode,
    rotation: null,
    keyChangedAt: input.keyChangedAt ? input.keyChangedAt.toISOString() : null,
  };
}
