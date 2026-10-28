import { randomUUID } from 'node:crypto';
import type { GrantProjectCommand, ProjectGrant } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts, requireRoleAuthority, type DomainEventSink } from './common.js';
import { ConflictError, InvalidInputError, NotFoundError, RuleViolationError } from './errors.js';
import { enforce, evaluateProject, isUuid } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { GrantRecord } from './records.js';
import { GRANT_ROLES, oneOf } from './validation.js';

// Project grants (issues #46, #91): list, set and revoke. The project row is taken `FOR NO KEY UPDATE` first,
// then the actor's project access under `lock`; the grant row is `FOR UPDATE` (or deleted); the event is the last write.

type GrantPorts = Pick<AccessPorts, 'projects' | 'access' | 'events'>;

function toGrant(row: GrantRecord): ProjectGrant {
  return {
    id: row.id,
    projectId: row.projectId,
    principal: row.userId ? { kind: 'human', id: row.userId } : { kind: 'agent', id: row.agentId! },
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
 * Creates or replaces the grant of one principal on a project. A human grantee must be
 * a member of the project's workspace; an agent must belong to it and not be revoked.
 * Grants that affect an owner need an owner.
 */
export async function grantProject(principal: Principal, projectId: string, command: GrantProjectCommand, db: Database, ports: GrantPorts, eventSink?: DomainEventSink): Promise<ProjectGrant> {
  const role = oneOf(command?.role, GRANT_ROLES, 'role');
  const target = command.principal;
  if (!target || (target.kind !== 'human' && target.kind !== 'agent') || typeof target.id !== 'string' || !target.id) throw new InvalidInputError('principal must be { kind: "human" | "agent", id }');
  return db.transaction(async (tx) => {
    const projects = ports.projects(tx);
    await projects.lockForGrantChange(projectId);
    const { actor, project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const workspaceId = project!.workspaceId;
    if (target.kind === 'human') {
      const member = await projects.member(workspaceId, target.id);
      if (!member) throw new RuleViolationError('Grants can only name members of the project workspace', 'NOT_A_MEMBER');
      if (member.role === 'owner') requireRoleAuthority(actor!, 'owner');
    } else {
      const agent = isUuid(target.id) ? await projects.activeAgent(workspaceId, target.id) : null;
      if (!agent) throw new RuleViolationError('Grants can only name active agents of the project workspace', 'AGENT_NOT_IN_WORKSPACE');
    }
    const existing = await projects.lockGrantOf(projectId, target);
    const written = existing ? await projects.updateGrant(existing.id, role, principal.id)
      : await projects.insertGrant({
        id: randomUUID(), workspaceId, projectId, role, createdBy: principal.id,
        userId: target.kind === 'human' ? target.id : null,
        agentId: target.kind === 'agent' ? target.id : null,
      });
    if ('conflict' in written) {
      if (written.conflict === 'GRANT_CONFLICT') throw new ConflictError('A concurrent grant for this principal was created', 'GRANT_CONFLICT');
      throw new ConflictError('The grantee is no longer part of the workspace', 'GRANTEE_REMOVED');
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
    if (grant.userId) {
      if (await projects.memberRole(project!.workspaceId, grant.userId) === 'owner') requireRoleAuthority(actor!, 'owner');
    }
    await projects.deleteGrant(grantId);
    await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.grant_revoked.v1', projectId, { grantId });
  });
}
