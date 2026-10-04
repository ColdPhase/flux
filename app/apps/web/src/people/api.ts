import {
  projectGrantPath,
  projectGrantsPath,
  workspaceMemberPath,
  workspaceMembersPath,
  workspacePath,
  type ProjectAccess,
  type ProjectGrant,
  type ProjectGrantRole,
  type ProjectVisibility,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
} from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';

// People in workspaces and projects (#188). Only the existing access routes (#29): add, change and
// remove members, and set or revoke project grants. Every POST/PATCH carries an Idempotency-Key, so
// a retry after a lost answer never applies twice; DELETE routes take none.

const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });

export const getWorkspace = (workspaceId: string, signal?: AbortSignal) => request<Workspace>(workspacePath(workspaceId), { signal });
export const listMembers = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceMember[]>(workspaceMembersPath(workspaceId), { signal });
export const addMember = (workspaceId: string, email: string, role: WorkspaceRole, idempotencyKey: string) =>
  request<WorkspaceMember>(workspaceMembersPath(workspaceId), { method: 'POST', body: { email, role }, headers: key(idempotencyKey) });
export const changeRole = (workspaceId: string, userId: string, role: WorkspaceRole, idempotencyKey: string) =>
  request<WorkspaceMember>(workspaceMemberPath(workspaceId, userId), { method: 'PATCH', body: { role }, headers: key(idempotencyKey) });
/** Removes someone, or leaves when `userId` is the caller. */
export const removeMember = (workspaceId: string, userId: string) => request<null>(workspaceMemberPath(workspaceId, userId), { method: 'DELETE' });

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
  admin: 'Adds and removes people and manages every project.',
  member: 'Sees projects open to the workspace and the ones given to them.',
  guest: 'Sees only the projects given to them.',
};
export const isManagerRole = (role: WorkspaceRole | null | undefined) => role === 'owner' || role === 'admin';

/**
 * What the access policy (#29) gives a person on a project, for previews before a change is
 * confirmed. The server decides; after every change the audience is read again from it.
 */
export function levelFor(role: WorkspaceRole, visibility: ProjectVisibility, grant: ProjectGrantRole | null): ProjectAccess | null {
  if (grant === 'denied') return null;
  if (role === 'owner' || role === 'admin') return 'manager';
  if (grant) return grant;
  return role === 'member' && visibility === 'workspace' ? 'contributor' : null;
}

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
      return `No one has an account with ${context.email ?? 'that address'} at this Flux address yet. Ask them to create one at ${window.location.origin} first, then add them here. Flux doesn’t send invitations.`;
    case 'ALREADY_MEMBER':
      return `${context.who ?? context.email ?? 'This person'} is already in ${context.workspace}.`;
    case 'LAST_OWNER':
      return `${context.workspace} needs at least one owner. Make someone else an owner first.`;
    case 'OWNER_REQUIRED':
      return 'Only an owner can add, change or remove an owner.';
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
