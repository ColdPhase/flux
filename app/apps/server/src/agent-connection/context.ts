import { AGENT_MCP_SOURCE_CAPABILITIES, type AgentMcpPolicy, type AgentScope } from '@flux/contracts';
import { agentProjectReads, DomainError, enforce, evaluateProject, requireAgentMcpEntry, requireAgentSelection, type AgentConnectionContext,
  type AgentProjectObjectKind, type Database, type Transaction } from '@flux/core';
import { agentProjectObjectRows, lockAgentMcpPolicy } from '@flux/db';
import { createAgentConnectionStore } from './store.js';
import type { McpDispatch } from './mcp-dispatch.js';

/** Constructed only from the verified authorization-server bearer, never MCP clientInfo. */
export interface FluxMcpClaims {
  ownerUserId: string;
  connectionId: string;
  clientId: string | null;
  grantReferenceId: string | null;
  scopes: readonly string[];
  /** Supplied only by the verified HTTP composition; native internal adapters keep their existing envelope. */
  dispatch?: McpDispatch;
}
export type VerifiedFluxMcpClaims = FluxMcpClaims & { dispatch: McpDispatch };

export interface FluxAgentReadContext {
  tx: Transaction;
  connection: AgentConnectionContext;
  workspaceId: string;
  principal: { kind: 'agent'; id: string };
  mcpPolicy: AgentMcpPolicy | null;
  requireProject(projectId: string, action?: 'project.read' | 'project.write'): Promise<void>;
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
    const store = createAgentConnectionStore(tx);
    const grant = await (claims.dispatch ? store.grantForMcp : store.grantForOauth)(claims.ownerUserId,
      claims.grantReferenceId ?? claims.connectionId);
    if (!grant || grant.connection.id !== claims.connectionId || grant.clientId !== null && grant.clientId !== claims.clientId)
      throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
    const row = grant.connection;
    if (!claims.scopes.includes(scope) || !row.scopes.includes(scope))
      throw new DomainError(403, 'MCP_SCOPE_REQUIRED', 'The connection lacks the required scope');
    const mcpPolicy = claims.dispatch ? await lockAgentMcpPolicy(tx, row.id) : null;
    if (claims.dispatch) {
      if (!mcpPolicy) throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
      const entry = claims.dispatch.current();
      if (!claims.scopes.includes(entry.requiredScope) || !row.scopes.includes(entry.requiredScope))
        throw new DomainError(403, 'MCP_SCOPE_REQUIRED', 'The connection lacks the required scope');
      requireAgentMcpEntry(mcpPolicy, claims.dispatch.dependencies.capturedVersion, entry,
        claims.dispatch.dependencies.capabilities);
    }
    const connection: AgentConnectionContext = {
      connectionId: row.id, ownerUserId: row.ownerUserId, agentId: row.agentId,
      selectedProjectIds: mcpPolicy ? mcpPolicy.selectedProjectIds.filter((id) => row.selectedProjectIds.includes(id)) : row.selectedProjectIds,
      scopes: row.scopes.filter((selected) => claims.scopes.includes(selected)), computeSource: row.computeSource,
    };
    const requireProject = async (id: string, action: 'project.read' | 'project.write' = 'project.read') => {
      requireAgentSelection(connection, id, action === 'project.write' ? scope : 'flux.context.read');
      const checked = enforce(await evaluateProject({ kind: 'agent', id: row.agentId }, action, id, tx, { lock: true }), 'project');
      if (checked.project!.workspaceId !== row.workspaceId) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found');
      claims.dispatch?.project(id, action);
    };
    if (projectId) {
      requireAgentSelection(connection, projectId, scope);
      await requireProject(projectId, scope === 'flux.context.read' ? 'project.read' : 'project.write');
    }
    const objects = agentProjectReads(agentProjectObjectRows(tx));
    return { tx, connection, workspaceId: row.workspaceId, principal: { kind: 'agent', id: row.agentId }, mcpPolicy, requireProject,
      requireObject: async (project, kind, id) => {
        await requireProject(project);
        await objects.requireObject(connection, row.workspaceId, project, kind, id);
        claims.dispatch?.object(project, kind, id);
      } };
}

/** Register aggregate source requirements before any content query, count or snippet projection. */
export function requireMcpSourceKinds(claims: FluxMcpClaims, kinds: readonly string[]): void {
  if (!claims.dispatch) return;
  const capabilities = kinds.map((kind) => {
    const capability = AGENT_MCP_SOURCE_CAPABILITIES[kind];
    if (!capability) throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
    return capability;
  });
  claims.dispatch.requireCapabilities(capabilities);
}
