import type { InviteRole } from '@flux/contracts';
import type { Database, Principal } from '../types.js';
import { NotFoundError } from './errors.js';
import { grantProject } from './grants.js';
import { evaluateProject, isManager } from './policy.js';
import type { AccessPorts } from './repositories.js';

// #763 FT-3: an invite made from a project carries it (docs/development/access-policy.md#invite-links-f-035).

type Ports = Pick<AccessPorts, 'workspaces' | 'invites' | 'access' | 'events' | 'projects'>;

/** Told inside the joining transaction about a fresh join: the server notifies the inviter. */
export type InviteJoined = (tx: Database, joined: { workspaceId: string; userId: string; inviterId: string; projectId: string | null; encrypted: boolean }) => Promise<void>;

/** The project's name, when its creator manages it now; anything else reads as a missing project. */
export async function inviteProjectName(principal: Principal, workspaceId: string, projectId: string, tx: Database, ports: Ports): Promise<string | null> {
  const checked = await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true });
  if (!checked.allowed || checked.project?.workspaceId !== workspaceId) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  return ports.invites(tx).projectName(workspaceId, projectId);
}

/** Where a person who used the link lands: its project, when they can open it now. */
export async function inviteLanding(principal: Principal, projectId: string | null, tx: Database, ports: Ports): Promise<string | null> {
  return projectId && (await evaluateProject(principal, 'project.read', projectId, ports.access(tx))).allowed ? projectId : null;
}

/**
 * Opens the invite's project to the person who just joined, as a contributor grant its creator makes, only while the creator
 * still manages it; a role that already writes there (a member of a workspace-visible project, an admin) needs no grant.
 * Returns the project, or null when nothing was opened.
 */
export async function openInviteProject(principal: Principal, invite: { projectId: string | null; createdBy: string; role: InviteRole },
  tx: Database, ports: Ports): Promise<string | null> {
  if (!invite.projectId) return null;
  const inviter: Principal = { kind: 'human', id: invite.createdBy };
  if (!(await evaluateProject(inviter, 'project.manage', invite.projectId, ports.access(tx))).allowed) return null;
  const writes = (await evaluateProject(principal, 'project.write', invite.projectId, ports.access(tx))).allowed;
  if (!writes && !isManager(invite.role)) {
    await grantProject(inviter, invite.projectId, { principal: { kind: 'human', id: principal.id }, role: 'contributor' }, tx, ports);
  }
  return invite.projectId;
}
