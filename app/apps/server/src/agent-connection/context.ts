import type { AgentScope } from '@flux/contracts';
import { agentProjectReads, DomainError, requireAgentSelection, type AgentConnectionContext,
  type AgentProjectObjectKind, type Database, type Transaction } from '@flux/core';
import { agentProjectObjectRows } from '@flux/db';
import { createAgentConnectionStore } from './store.js';

/** Constructed only from the verified authorization-server bearer, never MCP clientInfo. */
export interface FluxMcpClaims {
  ownerUserId: string;
  connectionId: string;
  clientId: string | null;
  grantReferenceId: string | null;
  scopes: readonly string[];
}

export interface FluxAgentReadContext {
  tx: Transaction;
  connection: AgentConnectionContext;
  workspaceId: string;
  principal: { kind: 'agent'; id: string };
  requireObject(projectId: string, kind: AgentProjectObjectKind, id: string): Promise<void>;
}

/** Hold live binding, connection and central access locks throughout content projection/effect. */
export function withAgentConnection<T>(db: Database, claims: FluxMcpClaims, scope: AgentScope,
  projectId: string | null, read: (context: FluxAgentReadContext) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => read(await agentConnectionInTransaction(tx, claims, scope, projectId)));
}

/** The same authorization boundary composed into #152/#153's caller-owned transaction. */
export async function agentConnectionInTransaction(tx: Transaction, claims: FluxMcpClaims, scope: AgentScope,
  projectId: string | null): Promise<FluxAgentReadContext> {
    const grant = await createAgentConnectionStore(tx).grantForOauth(claims.ownerUserId,
      claims.grantReferenceId ?? claims.connectionId);
    if (!grant || grant.connection.id !== claims.connectionId || grant.clientId !== null && grant.clientId !== claims.clientId)
      throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
    const row = grant.connection;
    if (!claims.scopes.includes(scope) || !row.scopes.includes(scope))
      throw new DomainError(403, 'MCP_SCOPE_REQUIRED', 'The connection lacks the required scope');
    const connection: AgentConnectionContext = {
      connectionId: row.id, ownerUserId: row.ownerUserId, agentId: row.agentId,
      selectedProjectIds: row.selectedProjectIds,
      scopes: row.scopes.filter((selected) => claims.scopes.includes(selected)), computeSource: row.computeSource,
    };
    if (projectId) requireAgentSelection(connection, projectId, scope);
    const objects = agentProjectReads(agentProjectObjectRows(tx));
    return { tx, connection, workspaceId: row.workspaceId, principal: { kind: 'agent', id: row.agentId },
      requireObject: (project, kind, id) => objects.requireObject(connection, row.workspaceId, project, kind, id) };
}
