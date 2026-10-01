import { agentExecutionRows, agentProjectObjectRows } from '@flux/db';
import { agentStandingGrantUseCases, DomainError, enforce, evaluateProject, type AgentStandingGrantPort, type Database } from '@flux/core';
import type { AgentOperation, CreateAgentStandingGrantCommand } from '@flux/contracts';
import { createAgentConnectionStore } from './store.js';

/** Create/update authority comes from the central project-management policy, never an owner label. */
export function agentStandingGrants(db: Database) {
  const port: AgentStandingGrantPort = {
    create(ownerUserId, connectionId, command) {
      return db.transaction(async (tx) => {
        const connection = await createAgentConnectionStore(tx).resolve(ownerUserId, connectionId);
        if (!connection || !connection.scopes.includes('flux.action.execute') || !connection.selectedProjectIds.includes(command.projectId))
          throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
        enforce(await evaluateProject({ kind: 'human', id: ownerUserId }, 'project.manage', command.projectId, tx, { lock: true }), 'project');
        if (command.objectId) {
          const kind = objectKind(command.operation);
          if (!kind || !await agentProjectObjectRows(tx).scopeOf(kind, command.objectId,
            { workspaceId: connection.workspaceId, projectId: command.projectId }))
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
  };
  return agentStandingGrantUseCases(port);
}

function objectKind(operation: AgentOperation): 'work' | 'sketch' | null {
  // Optional exact objects refer to native task/map containers, including thought/link commands.
  const maps: AgentOperation[] = ['map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete', 'map.positions.update', 'map.link.create', 'map.link.delete'];
  return operation === 'work.update' ? 'work' : maps.includes(operation) ? 'sketch' : null;
}

export type AgentGrantInput = CreateAgentStandingGrantCommand;
