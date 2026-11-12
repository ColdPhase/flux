import type { AddMemberCommand, ChangeRoleCommand, RemovedPerson, WorkspaceMember } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts, recordAccessEnded, requireRoleAuthority } from './common.js';
import { ConflictError, InvalidInputError, NotFoundError } from './errors.js';
import { dropUnlockPassword, endPlacesInEncryptedSpaces, lockKeysForManagerChange, type MemberPorts } from './encrypted-places.js';
import { requireSpacePerson } from './space-person.js';
import { roundedLastActive, type LastActiveOptions } from './last-active.js';
import { enforce, evaluateWorkspace, isManager } from './policy.js';
import { oneOf, ROLES } from './validation.js';

// Workspace membership (issues #46, #91): list, add, change a role, remove or leave. The workspace row is taken
// `FOR NO KEY UPDATE`, then the actor's membership under `lock`; the member row is `FOR UPDATE`; the event is the
// last write. `addMember` starts with the workspace row. `changeRole` and `removeMember` take the AI policy row
// before it (F-029) and, for an owner or admin of a sealed workspace losing the role, the key row before that (F-030).


/**
 * The company's people. A reader who is not a guest sees each person's rounded last-active time when the caller says whose days to count in
 * (`lastActive`, C-58); a guest cannot read this list at all, so no guest sees the time of a person they share no space with.
 */
export async function listMembers(principal: Principal, workspaceId: string, db: Database, ports: MemberPorts, options: { lastActive?: LastActiveOptions } = {}): Promise<WorkspaceMember[]> {
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read_members', workspaceId, ports.access(db)), 'workspace');
  const rows = await ports.workspaces(db).members(workspaceId);
  // F-030: an owner or admin of an encrypted workspace also learns which owners and admins have an unlock password, to offer
  // "Let Ben set an unlock password" only to those who lack one. A plain workspace has no holders, so the field stays out.
  const holders = isManager(actor.role) ? new Set(await ports.encryption(db).passwordHolders(workspaceId)) : new Set<string>();
  const now = new Date();
  return rows.map(({ member, email, name: memberName, lastActiveAt, showLastActive }) => {
    const lastActive = options.lastActive ? roundedLastActive({ lastActiveAt, showLastActive }, options.lastActive, now) : undefined;
    return {
      userId: member.userId, email, name: memberName, role: member.role, createdAt: member.createdAt.toISOString(),
      ...(holders.size && isManager(member.role) ? { unlockPassword: holders.has(member.userId) } : {}),
      ...(lastActive ? { lastActiveAt: lastActive } : {}),
    };
  });
}

/** Who left the company or was removed and has not joined again (Settings › Company). */
export async function listRemovedPeople(principal: Principal, workspaceId: string, db: Database, ports: MemberPorts): Promise<RemovedPerson[]> {
  enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(db)), 'workspace');
  return (await ports.workspaces(db).removedPeople(workspaceId)).map((person) => ({ ...person, removedAt: person.removedAt.toISOString() }));
}

/**
 * Brings someone back as a member (Hubert, 2026-11-05). They are in Everyone again and sign in as usual; other spaces are
 * added by hand, because leaving ended their grants.
 */
export async function restoreMember(principal: Principal, workspaceId: string, userId: string, db: Database, ports: MemberPorts): Promise<WorkspaceMember> {
  return db.transaction(async (tx) => {
    const workspaces = ports.workspaces(tx);
    await workspaces.lock(workspaceId);
    enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const person = (await workspaces.removedPeople(workspaceId)).find((entry) => entry.userId === userId);
    if (!person) throw new NotFoundError('Person', 'REMOVED_PERSON_NOT_FOUND');
    // An encrypted space brings back only someone who is in the company now and not its guest, as adding does (review of #976, round 2).
    const company = await workspaces.companyOf(workspaceId);
    if (company) requireSpacePerson(await ports.encryption(tx).memberRole(company, userId, { lock: true }));
    const member = await workspaces.insertMember({ workspaceId, userId, role: 'member', createdBy: principal.id });
    if (!member) throw new ConflictError('Account is already a member', 'ALREADY_MEMBER');
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.member_added.v1', workspaceId, { userId, role: 'member' });
    return { userId, email: person.email, name: person.name, role: 'member', createdAt: member.createdAt.toISOString() };
  });
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
    // An encrypted space takes only the company's people, and no guest (C-24): its admins hold its keys, and a guest cannot start spaces.
    // The company's own members row is held while it is read, so leaving the company waits for this.
    const company = await workspaces.companyOf(workspaceId);
    if (company) {
      requireSpacePerson(await ports.encryption(tx).memberRole(company, user.id, { lock: true }));
      if (role === 'guest') throw new ConflictError('Guests cannot be in an encrypted space', 'ENCRYPTED_SPACE_NO_GUESTS');
    }
    const member = await workspaces.insertMember({ workspaceId, userId: user.id, role, createdBy: principal.id });
    if (!member) throw new ConflictError('Account is already a member', 'ALREADY_MEMBER');
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.member_added.v1', workspaceId, { userId: user.id, role });
    return { userId: user.id, email: user.email, name: user.name, role, createdAt: member.createdAt.toISOString() };
  });
}

