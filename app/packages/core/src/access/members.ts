import type { AddMemberCommand, ChangeRoleCommand, WorkspaceMember, WorkspaceRole } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts, requireRoleAuthority } from './common.js';
import { ConflictError, InvalidInputError, NotFoundError } from './errors.js';
import { enforce, evaluateWorkspace, isManager, isUuid } from './policy.js';
import type { AccessPorts } from './repositories.js';
import { oneOf, ROLES } from './validation.js';

// Workspace membership (issues #46, #91): list, add, change a role, remove or leave. The workspace row is taken
// `FOR NO KEY UPDATE`, then the actor's membership under `lock`; the member row is `FOR UPDATE`; the event is the
// last write. `addMember` starts with the workspace row. `changeRole` and `removeMember` take the AI policy row
// before it (F-029) and, for an owner or admin of a sealed workspace losing the role, the key row before that (F-030).

type MemberPorts = Pick<AccessPorts, 'workspaces' | 'access' | 'events' | 'encryption'>;

export async function listMembers(principal: Principal, workspaceId: string, db: Database, ports: MemberPorts): Promise<WorkspaceMember[]> {
  enforce(await evaluateWorkspace(principal, 'workspace.read_members', workspaceId, ports.access(db)), 'workspace');
  const rows = await ports.workspaces(db).members(workspaceId);
  return rows.map(({ member, email, name: memberName }) => ({ userId: member.userId, email, name: memberName, role: member.role, createdAt: member.createdAt.toISOString() }));
}

/** Adds an existing account (by id or e-mail) to the workspace with a role. */
export async function addMember(principal: Principal, workspaceId: string, command: AddMemberCommand, db: Database, ports: MemberPorts,
  options: { verifiedEmailOnly?: boolean } = {}): Promise<WorkspaceMember> {
  const role = oneOf(command?.role, ROLES, 'role');
  return db.transaction(async (tx) => {
    const workspaces = ports.workspaces(tx);
    await workspaces.lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    requireRoleAuthority(actor, role);
    const lookup = typeof command.userId === 'string' ? { userId: command.userId }
      : typeof command.email === 'string' ? { email: command.email.trim().toLowerCase() } : null;
    if (!lookup) throw new InvalidInputError('userId or email is required');
    const user = await workspaces.findAccount(lookup);
    // With a sign-on provider, an address nobody has proved is not a way to find a person: the answer is the one
    // for no account at all, so a squatter on an employee's address is never added in their place (#313).
    if (!user || options.verifiedEmailOnly && typeof command.userId !== 'string' && !user.emailVerified) throw new NotFoundError('Account', 'ACCOUNT_NOT_FOUND');
    const member = await workspaces.insertMember({ workspaceId, userId: user.id, role, createdBy: principal.id });
    if (!member) throw new ConflictError('Account is already a member', 'ALREADY_MEMBER');
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.member_added.v1', workspaceId, { userId: user.id, role });
    return { userId: user.id, email: user.email, name: user.name, role, createdAt: member.createdAt.toISOString() };
  });
}

/**
 * F-030 (#655): an owner or admin of a sealed workspace losing the role (demoted, removed or leaving) takes
 * `workspace_keys` `FOR UPDATE` first, before the F-029 order. The target's role is read without a lock to decide.
 */
async function lockKeysForManagerChange(tx: Executor, ports: Pick<AccessPorts, 'encryption'>, workspaceId: string, userId: string, role: WorkspaceRole | null): Promise<boolean> {
  if (!isUuid(workspaceId)) return false;
  const rows = ports.encryption(tx);
  if (!await rows.sealed(workspaceId)) return false;
  const current = await rows.memberRole(workspaceId, userId);
  if (!isManager(current) || (role !== null && isManager(role))) return false;
  await rows.keys(workspaceId, { lock: 'update' });
  return true;
}

/** Deletes the person's unlock password (its holder; the trigger leaves a rotation pending); the last one is refused. */
async function dropUnlockPassword(tx: Executor, ports: Pick<AccessPorts, 'encryption'>, workspaceId: string, userId: string, keysLocked: boolean): Promise<void> {
  const rows = ports.encryption(tx);
  if (!keysLocked) {
    if (!await rows.sealed(workspaceId)) return;
    await rows.keys(workspaceId, { lock: 'update' }); // the role changed since the unlocked read
  }
  if (await rows.dropUnlockPassword(workspaceId, userId) === 'last') {
    throw new ConflictError('This space needs at least one unlock password. Ask another owner or admin to set theirs first.', 'LAST_UNLOCK_PASSWORD');
  }
}

export async function changeRole(principal: Principal, workspaceId: string, userId: string, command: ChangeRoleCommand, db: Database, ports: MemberPorts): Promise<WorkspaceMember> {
  const role = oneOf(command?.role, ROLES, 'role');
  return db.transaction(async (tx) => {
    // F-030 lock order: workspace_keys before the F-029 order when an owner or admin of a sealed workspace loses the role.
    const sealedChange = await lockKeysForManagerChange(tx, ports, workspaceId, userId, role);
    // F-029 lock order: the AI policy row before any membership row (the event below reads it again for agent audiences).
    await ports.access(tx).workspaceAi(workspaceId, { lock: true });
    const workspaces = ports.workspaces(tx);
    await workspaces.lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const target = await workspaces.lockMember(workspaceId, userId);
    if (!target) throw new NotFoundError('Member', 'MEMBER_NOT_FOUND');
    requireRoleAuthority(actor, target.role, role);
    if (target.role === 'owner' && role !== 'owner' && await workspaces.ownerCount(workspaceId) <= 1) throw new ConflictError('A workspace needs at least one owner', 'LAST_OWNER');
    if (isManager(target.role) && !isManager(role)) await dropUnlockPassword(tx, ports, workspaceId, userId, sealedChange);
    const updated = await workspaces.setRole(workspaceId, userId, role);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.member_role_changed.v1', workspaceId, { userId, from: target.role, role });
    const user = await workspaces.findAccount({ userId });
    return { userId, email: user!.email, name: user!.name, role, createdAt: updated.createdAt.toISOString() };
  });
}

/**
 * Removes a membership (and, through the database, the member's project grants). Any
 * member may leave; removing someone else needs workspace.manage_members.
 */
export async function removeMember(principal: Principal, workspaceId: string, userId: string, db: Database, ports: MemberPorts): Promise<void> {
  await db.transaction(async (tx) => {
    const sealedChange = await lockKeysForManagerChange(tx, ports, workspaceId, userId, null);
    // F-029 lock order: the AI policy row before any membership row.
    await ports.access(tx).workspaceAi(workspaceId, { lock: true });
    const workspaces = ports.workspaces(tx);
    await workspaces.lock(workspaceId);
    const self = principal.kind === 'human' && principal.id === userId;
    const { actor } = enforce(await evaluateWorkspace(principal, self ? 'workspace.read' : 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const target = await workspaces.lockMember(workspaceId, userId);
    if (!target) throw new NotFoundError('Member', 'MEMBER_NOT_FOUND');
    if (!self) requireRoleAuthority(actor, target.role);
    if (target.role === 'owner' && await workspaces.ownerCount(workspaceId) <= 1) throw new ConflictError('A workspace needs at least one owner', 'LAST_OWNER');
    if (isManager(target.role)) await dropUnlockPassword(tx, ports, workspaceId, userId, sealedChange);
    await workspaces.deleteMember(workspaceId, userId);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.member_removed.v1', workspaceId, { userId });
  });
}
