import {
  INVITE_ACCEPT_PATH,
  INVITE_PREVIEW_PATH,
  personResetLinkPath,
  type ResetLink,
  workspaceInvitePath,
  workspaceInvitesPath,
  type AcceptInviteResult,
  type InviteExpiryDays,
  type InvitePreview,
  type InviteRole,
  type WorkspaceInvite,
  projectGrantPath,
  projectGrantsPath,
  workspaceMemberPath,
  workspaceMembersPath,
  workspaceRemovedPeoplePath,
  workspaceRestorePath,
  workspacePath,
  type ProjectGrant,
  type ProjectGrantRole,
  type RemovedPerson,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
} from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';

// People in the company and its spaces (#188, F-037). Only the existing access routes (#29): add, change and
// remove members, and set or revoke project grants. Every POST/PATCH carries an Idempotency-Key, so
// a retry after a lost answer never applies twice; DELETE routes take none.

const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });

export const getWorkspace = (workspaceId: string, signal?: AbortSignal) => request<Workspace>(workspacePath(workspaceId), { signal });
/** An owner or admin renames the company (Settings › Company, F-037). */
export const renameCompany = (workspaceId: string, name: string, idempotencyKey: string) =>
  request<Workspace>(workspacePath(workspaceId), { method: 'PATCH', body: { name }, headers: key(idempotencyKey) });
export const listMembers = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceMember[]>(workspaceMembersPath(workspaceId), { signal });
export const addMember = (workspaceId: string, email: string, role: WorkspaceRole, idempotencyKey: string) =>
  request<WorkspaceMember>(workspaceMembersPath(workspaceId), { method: 'POST', body: { email, role }, headers: key(idempotencyKey) });
export const changeRole = (workspaceId: string, userId: string, role: WorkspaceRole, idempotencyKey: string) =>
  request<WorkspaceMember>(workspaceMemberPath(workspaceId, userId), { method: 'PATCH', body: { role }, headers: key(idempotencyKey) });
/** Who left the company or was removed, and bringing them back (Settings › Company). */
export const listRemovedPeople = (workspaceId: string, signal?: AbortSignal) => request<RemovedPerson[]>(workspaceRemovedPeoplePath(workspaceId), { signal });
export const restorePerson = (workspaceId: string, userId: string) => request<WorkspaceMember>(workspaceRestorePath(workspaceId, userId), { method: 'POST' });
/** Removes someone, or leaves when `userId` is the caller. */
export const removeMember = (workspaceId: string, userId: string) => request<null>(workspaceMemberPath(workspaceId, userId), { method: 'DELETE' });

/** Invite links (F-035): owners and admins create, list and revoke them; whoever has one previews and accepts it. */
export const listInvites = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceInvite[]>(workspaceInvitesPath(workspaceId), { signal });
export const createInvite = (workspaceId: string, body: { role: InviteRole; email: string | null; expiresInDays: InviteExpiryDays; spaceId?: string | null }, idempotencyKey: string) =>
  request<WorkspaceInvite>(workspaceInvitesPath(workspaceId), { method: 'POST', body, headers: key(idempotencyKey) });
export const revokeInvite = (workspaceId: string, inviteId: string) => request<null>(workspaceInvitePath(workspaceId, inviteId), { method: 'DELETE' });
export const previewInvite = (token: string, signal?: AbortSignal) => request<InvitePreview>(INVITE_PREVIEW_PATH, { method: 'POST', body: { token }, signal });
export const acceptInvite = (token: string) => request<AcceptInviteResult>(INVITE_ACCEPT_PATH, { method: 'POST', body: { token } });
/** A one-time password reset link for another person of the company (#1471), shown only in this answer. */
export const makeResetLink = (userId: string) => request<ResetLink>(personResetLinkPath(userId), { method: 'POST' });

export const listGrants = (projectId: string, signal?: AbortSignal) => request<ProjectGrant[]>(projectGrantsPath(projectId), { signal });
/** Creates or replaces the one grant of this person on the project. */
export const grantPerson = (projectId: string, userId: string, role: ProjectGrantRole, idempotencyKey: string) =>
  request<ProjectGrant>(projectGrantsPath(projectId), { method: 'POST', body: { principal: { kind: 'human', id: userId }, role }, headers: key(idempotencyKey) });
export const revokeGrant = (projectId: string, grantId: string) => request<null>(projectGrantPath(projectId, grantId), { method: 'DELETE' });

