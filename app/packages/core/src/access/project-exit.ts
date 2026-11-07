import { randomUUID } from 'node:crypto';
import { eventAudience, principalKey, recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { RuleViolationError } from './errors.js';
import { requireAnotherSpaceAdmin } from './grants.js';
import { enforce, evaluateProject } from './policy.js';
import type { AccessPorts } from './repositories.js';

// How a person or a space leaves (F-037, #874): a person leaves a space they were added to, and a space is deleted with everything in it.

type ExitPorts = Pick<AccessPorts, 'projects' | 'workspaces' | 'access' | 'events'>;

/**
 * Erases a space with everything in it, in one transaction (#530, migration 0101). Its admins and the company's owners and
 * admins may; the Everyone space cannot be deleted, because it holds the whole company. The event goes to the people who could open
 * the space, so their lists drop it; it is written last, after its audience was decided while the space still existed.
 */
export async function deleteProject(principal: Principal, projectId: string, db: Database, ports: ExitPorts): Promise<void> {
  await db.transaction(async (tx) => {
    await ports.projects(tx).lockForGrantChange(projectId);
    const { project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const workspaceId = project!.workspaceId;
    if (project!.visibility === 'workspace' && (await ports.workspaces(tx).company())?.id === workspaceId) {
      throw new RuleViolationError('Everyone holds the whole company and cannot be deleted', 'EVERYONE_CANNOT_BE_DELETED');
    }
    const eventPortsOfTx = eventPorts(ports, tx);
    const recipients = await eventAudience(eventPortsOfTx, { kind: 'project.deleted.v1', workspaceId, objectId: projectId });
    await ports.projects(tx).erase(projectId);
    await eventPortsOfTx.repository.insert({ id: randomUUID(), kind: 'project.deleted.v1', objectId: projectId, actorId: principalKey(principal), data: {}, workspaceId }, recipients);
  });
}

/**
 * The caller leaves a space: their own grant goes (the Everyone space holds the whole company, so nobody leaves it
 * (`EVERYONE_CANNOT_BE_LEFT`)). A space keeps an admin: the last admin adds another first, or deletes the space.
 */
export async function leaveProject(principal: Principal, projectId: string, db: Database, ports: ExitPorts): Promise<void> {
  await db.transaction(async (tx) => {
    const projects = ports.projects(tx);
    await projects.lockForGrantChange(projectId);
    const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, ports.access(tx), { lock: true }), 'project');
    if (principal.kind !== 'human') throw new RuleViolationError('Only a person leaves a space', 'NOT_ADDED');
    if (project!.visibility === 'workspace' && (await ports.workspaces(tx).company())?.id === project!.workspaceId) {
      throw new RuleViolationError('Everyone holds the whole company, so nobody leaves it', 'EVERYONE_CANNOT_BE_LEFT');
    }
    const grant = await projects.lockGrantOf(projectId, principal.id);
    if (!grant) throw new RuleViolationError('You are in this space through the company, not added to it, so there is nothing to leave', 'NOT_ADDED');
    await requireAnotherSpaceAdmin(projects, principal, projectId, grant);
    await projects.deleteGrant(grant.id);
    await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.grant_revoked.v1', projectId, { grantId: grant.id });
  });
}
