import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  INVITE_CREATED_EVENT, INVITE_DEFAULT_EXPIRY_DAYS, INVITE_EXPIRY_DAYS, INVITE_JOIN_PAGE, INVITE_REVOKED_EVENT,
  type AcceptInviteResult, type CreateInviteCommand, type InvitePreview, type InviteRole, type WorkspaceInvite, type WorkspaceRole,
} from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ConflictError, ForbiddenError, GoneError, InvalidInputError, NotFoundError } from './errors.js';
import { enforce, evaluateWorkspace, isManager } from './policy.js';
import { inviteIdOf, inviteToken, inviteTokenHash, type InviteSigner } from './invite-tokens.js';
import type { AccessPorts, InviteRepository, InviteRow } from './repositories.js';

export { inviteIdOf, inviteToken, inviteTokenHash, type InviteSigner };

// Invite links (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035). An owner or admin creates a
// one-time link with a role; whoever holds it signs in or signs up and joins. The token is the invite id and an HMAC
// of it under a key derived from the server's identity secret; only its SHA-256 is stored. Every unknown, malformed or
// forged token is the same 404, so someone without the link learns nothing. Accepting takes the workspace row first
// (as `addMember`), then the invite row `FOR UPDATE`, and rechecks everything there.

type InvitePorts = Pick<AccessPorts, 'workspaces' | 'invites' | 'access' | 'events'>;

const INVITE_ROLES: readonly InviteRole[] = ['admin', 'member', 'guest'];
const MAX_PENDING = 50;
const DAY_MS = 86_400_000;

const linkOf = (signer: InviteSigner, inviteId: string) => `${signer.publicOrigin}${INVITE_JOIN_PAGE}#${inviteToken(signer, inviteId)}`;

function presentWithoutLink(row: InviteRow, creatorName: string): Omit<WorkspaceInvite, 'link'> {
  return {
    id: row.id, workspaceId: row.workspaceId, role: row.role, email: row.email, createdBy: { id: row.createdBy, name: creatorName },
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
  };
}

const present = (signer: InviteSigner, row: InviteRow, creatorName: string): WorkspaceInvite =>
  ({ ...presentWithoutLink(row, creatorName), link: linkOf(signer, row.id) });

function normalizeEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new InvalidInputError('email must be a string');
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new InvalidInputError('email is not an email address');
  return email;
}

/** A pending invite of the workspace, without its link (the route adds it, so no stored answer holds a token). */
export type CreatedInvite = Omit<WorkspaceInvite, 'link'>;

/** Creates a one-time invite link (owners and admins; `admin` needs an owner). The answer has no link: see `withLink`. */
export async function createInvite(principal: Principal, workspaceId: string, command: CreateInviteCommand, db: Database, ports: InvitePorts,
  signer: InviteSigner, now = new Date()): Promise<CreatedInvite> {
  const role = command?.role;
  if (!INVITE_ROLES.includes(role)) throw new InvalidInputError('role must be admin, member or guest');
  const days = command.expiresInDays ?? INVITE_DEFAULT_EXPIRY_DAYS;
  if (!(INVITE_EXPIRY_DAYS as readonly number[]).includes(days)) throw new InvalidInputError('expiresInDays must be 1, 7 or 30');
  const email = normalizeEmail(command.email);
  return db.transaction(async (tx) => {
    await ports.workspaces(tx).lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    // An invite never makes an owner, and only an owner may hand out admin.
    if (role === 'admin' && actor.role !== 'owner') throw new ForbiddenError('Only an owner can invite an admin', 'OWNER_REQUIRED');
    const invites = ports.invites(tx);
    if (await invites.pendingCount(workspaceId, now) >= MAX_PENDING) throw new ConflictError(`A workspace holds at most ${MAX_PENDING} pending invite links`, 'INVITE_LIMIT');
    const id = randomUUID();
    const row = await invites.insert({ id, workspaceId, role, email, tokenHash: inviteTokenHash(inviteToken(signer, id)), createdBy: principal.id,
      expiresAt: new Date(now.getTime() + days * DAY_MS) });
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, INVITE_CREATED_EVENT, workspaceId, { inviteId: id, role });
    const creator = await ports.workspaces(tx).findAccount({ userId: principal.id });
    return presentWithoutLink(row, creator?.name ?? '');
  });
}

/** The invite as its owners and admins see it, with the link derived again (a stored idempotent answer never holds it). */
export function withLink(signer: InviteSigner, invite: CreatedInvite): WorkspaceInvite {
  return { ...invite, link: linkOf(signer, invite.id) };
}

export async function listInvites(principal: Principal, workspaceId: string, db: Database, ports: InvitePorts, signer: InviteSigner,
  now = new Date()): Promise<WorkspaceInvite[]> {
  enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(db)), 'workspace');
  const rows = await ports.invites(db).pending(workspaceId, now);
  return rows.map(({ invite, creatorName }) => present(signer, invite, creatorName));
}

/** Revokes a pending invite (owners and admins); anything else is `404 INVITE_NOT_FOUND`. */
export async function revokeInvite(principal: Principal, workspaceId: string, inviteId: string, db: Database, ports: InvitePorts, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await ports.workspaces(tx).lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const invites = ports.invites(tx);
    const found = await invites.get(inviteId, { lock: true });
    if (!found || found.invite.workspaceId !== workspaceId || found.invite.revokedAt || found.invite.acceptedAt || found.invite.expiresAt <= now) {
      throw new NotFoundError('Invite', 'INVITE_NOT_FOUND');
    }
    // An admin may revoke a member or guest link; an admin link was an owner's and only an owner revokes it.
    if (found.invite.role === 'admin' && actor.role !== 'owner') throw new ForbiddenError('Only an owner can revoke an admin invite', 'OWNER_REQUIRED');
    await invites.revoke(inviteId, principal.id, now);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, INVITE_REVOKED_EVENT, workspaceId, { inviteId });
  });
}

