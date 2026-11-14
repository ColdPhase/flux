import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AcceptInviteResult, InvitePreview, WorkspaceRole } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ForbiddenError, GoneError, NotFoundError } from './errors.js';
import { isManager } from './policy.js';
import { inviteIdOf, inviteTokenHash, type InviteSigner } from './invite-tokens.js';
import type { InvitePorts } from './invites.js';
import type { InviteRepository } from './repositories.js';

// Joining by an invite link (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035): the preview a link's holder sees
// and accepting it. Making, listing and revoking links are in `invites.ts`. Every unknown, malformed or forged token is the same 404.
// Accepting takes the workspace row first (as `addMember`), then the invite row `FOR UPDATE`, and rechecks everything there.

/** Told inside the joining transaction about a fresh join: the server notifies the inviter, naming the space the link added them to. */
export type InviteJoined = (tx: Database, joined: { workspaceId: string; userId: string; inviterId: string; encrypted: boolean; role: WorkspaceRole;
  space: { id: string; name: string } | null }) => Promise<void>;

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
    emailLocked: invite.email !== null, email: invite.email, encrypted: found.encrypted, state: joined ? 'joined' : member ? 'member' : 'pending',
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