export async function changeRole(principal: Principal, workspaceId: string, userId: string, command: ChangeRoleCommand, db: Database, ports: MemberPorts): Promise<WorkspaceMember> {
  const role = oneOf(command?.role, ROLES, 'role');
  return db.transaction(async (tx) => {
    // F-030 lock order: workspace_keys before the membership rows when an owner or admin of a sealed workspace loses the role.
    const sealedChange = await lockKeysForManagerChange(tx, ports, workspaceId, userId, role);
    const workspaces = ports.workspaces(tx);
    await workspaces.lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const target = await workspaces.lockMember(workspaceId, userId);
    if (!target) throw new NotFoundError('Member', 'MEMBER_NOT_FOUND');
    requireRoleAuthority(actor, target.role, role);
    // Nobody in an encrypted space is a guest (C-24).
    if (role === 'guest' && await workspaces.companyOf(workspaceId)) throw new ConflictError('Guests cannot be in an encrypted space', 'ENCRYPTED_SPACE_NO_GUESTS');
    if (target.role === 'owner' && role !== 'owner' && await workspaces.ownerCount(workspaceId) <= 1) throw new ConflictError('The company needs at least one owner', 'LAST_OWNER');
    if (isManager(target.role) && !isManager(role)) await dropUnlockPassword(tx, ports, workspaceId, userId, sealedChange);
    const updated = await workspaces.setRole(workspaceId, userId, role);
    if (role === 'guest') {
      // Their agents, API keys and client connections are not touched: they are kept, hidden and refused while the person is a guest, and
      // come back if they are a member again (AG-2, C-50). Every list and lookup of them reads the company role now.
      await workspaces.endSpaceAdmin(workspaceId, userId);
      // A guest of the company is in no encrypted space: becoming one ends the place, as leaving does, with the same key change (C-24).
      await endPlacesInEncryptedSpaces(principal, workspaceId, userId, tx, ports);
    }
    // The trigger deleted their holder and the recovery holder; their removal records are pinned now, in this transaction.
    if (sealedChange) await ports.encryption(tx).recordRemovals(workspaceId);
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
    const workspaces = ports.workspaces(tx);
    await workspaces.lock(workspaceId);
    const self = principal.kind === 'human' && principal.id === userId;
    const { actor } = enforce(await evaluateWorkspace(principal, self ? 'workspace.read' : 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const target = await workspaces.lockMember(workspaceId, userId);
    if (!target) throw new NotFoundError('Member', 'MEMBER_NOT_FOUND');
    if (!self) requireRoleAuthority(actor, target.role);
    if (target.role === 'owner' && await workspaces.ownerCount(workspaceId) <= 1) throw new ConflictError('The company needs at least one owner', 'LAST_OWNER');
    if (isManager(target.role)) await dropUnlockPassword(tx, ports, workspaceId, userId, sealedChange);
    await workspaces.deleteMember(workspaceId, userId);
    await workspaces.recordRemoved(workspaceId, userId, principal.id);
    if (sealedChange) await ports.encryption(tx).recordRemovals(workspaceId);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.member_removed.v1', workspaceId, { userId });
    await recordAccessEnded(ports, tx, principal, workspaceId, userId);
    // Leaving the company ends a person's place in its encrypted spaces too, with the same key change as leaving one (C-24).
    await endPlacesInEncryptedSpaces(principal, workspaceId, userId, tx, ports);
  });
}
