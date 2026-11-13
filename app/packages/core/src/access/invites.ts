import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  INVITE_CREATED_EVENT, INVITE_DEFAULT_EXPIRY_DAYS, INVITE_EXPIRY_DAYS, INVITE_JOIN_PAGE, INVITE_REVOKED_EVENT,
  type AcceptInviteResult, type CreateInviteCommand, type InvitePreview, type InviteRole, type WorkspaceInvite, type WorkspaceRole,
} from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ConflictError, ForbiddenError, GoneError, InvalidInputError, NotFoundError } from './errors.js';
import { enforce, evaluateProject, evaluateWorkspace, isManager, isUuid } from './policy.js';
import { inviteIdOf, inviteToken, inviteTokenHash, type InviteSigner } from './invite-tokens.js';
import type { AccessPorts, InviteRepository, InviteRow } from './repositories.js';

export { inviteIdOf, inviteToken, inviteTokenHash, type InviteSigner };

/** Told inside the joining transaction about a fresh join: the server notifies the inviter, naming the space the link added them to. */
export type InviteJoined = (tx: Database, joined: { workspaceId: string; userId: string; inviterId: string; encrypted: boolean; role: WorkspaceRole;
  space: { id: string; name: string } | null }) => Promise<void>;

// Invite links (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035). A company owner or admin creates a
// one-time link with a role (F-037: links join the company; a person is added to spaces afterwards); whoever holds it signs in or signs up and joins. The token is the invite id and an HMAC
// of it under a key derived from the server's identity secret; only its SHA-256 is stored. Every unknown, malformed or
// forged token is the same 404, so someone without the link learns nothing. Accepting takes the workspace row first
// (as `addMember`), then the invite row `FOR UPDATE`, and rechecks everything there.

type InvitePorts = Pick<AccessPorts, 'workspaces' | 'invites' | 'projects' | 'access' | 'events'>;

const INVITE_ROLES: readonly InviteRole[] = ['admin', 'member', 'guest'];
const MAX_PENDING = 50;
const DAY_MS = 86_400_000;

const linkOf = (signer: InviteSigner, inviteId: string) => `${signer.publicOrigin}${INVITE_JOIN_PAGE}#${inviteToken(signer, inviteId)}`;

function presentWithoutLink(row: InviteRow, creatorName: string, spaceName: string | null): Omit<WorkspaceInvite, 'link'> {
  return {
    id: row.id, workspaceId: row.workspaceId, role: row.role, email: row.email, createdBy: { id: row.createdBy, name: creatorName },
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    space: row.spaceId && spaceName !== null ? { id: row.spaceId, name: spaceName } : null,
  };
}

