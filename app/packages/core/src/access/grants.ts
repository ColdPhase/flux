import { randomUUID } from 'node:crypto';
import type { GrantProjectCommand, ProjectGrant } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts, type DomainEventSink } from './common.js';
import { ConflictError, InvalidInputError, NotFoundError, RuleViolationError } from './errors.js';
import { enforce, evaluateProject, isUuid } from './policy.js';
import type { AccessPorts, ProjectRepository } from './repositories.js';
import type { GrantRecord } from './records.js';
import { GRANT_ROLES, oneOf } from './validation.js';

// Project grants (issues #46, #91): list, set and revoke. The project row is taken `FOR NO KEY UPDATE` first,
// then the actor's project access under `lock`; the grant row is `FOR UPDATE` (or deleted); the event is the last write.

type GrantPorts = Pick<AccessPorts, 'projects' | 'access' | 'events'>;

function toGrant(row: GrantRecord): ProjectGrant {
  return {
    id: row.id,
    projectId: row.projectId,
    principal: { kind: 'human', id: row.userId },
    role: row.role,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A space always keeps an admin on space-level actions (C-16): nobody leaves, demotes themselves, or is removed or demoted
 * while they are the last admin by grant. Removing the person from the company, or making them a guest, is not blocked: a company
 * admin can then add themselves from Settings › Company.
 */
export async function requireAnotherSpaceAdmin(projects: Pick<ProjectRepository, 'listGrants'>, principal: Principal, projectId: string, leaving: GrantRecord): Promise<void> {
  if (leaving.role !== 'manager') return;
  // The list holds this person's own grant too: they are the last admin when it is the only one.
  const admins = (await projects.listGrants(principal, projectId)).filter((row) => row.role === 'manager');
  if (admins.length <= 1) throw new RuleViolationError('Add another admin first: a space always keeps one', 'LAST_SPACE_ADMIN');
}

export async function listProjectGrants(principal: Principal, projectId: string, db: Database, ports: GrantPorts): Promise<ProjectGrant[]> {
  enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(db)), 'project');
  return (await ports.projects(db).listGrants(principal, projectId)).map(toGrant);
}

/**
 * Creates or replaces the grant of one person on a project: a space admin (`manager`) or a space member (`contributor`, #903). The
 * grantee must be a member of the project's workspace; any person in the company can be added, a company owner too, as New space
 * allows (#905). The owner role itself is not touched, so changing it stays with an owner (`members.ts`). A grant never keeps anyone out
 * of a space: a company owner or admin reaches every space as its manager whatever they hold, so removing their grant only takes them off
 * the space's people, and Add me puts them back. Agents have no grants: an agent has exactly its owner's rights (F-036 AG-3, #855).
 */
export async function grantProject(principal: Principal, projectId: string, command: GrantProjectCommand, db: Database, ports: GrantPorts, eventSink?: DomainEventSink): Promise<ProjectGrant> {
  const role = oneOf(command?.role, GRANT_ROLES, 'role');
  const target = command.principal;
  if (!target || target.kind !== 'human' || typeof target.id !== 'string' || !target.id)
    throw new InvalidInputError('principal must be { kind: "human", id }: an agent has its owner\'s rights and no grants');
  return db.transaction(async (tx) => {
    const projects = ports.projects(tx);
    await projects.lockForGrantChange(projectId);
    const { project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const workspaceId = project!.workspaceId;
    const member = await projects.member(workspaceId, target.id);
    if (!member) throw new RuleViolationError('Only people in the company can be added to a space', 'NOT_A_MEMBER');
    if (role === 'manager' && member.role === 'guest') throw new RuleViolationError('A guest cannot be a space admin', 'GUEST_NOT_SPACE_ADMIN');
    const existing = await projects.lockGrantOf(projectId, target.id);
    if (existing && role !== 'manager') await requireAnotherSpaceAdmin(projects, principal, projectId, existing);
    const written = existing ? await projects.updateGrant(existing.id, role, principal.id)
      : await projects.insertGrant({ id: randomUUID(), workspaceId, projectId, role, createdBy: principal.id, userId: target.id });
    if ('conflict' in written) {
      if (written.conflict === 'GRANT_CONFLICT') throw new ConflictError('A concurrent grant for this principal was created', 'GRANT_CONFLICT');
      throw new ConflictError('This person is no longer in the company', 'GRANTEE_REMOVED');
    }
    const row = written.grant;
    const event = { grantId: row.id, principal: target, role };
    if (eventSink) await eventSink.record(principal, workspaceId, 'project.grant_set.v1', projectId, event);
    else await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'project.grant_set.v1', projectId, event);
    return toGrant(row);
  });
}

export async function revokeProjectGrant(principal: Principal, projectId: string, grantId: string, db: Database, ports: GrantPorts): Promise<void> {
  await db.transaction(async (tx) => {
    const projects = ports.projects(tx);
    await projects.lockForGrantChange(projectId);
    const { project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const grant = isUuid(grantId) ? await projects.lockGrant(projectId, grantId) : null;
    if (!grant) throw new NotFoundError('Grant', 'GRANT_NOT_FOUND');
    await requireAnotherSpaceAdmin(projects, principal, projectId, grant);
    await projects.deleteGrant(grantId);
    await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.grant_revoked.v1', projectId, { grantId });
  });
}
