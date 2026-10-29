import { ConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { WORKSPACE_ENCRYPTION_TAMPERED_EVENT } from '@flux/contracts';
import { canonicalVersions, holderMacValid, type HolderIdentity } from './holders.js';
import type { DekWrapRecord, EncryptionUnitOfWork, HolderRecord, KeysRecord } from './service-ports.js';

/**
 * The holder-set checks shared by unlock, the password routes and the rotation (F-030 Authenticating holders and
 * wraps). Pure functions over rows; the callers hold the DEKs.
 */
export type Deks = Map<number, Buffer>;
export const zero = (deks: Deks | null | undefined) => { for (const dek of deks?.values() ?? []) dek.fill(0); };

export const SYSTEM: Principal = { kind: 'fixture', id: 'keyring' };

export const holderPlace = (holder: Pick<HolderRecord, 'workspaceId' | 'id' | 'kind' | 'userId'>) =>
  ({ workspaceId: holder.workspaceId, holderId: holder.id, kind: holder.kind, userId: holder.userId });

export const holderIdentity = (holder: HolderRecord, confirmedVersions: readonly number[] = holder.confirmedVersions): HolderIdentity =>
  ({ ...holderPlace(holder), publicKey: holder.publicKey, kdf: holder.kdf, wrappedPrivate: holder.wrappedPrivate, secretCheck: holder.secretCheck,
    confirmedVersions: canonicalVersions(confirmedVersions) });

export interface HolderSetInput { keys: KeysRecord; holders: HolderRecord[]; wraps: DekWrapRecord[]; managers: string[] }

/** The live versions the holder's wraps confirm. */
export function confirmedLive(keys: Pick<KeysRecord, 'liveVersions'>, wraps: DekWrapRecord[], holderId: string): number[] {
  return canonicalVersions(wraps.filter((wrap) => wrap.holderId === holderId && wrap.confirm !== null && keys.liveVersions.includes(wrap.keyVersion))
    .map((wrap) => wrap.keyVersion));
}

/**
 * One holder row verifies: its MAC under the current DEK (over its confirmed set, so a deleted confirmation of a listed
 * live version is tampering), its confirmed set restricted to the live versions equals the confirmations present, and
 * a password holder is an owner or admin now.
 */
export function holderValid(m: HolderSetInput, current: Buffer, holder: HolderRecord): boolean {
  const live = m.keys.liveVersions;
  const listed = canonicalVersions(holder.confirmedVersions.filter((v) => live.includes(v)));
  const present = confirmedLive(m.keys, m.wraps, holder.id);
  return holder.holderMacVersion === m.keys.currentVersion
    && holderMacValid(current, m.keys.currentVersion, holderIdentity(holder), holder.holderMac)
    && listed.length === present.length && listed.every((v, i) => v === present[i])
    && (holder.kind === 'recovery' || (holder.userId !== null && m.managers.includes(holder.userId)));
}

/** Every holder row verifies under the current DEK (unlocking: one rogue or stale row locks the workspace). */
export function holdersValid(m: HolderSetInput, deks: Deks): boolean {
  const current = deks.get(m.keys.currentVersion);
  return !!current && m.holders.every((holder) => holderValid(m, current, holder));
}

export class TamperedError extends ConflictError {
  constructor(name: string) { super(`${name}'s encryption keys were changed outside Flux. It stays locked.`, 'ENCRYPTION_TAMPERED'); }
}
/** Raised inside a unit of work; turned into the tampering record after its rollback. */
export class TamperSignal extends Error {}

/** Records tampering once (event and a `security` notice to every holder), then refuses. */
export async function recordTampering(unit: EncryptionUnitOfWork, workspaceId: string, name: string, holders: HolderRecord[]): Promise<never> {
  await unit.run(async (ports) => {
    if (!await ports.rows.markTampered(workspaceId)) return;
    const eventId = await ports.event(SYSTEM, workspaceId, WORKSPACE_ENCRYPTION_TAMPERED_EVENT, {});
    const managers = new Set(await ports.rows.managers(workspaceId));
    for (const userId of new Set(holders.map((holder) => holder.userId).filter((id): id is string => !!id && managers.has(id))))
      await ports.rows.insertSecurityNotice({ userId, workspaceId, eventId, title: `${name}'s encryption keys were changed outside Flux. It stays locked.` });
  });
  throw new TamperedError(name);
}
