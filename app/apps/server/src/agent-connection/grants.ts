import { agentExecutionRows, agentProjectObjectRows } from '@flux/db';
import { agentStandingGrantUseCases, DomainError, enforce, evaluateProject, type AgentStandingGrantPort, type Database, type Transaction } from '@flux/core';
import type { AgentOperation, CreateAgentStandingGrantCommand } from '@flux/contracts';
import { createAgentConnectionStore } from './store.js';

/** Create/update authority comes from the central project-management policy, never an owner label. */
export interface AgentGrantDomainChecks {
  coordinationTarget?(tx: Transaction, within: { workspaceId: string; projectId: string; connectionId: string },
    command: CreateAgentStandingGrantCommand): Promise<boolean>;
}
export function agentStandingGrants(db: Database, domain: AgentGrantDomainChecks = {}) {
  const port: AgentStandingGrantPort = {
    create(ownerUserId, connectionId, command) {
      return db.transaction(async (tx) => {
        const connection = await createAgentConnectionStore(tx).resolve(ownerUserId, connectionId);
        if (!connection || !connection.scopes.includes('flux.action.execute') || !connection.selectedProjectIds.includes(command.projectId))
          throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
        enforce(await evaluateProject({ kind: 'human', id: ownerUserId }, 'project.manage', command.projectId, tx, { lock: true }), 'project');
        if (command.objectId) {
          const within = { workspaceId: connection.workspaceId, projectId: command.projectId, connectionId };
          const kind = agentOperationTarget(command.operation);
          const allowed = command.operation.startsWith('cowork.')
            ? !!domain.coordinationTarget && await domain.coordinationTarget(tx, within, command)
            : !!kind && !!await agentProjectObjectRows(tx).scopeOf(kind, command.objectId,
              { workspaceId: connection.workspaceId, projectId: command.projectId });
          if (!allowed)
            throw new DomainError(404, 'OBJECT_NOT_FOUND', 'Project object not found');
        }
        const rows = agentExecutionRows(tx); const now = await rows.now(); const expiresAt = new Date(command.expiresAt);
        if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 30 * 24 * 3_600_000)
          throw new DomainError(400, 'GRANT_EXPIRY_INVALID', 'A grant must expire within the next 30 days');
        const result = await rows.createGrant(ownerUserId, connectionId, connection.workspaceId, command);
        if (result === 'IDEMPOTENCY_CONFLICT') throw new DomainError(409, result, 'This grant command ID was used for different limits');
        return result;
      });
    },
    list(ownerUserId, connectionId, page) {
      return db.transaction(async (tx) => {
        // No project/object titles are read here. Grant history is owner-only metadata.
        if (!await agentExecutionRows(tx).ownedConnection(ownerUserId, connectionId))
          throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
        return agentExecutionRows(tx).listGrants(ownerUserId, connectionId, page);
      });
    },
    revoke(ownerUserId, connectionId, id) {
      return db.transaction(async (tx) => {
        if (!await agentExecutionRows(tx).revokeGrant(ownerUserId, connectionId, id))
          throw new DomainError(404, 'GRANT_NOT_FOUND', 'Grant not found');
      });
    },
    narrow(ownerUserId, connectionId, id, command) {
      return db.transaction(async (tx) => {
        const rows = agentExecutionRows(tx);
        const grant = await rows.lockOwnedGrant(ownerUserId, connectionId, id);
        const now = await rows.now(); // after the row lock, the same wall clock an execution uses
        // A revoked or expired grant has nothing left to narrow; it reads like a missing one.
        if (!grant || grant.revokedAt || grant.expiresAt <= now) throw new DomainError(404, 'GRANT_NOT_FOUND', 'Grant not found');
        const maximumUses = command.maximumUses ?? grant.maximumUses;
        const expiresAt = command.expiresAt ? new Date(command.expiresAt) : grant.expiresAt;
        if (maximumUses > grant.maximumUses || maximumUses < Math.max(grant.used, 1) || expiresAt > grant.expiresAt || expiresAt <= now)
          throw new DomainError(400, 'GRANT_NOT_NARROWER', 'A grant can only be narrowed: fewer uses, but not fewer than already used, or an earlier expiry that is still in the future');
        return rows.narrowGrant(grant.id, { maximumUses, expiresAt });
      });
    },
  };
  return agentStandingGrantUseCases(port);
}

const MAP_CHANGES: readonly AgentOperation[] = ['map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete',
  'map.positions.update', 'map.link.create', 'map.link.delete'];
/**
 * The kind of the exact project object a change targets, or null for a create. Optional grant objects and command
 * targets name native containers: the task, the project map (also for thought/link commands), the doc, or the
 * project conversation a reply joins. Private and direct-message objects are never project objects.
 */
export function agentOperationTarget(operation: AgentOperation): 'work' | 'sketch' | 'doc' | 'conversation' | null {
  // #153: a unit is created for an exact native task of this project. #238: an agent undoes its own unused task.
  if (operation === 'work.update' || operation === 'cowork.unit.create' || operation === 'work.creation.revert') return 'work';
  if (operation === 'doc.update') return 'doc';
  if (operation === 'conversation.reply') return 'conversation';
  return MAP_CHANGES.includes(operation) ? 'sketch' : null;
}

export type AgentGrantInput = CreateAgentStandingGrantCommand;
