import { randomUUID } from 'node:crypto';
import {
  INVITE_CREATED_EVENT, INVITE_DEFAULT_EXPIRY_DAYS, INVITE_EXPIRY_DAYS, INVITE_JOIN_PAGE, INVITE_REVOKED_EVENT,
  type CreateInviteCommand, type InviteRole, type WorkspaceInvite,
} from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from './errors.js';
import { enforce, evaluateProject, evaluateWorkspace, isUuid } from './policy.js';
import { inviteIdOf, inviteToken, inviteTokenHash, type InviteSigner } from './invite-tokens.js';
import type { AccessPorts, InviteRow } from './repositories.js';

export { inviteIdOf, inviteToken, inviteTokenHash, type InviteSigner };
export { acceptInvite, previewInvite, type InviteJoined } from './invite-joining.js';

// Invite links (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035). A company owner or admin creates a
// one-time link with a role (F-037: links join the company; a person is added to spaces afterwards); whoever holds it signs in or signs up and joins. The token is the invite id and an HMAC
// of it under a key derived from the server's identity secret; only its SHA-256 is stored. Every unknown, malformed or
// forged token is the same 404, so someone without the link learns nothing. Joining by a link is in `invite-joining.ts`.

export type InvitePorts = Pick<AccessPorts, 'workspaces' | 'invites' | 'projects' | 'access' | 'events'>;

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