const present = (signer: InviteSigner, row: InviteRow, creatorName: string, spaceName: string | null): WorkspaceInvite =>
  ({ ...presentWithoutLink(row, creatorName, spaceName), link: linkOf(signer, row.id) });

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
  const spaceId = command.spaceId ?? null;
  if (spaceId !== null && !isUuid(spaceId)) throw new InvalidInputError('spaceId must be a space id');
  return db.transaction(async (tx) => {
    await ports.workspaces(tx).lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    // An encrypted space belongs to the company: nobody joins it by a link, only a company person added by its admin (C-24).
    if (await ports.workspaces(tx).companyOf(workspaceId)) throw new ConflictError('People join an encrypted space only by being added from the company', 'ENCRYPTED_SPACE_NO_INVITES');
    // An invite never makes an owner, and only an owner may hand out admin.
    if (role === 'admin' && actor.role !== 'owner') throw new ForbiddenError('Only an owner can invite an admin', 'OWNER_REQUIRED');
    const invites = ports.invites(tx);
    if (await invites.pendingCount(workspaceId, now) >= MAX_PENDING) throw new ConflictError(`At most ${MAX_PENDING} invite links can wait at once`, 'INVITE_LIMIT');
    // #1438: a link made from a space's Add people also adds the person to that space. Its maker can change that space's people (a company
    // owner or admin can change every space but an encrypted one); Everyone holds the whole company already, and a space elsewhere is refused.
    let spaceName: string | null = null;
    if (spaceId !== null) {
      const { project } = enforce(await evaluateProject(principal, 'project.manage', spaceId, ports.access(tx)), 'project');
      const space = await ports.projects(tx).get(spaceId);
      if (!project || !space || space.workspaceId !== workspaceId || space.visibility === 'workspace') {
        throw new InvalidInputError('An invite link adds the person to a space of this company other than Everyone');
      }
      spaceName = space.name;
    }
    const id = randomUUID();
    const row = await invites.insert({ id, workspaceId, role, email, tokenHash: inviteTokenHash(inviteToken(signer, id)), createdBy: principal.id,
      expiresAt: new Date(now.getTime() + days * DAY_MS), spaceId });
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, INVITE_CREATED_EVENT, workspaceId, { inviteId: id, role, ...(spaceId ? { spaceId } : {}) });
    const creator = await ports.workspaces(tx).findAccount({ userId: principal.id });
    return presentWithoutLink(row, creator?.name ?? '', spaceName);
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
  return rows.map(({ invite, creatorName, spaceName }) => present(signer, invite, creatorName, spaceName));
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

/**
 * #1438: the link's space takes the person who just joined as a member, granted by the link's maker, who is still a company owner or admin
 * (`goneReason` checked it) and so may change that space's people. A space deleted since, or one that moved out of this workspace, adds
 * nobody: the person is in the company only, as with any link.
 */
async function addToSpace(tx: Database, ports: InvitePorts, spaceId: string, workspaceId: string, makerId: string, userId: string) {
  const projects = ports.projects(tx);
  await projects.lockForGrantChange(spaceId);
  const space = await projects.get(spaceId);
  if (!space || space.workspaceId !== workspaceId || space.visibility === 'workspace') return null;
  const written = await projects.insertGrant({ id: randomUUID(), workspaceId, projectId: spaceId, role: 'contributor', createdBy: makerId, userId });
  if ('conflict' in written) return null;
  const maker: Principal = { kind: 'human', id: makerId };
  await recordEvent(eventPorts(ports, tx), maker, workspaceId, 'project.grant_set.v1', spaceId,
    { grantId: written.grant.id, principal: { kind: 'human', id: userId }, role: 'contributor' });
  return { id: spaceId, name: space.name };
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
  options: { verifiedEmailOnly?: boolean; onJoined?: InviteJoined } = {}, now = new Date()): Promise<AcceptInviteResult> {
  if (principal.kind !== 'human') throw new ForbiddenError('Only a person can accept an invite link', 'FORBIDDEN');
  // The workspace is found first without a lock (an unknown token answers before any lock), then locked in order.
  const first = await find(signer, token, ports.invites(db), false);
  return db.transaction(async (tx) => {
    await ports.workspaces(tx).lock(first.invite.workspaceId);
    const found = await find(signer, token, ports.invites(tx), true);
    const { invite } = found;
    const invites = ports.invites(tx);
    // #1438: the join page opens a space with its composer ready: Everyone, unless the person is a guest, who opens the link's space.
    const landing = async (role: WorkspaceRole, space: string | null) => (role === 'guest' ? space : await invites.everyoneSpace(invite.workspaceId));
    const result = async (status: AcceptInviteResult['status'], role: WorkspaceRole, space: string | null, needsUnlockPassword = false): Promise<AcceptInviteResult> => ({
      status, workspaceId: invite.workspaceId, workspaceName: found.workspaceName, role, encrypted: found.encrypted, needsUnlockPassword,
      landingSpaceId: await landing(role, space),
    });
    const gone = await goneReason(found, principal.id, ports, tx, now);
    if (gone) throw gone;
    const currentRole = await invites.memberRole(invite.workspaceId, principal.id);
    const projects = ports.projects(tx);
    const inSpace = async () => (invite.spaceId && await projects.lockGrantOf(invite.spaceId, principal.id) ? invite.spaceId : null);
    // The same account accepting again: the join it made (if it left since, the link stays used).
    if (invite.acceptedAt) {
      if (!currentRole) throw new GoneError('This invite link was already used', 'INVITE_USED');
      return result('joined', currentRole, await inSpace());
    }
    // Someone already here leaves the link unused for the person it was meant for.
    if (currentRole) return result('already_member', currentRole, await inSpace());
    const account = await ports.workspaces(tx).findAccount({ userId: principal.id });
    if (!account) throw new NotFoundError('Account', 'ACCOUNT_NOT_FOUND');
    if (invite.email !== null && (account.email.trim().toLowerCase() !== invite.email || (options.verifiedEmailOnly && !account.emailVerified))) {
      throw new ForbiddenError('This invite link is for a different email address', 'INVITE_WRONG_ACCOUNT');
    }
    const member = await ports.workspaces(tx).insertMember({ workspaceId: invite.workspaceId, userId: principal.id, role: invite.role, createdBy: invite.createdBy });
    if (!member) return result('already_member', invite.role, null);
    await invites.markAccepted(invite.id, principal.id, now);
    await recordEvent(eventPorts(ports, tx), principal, invite.workspaceId, 'workspace.member_added.v1', invite.workspaceId,
      { userId: principal.id, role: invite.role, inviteId: invite.id });
    const space = invite.spaceId ? await addToSpace(tx, ports, invite.spaceId, invite.workspaceId, invite.createdBy, principal.id) : null;
    await options.onJoined?.(tx, { workspaceId: invite.workspaceId, userId: principal.id, inviterId: invite.createdBy, encrypted: found.encrypted, role: invite.role, space });
    // F-030: an admin of an encrypted workspace has no unlock password until a current holder grants one.
    return result('joined', invite.role, space?.id ?? null, found.encrypted && isManager(invite.role));
  });
}
