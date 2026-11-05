import { randomUUID } from 'node:crypto';
import type { GrantProjectCommand, ProjectGrant } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts, requireRoleAuthority, type DomainEventSink } from './common.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError } from './errors.js';
import { enforce, evaluateProject, isManager, isUuid } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { GrantRecord } from './records.js';
import { GRANT_ROLES, oneOf } from './validation.js';

// Project grants (issues #46, #91): list, set and revoke. The project row is taken `FOR NO KEY UPDATE` first,
// then the actor's project access under `lock`; the grant row is `FOR UPDATE` (or deleted); the event is the last write.

type GrantPorts = Pick<AccessPorts, 'projects' | 'workspaces' | 'access' | 'events'>;

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

export async function listProjectGrants(principal: Principal, projectId: string, db: Database, ports: GrantPorts): Promise<ProjectGrant[]> {
  enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(db)), 'project');
  return (await ports.projects(db).listGrants(principal, projectId)).map(toGrant);
}

/**
 * Creates or replaces the grant of one person on a project. The grantee must be a member of the
 * project's workspace. Grants that affect an owner need an owner. Agents have no grants: an agent
 * has exactly its owner's rights (F-036 AG-3, #855).
 */
export async function grantProject(principal: Principal, projectId: string, command: GrantProjectCommand, db: Database, ports: GrantPorts, eventSink?: DomainEventSink): Promise<ProjectGrant> {
  const role = oneOf(command?.role, GRANT_ROLES, 'role');
  const target = command.principal;
  if (!target || target.kind !== 'human' || typeof target.id !== 'string' || !target.id)
    throw new InvalidInputError('principal must be { kind: "human", id }: an agent has its owner\'s rights and no grants');
  return db.transaction(async (tx) => {
    const projects = ports.projects(tx);
    await projects.lockForGrantChange(projectId);
    const { actor, project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const workspaceId = project!.workspaceId;
    const member = await projects.member(workspaceId, target.id);
    if (!member) throw new RuleViolationError('Only people in the company can be added to a space', 'NOT_A_MEMBER');
    if (member.role === 'owner') requireRoleAuthority(actor!, 'owner');
    if (role === 'manager' && member.role === 'guest') throw new RuleViolationError('A guest cannot be a space admin', 'GUEST_NOT_SPACE_ADMIN');
    if (role === 'denied') {
      // F-037: the company's owners and admins can change any space, so a space admin who is a plain member cannot shut one out.
      if (isManager(member.role) && !isManager(actor!.role)) throw new ForbiddenError('Only a company owner or admin can keep a company admin out of a space', 'COMPANY_ADMIN_PROTECTED');
      if (project!.visibility === 'workspace' && (await ports.workspaces(tx).company())?.id === workspaceId) {
        throw new RuleViolationError('Everyone holds the whole company, so nobody can be kept out of it', 'EVERYONE_HOLDS_EVERYONE');
      }
    }
    const existing = await projects.lockGrantOf(projectId, target.id);
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
    const { actor, project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const grant = isUuid(grantId) ? await projects.lockGrant(projectId, grantId) : null;
    if (!grant) throw new NotFoundError('Grant', 'GRANT_NOT_FOUND');
    if (await projects.memberRole(project!.workspaceId, grant.userId) === 'owner') requireRoleAuthority(actor!, 'owner');
    await projects.deleteGrant(grantId);
    await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.grant_revoked.v1', projectId, { grantId });
  });
}