/**
 * One Idempotency-Key per attempt: a retry of the same change after a lost answer reuses it, a
 * different change gets a new one.
 */
export function attemptKeys() {
  let current: { signature: string; key: string } | null = null;
  return {
    for(signature: string) {
      if (current?.signature !== signature) current = { signature, key: crypto.randomUUID() };
      return current.key;
    },
    done() { current = null; },
  };
}

export const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
export const ROLE_HINT: Record<WorkspaceRole, string> = {
  owner: 'Everything an admin can do, and can add or remove owners.',
  admin: 'Adds and removes people and can change every space.',
  member: 'Is in Everyone, starts spaces and sees the ones they’re added to.',
  guest: 'Sees only the spaces they’re added to, and never has AI.',
};
export const isManagerRole = (role: WorkspaceRole | null | undefined) => role === 'owner' || role === 'admin';

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A calm, specific sentence for a failed people or access change; never a raw server message. */
export function problemText(error: unknown, context: { workspace: string; email?: string; who?: string }): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again in a moment.';
  if (!(error instanceof ApiError)) return 'That didn’t work. Nothing changed; try again.';
  const who = context.who ?? 'They';
  switch (error.code) {
    case 'ACCOUNT_NOT_FOUND':
      return `No one has an account with ${context.email ?? 'that address'} here yet. Create an invite link for them below and send it yourself.`;
    case 'INVITE_LIMIT':
      return `${context.workspace} already has 50 invite links waiting. Revoke some you no longer need first.`;
    case 'INVITE_NOT_FOUND':
      return 'That invite link was already used, revoked or expired. The list shows it as it is now.';
    case 'ALREADY_MEMBER':
      return `${context.who ?? context.email ?? 'This person'} is already in ${context.workspace}.`;
    case 'LAST_OWNER':
      return `${context.workspace} needs at least one owner. Make someone else an owner first.`;
    case 'LAST_UNLOCK_PASSWORD':
      return `${context.workspace} needs at least one unlock password. Ask another owner or admin to set theirs first.`;
    case 'ENCRYPTED_SPACE_LAST_KEYHOLDER': {
      // The company's change was refused whole: they are the only owner (or the only unlock password) of encrypted spaces (C-24).
      const spaces = (error.body as { spaces?: unknown } | null)?.spaces;
      const names = Array.isArray(spaces) ? spaces.filter((name): name is string => typeof name === 'string') : [];
      const list = names.length ? names.map((name) => `“${name}”`).join(', ') : 'an encrypted space';
      return `${who} ${context.who ? 'is' : 'are'} the only owner, or the only unlock password, of ${list}. Ask ${context.who ? 'them' : 'them'} to hand ${names.length > 1 ? 'each' : 'it'} over to another owner, or delete ${names.length > 1 ? 'them' : 'it'} in Settings › Company; then they can go.`;
    }
    case 'ENCRYPTED_SPACE_NO_GUESTS':
      return 'Guests can’t be in an encrypted space.';
    case 'OWNER_REQUIRED':
      return 'Only an owner can add, change or remove an owner.';
    case 'NO_PASSWORD':
      return `${who} ${context.who ? 'signs' : 'sign'} in without a password, so there is nothing to reset.`;
    case 'PERSON_NOT_FOUND':
      return `${who} ${context.who ? 'is' : 'are'} no longer in ${context.workspace}.`;
    case 'MEMBER_NOT_FOUND':
      return `${who} ${context.who ? 'is' : 'are'} no longer in ${context.workspace}.`;
    case 'NOT_A_MEMBER':
    case 'GRANTEE_REMOVED':
      return `${who} ${context.who ? 'isn’t' : 'aren’t'} in ${context.workspace} any more, so they can’t be given access.`;
    case 'GRANT_NOT_FOUND':
      return 'That access was already changed by someone else. The list shows it as it is now.';
    case 'GRANT_CONFLICT':
      return 'Someone changed this person’s access at the same moment. Check the list and try again.';
    case 'INVALID_INPUT':
      return context.email !== undefined ? 'Enter the email address of their Flux account.' : 'That change isn’t possible.';
    case 'WORKSPACE_NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
      return 'You no longer have access here.';
    default:
      if (error.status === 403) return `Only owners and admins of ${context.workspace} can do this.`;
      if (error.status === 429) return 'Too many changes at once. Wait a moment and try again.';
      return 'That didn’t work. Nothing changed; try again.';
  }
}