type Found = NonNullable<Awaited<ReturnType<InviteRepository['get']>>>;

/** The invite a token names (404 for anything else), checked against the stored hash in constant time. */
async function find(signer: InviteSigner, token: unknown, repository: InviteRepository, lock: boolean): Promise<Found> {
  const id = inviteIdOf(signer, token);
  const found = id ? await repository.get(id, { lock }) : null;
  const stored = found ? Buffer.from(found.invite.tokenHash, 'hex') : null;
  const given = Buffer.from(inviteTokenHash(String(token)), 'hex');
  if (!found || !stored || stored.length !== given.length || !timingSafeEqual(stored, given)) throw new NotFoundError('Invite', 'INVITE_NOT_FOUND');
  return found;
}

/**
 * Why a found invite no longer works, or null: used by another account (or by this one when `self` is false), revoked,
 * expired, or its creator is no longer an owner or admin who could grant its role.
 */
async function goneReason(found: Found, self: string | null, ports: InvitePorts, db: Database, now: Date): Promise<GoneError | null> {
  const { invite } = found;
  if (invite.acceptedAt) return invite.acceptedBy && invite.acceptedBy === self ? null : new GoneError('This invite link was already used', 'INVITE_USED');
  if (invite.revokedAt) return new GoneError('This invite link was revoked', 'INVITE_REVOKED');
  if (invite.expiresAt <= now) return new GoneError('This invite link has expired', 'INVITE_EXPIRED');
  const creatorRole = await ports.invites(db).memberRole(invite.workspaceId, invite.createdBy);
  if (!isManager(creatorRole) || (invite.role === 'admin' && creatorRole !== 'owner')) return new GoneError('This invite link was revoked', 'INVITE_REVOKED');
  return null;
}

/** What the link's holder sees before joining; works without a session (`principal` null). */
export async function previewInvite(principal: Principal | null, token: unknown, db: Database, ports: InvitePorts, signer: InviteSigner,
  now = new Date()): Promise<InvitePreview> {
  const found = await find(signer, token, ports.invites(db), false);
  const self = principal?.kind === 'human' ? principal.id : null;
  const gone = await goneReason(found, self, ports, db, now);
  if (gone) throw gone;
  const { invite } = found;
  const joined = Boolean(invite.acceptedAt);
  const member = !joined && self ? (await ports.invites(db).memberRole(invite.workspaceId, self)) !== null : false;
  return {
    workspaceName: found.workspaceName, invitedBy: found.creatorName, role: invite.role, expiresAt: invite.expiresAt.toISOString(),
    emailLocked: invite.email !== null, encrypted: found.encrypted, state: joined ? 'joined' : member ? 'member' : 'pending',
  };
}

/** Joins the workspace with the link's role; single use, and idempotent for the account that used it. */
export async function acceptInvite(principal: Principal, token: unknown, db: Database, ports: InvitePorts, signer: InviteSigner,
  options: { verifiedEmailOnly?: boolean } = {}, now = new Date()): Promise<AcceptInviteResult> {
  if (principal.kind !== 'human') throw new ForbiddenError('Only a person can accept an invite link', 'FORBIDDEN');
  // The workspace is found first without a lock (an unknown token answers before any lock), then locked in order.
  const first = await find(signer, token, ports.invites(db), false);
  return db.transaction(async (tx) => {
    await ports.workspaces(tx).lock(first.invite.workspaceId);
    const found = await find(signer, token, ports.invites(tx), true);
    const { invite } = found;
    const result = (status: AcceptInviteResult['status'], role: WorkspaceRole, needsUnlockPassword = false): AcceptInviteResult => ({
      status, workspaceId: invite.workspaceId, workspaceName: found.workspaceName, role, encrypted: found.encrypted, needsUnlockPassword,
    });
    const gone = await goneReason(found, principal.id, ports, tx, now);
    if (gone) throw gone;
    const invites = ports.invites(tx);
    const currentRole = await invites.memberRole(invite.workspaceId, principal.id);
    // The same account accepting again: the join it made (if it left since, the link stays used).
    if (invite.acceptedAt) {
      if (!currentRole) throw new GoneError('This invite link was already used', 'INVITE_USED');
      return result('joined', currentRole);
    }
    // Someone already here leaves the link unused for the person it was meant for.
    if (currentRole) return result('already_member', currentRole);
    const account = await ports.workspaces(tx).findAccount({ userId: principal.id });
    if (!account) throw new NotFoundError('Account', 'ACCOUNT_NOT_FOUND');
    if (invite.email !== null && (account.email.trim().toLowerCase() !== invite.email || (options.verifiedEmailOnly && !account.emailVerified))) {
      throw new ForbiddenError('This invite link is for a different email address', 'INVITE_WRONG_ACCOUNT');
    }
    const member = await ports.workspaces(tx).insertMember({ workspaceId: invite.workspaceId, userId: principal.id, role: invite.role, createdBy: invite.createdBy });
    if (!member) return result('already_member', invite.role);
    await invites.markAccepted(invite.id, principal.id, now);
    await recordEvent(eventPorts(ports, tx), principal, invite.workspaceId, 'workspace.member_added.v1', invite.workspaceId,
      { userId: principal.id, role: invite.role, inviteId: invite.id });
    // F-030: an admin of an encrypted workspace has no unlock password until a current holder grants one.
    return result('joined', invite.role, found.encrypted && isManager(invite.role));
  });
}
