import type { WorkspaceRole } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Executor, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ConflictError } from './errors.js';
import { isManager, isUuid } from './policy.js';
import type { AccessPorts } from './repositories.js';

// What happens to a person's place in the company's encrypted spaces when the company changes under them (F-030, C-24), and the key-row
// locking a manager's change of role needs first. Split from members.ts (#91: the access use cases stay small).

export type MemberPorts = Pick<AccessPorts, 'workspaces' | 'access' | 'events' | 'encryption'>;

/**
 * F-030 (#655): an owner or admin of a sealed workspace losing the role (demoted, removed or leaving) takes
 * `workspace_keys` `FOR UPDATE` first, before the F-029 order. The target's role is read without a lock to decide.
 */
export async function lockKeysForManagerChange(tx: Executor, ports: Pick<AccessPorts, 'encryption'>, workspaceId: string, userId: string, role: WorkspaceRole | null): Promise<boolean> {
  if (!isUuid(workspaceId)) return false;
  const rows = ports.encryption(tx);
  if (!await rows.sealed(workspaceId)) return false;
  const current = await rows.memberRole(workspaceId, userId);
  if (!isManager(current) || (role !== null && isManager(role))) return false;
  await rows.keys(workspaceId, { lock: 'update' });
  return true;
}

/** Deletes the person's unlock password (its holder; the trigger leaves a rotation pending); the last one is refused. */
export async function dropUnlockPassword(tx: Executor, ports: Pick<AccessPorts, 'encryption'>, workspaceId: string, userId: string, keysLocked: boolean): Promise<void> {
  const rows = ports.encryption(tx);
  if (!keysLocked) {
    if (!await rows.sealed(workspaceId)) return;
    await rows.keys(workspaceId, { lock: 'update' }); // the role changed since the unlocked read
  }
  if (await rows.dropUnlockPassword(workspaceId, userId) === 'last') {
    throw new ConflictError('This space needs at least one unlock password. Ask another owner or admin to set theirs first.', 'LAST_UNLOCK_PASSWORD');
  }
}

/**
 * Ends the person's place in every encrypted space of the company, because they left it or became its guest. If they are the only owner,
 * or hold the only unlock password, of any of them, nothing is ended: the change is refused whole and names every such space, so the
 * company's admin can ask them to hand it over, or delete it, which is theirs to do (C-24). The data never loses its last keyholder.
 */
export async function endPlacesInEncryptedSpaces(principal: Principal, companyId: string, userId: string, tx: Executor, ports: MemberPorts): Promise<void> {
  const workspaces = ports.workspaces(tx);
  const spaces = await workspaces.spacesOfCompanyWith(companyId, userId);
  const alone: string[] = [];
  for (const spaceId of spaces) {
    const role = await ports.encryption(tx).memberRole(spaceId, userId);
    const holders = isManager(role) ? await ports.encryption(tx).passwordHolders(spaceId) : [];
    const sole = (role === 'owner' && await workspaces.ownerCount(spaceId) <= 1) || (holders.length === 1 && holders[0] === userId);
    if (sole) alone.push((await workspaces.get(spaceId))?.name ?? 'an encrypted space');
  }
  if (alone.length) throw keyholderRefusal(alone);
  for (const spaceId of spaces) await leaveEncryptedSpace(principal, spaceId, userId, tx, ports);
}

/** The refusal that names the spaces: `details.spaces` is what the people panel words. */
function keyholderRefusal(names: string[]): ConflictError {
  const list = names.map((name) => `“${name}”`).join(', ');
  return Object.assign(new ConflictError(`They are the only owner, or the only unlock password, of the encrypted ${names.length === 1 ? 'space' : 'spaces'} ${list}. Ask them to hand ${names.length === 1 ? 'it' : 'each'} over (another owner with an unlock password), or delete ${names.length === 1 ? 'it' : 'them'} in Settings › Company; then they can go.`,
    'ENCRYPTED_SPACE_LAST_KEYHOLDER'), { details: { spaces: names } });
}

/**
 * One person's place in one encrypted space ends: the same steps as removing them from it, in the company change's transaction (the
 * company's rows are held first, then the space's keys, then its rows). `endPlacesInEncryptedSpaces` has refused the sole keyholder
 * already; the checks here are the same under the space's locks, in case someone changed it meanwhile.
 */
async function leaveEncryptedSpace(principal: Principal, spaceId: string, userId: string, tx: Executor, ports: MemberPorts): Promise<void> {
  const sealedChange = await lockKeysForManagerChange(tx, ports, spaceId, userId, null);
  const workspaces = ports.workspaces(tx);
  await workspaces.lock(spaceId);
  const target = await workspaces.lockMember(spaceId, userId);
  if (!target) return;
  const onlyKeyholder = async () => keyholderRefusal([(await workspaces.get(spaceId))?.name ?? 'an encrypted space']);
  if (target.role === 'owner' && await workspaces.ownerCount(spaceId) <= 1) throw await onlyKeyholder();
  if (isManager(target.role)) {
    try { await dropUnlockPassword(tx, ports, spaceId, userId, sealedChange); } catch (error) {
      throw error instanceof ConflictError && error.code === 'LAST_UNLOCK_PASSWORD' ? await onlyKeyholder() : error;
    }
  }
  await workspaces.deleteMember(spaceId, userId);
  await workspaces.recordRemoved(spaceId, userId, principal.id);
  if (sealedChange) await ports.encryption(tx).recordRemovals(spaceId);
  await recordEvent(eventPorts(ports, tx), principal, spaceId, 'workspace.member_removed.v1', spaceId, { userId });
}
