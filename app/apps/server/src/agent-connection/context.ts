import { AGENT_MCP_SOURCE_CAPABILITIES, type AgentMcpPolicy, type AgentScope } from '@flux/contracts';
import {
  agentProjectReads,
  DomainError,
  enforce,
  evaluateProject,
  requireAgentMcpEntry,
  requireAgentSelection,
  requireWorkspaceAi,
  type AgentConnectionContext,
  type AgentProjectObjectKind,
  type Database,
  type Transaction,
} from '@flux/core';
import { agentProjectObjectRows, lockAgentMcpPolicy, loadActor, accessReader } from '@flux/db';
import { createAgentConnectionStore } from './store.js';
import type { McpDispatch } from './mcp-dispatch.js';
import { requireLiveRun, type RunTokenClaims } from './run-token.js';
import type { AssistantApproval } from './assistant-changes.js';

/** Constructed only from the verified authorization-server bearer, never MCP clientInfo. */
export interface FluxMcpClaims {
  ownerUserId: string;
  connectionId: string;
  clientId: string | null;
  grantReferenceId: string | null;
  scopes: readonly string[];
  /** Supplied only by the verified HTTP composition; native internal adapters keep their existing envelope. */
  dispatch?: McpDispatch;
  /** Optional immutable URL restriction admitted by the HTTP bearer composition; grants nothing. */
  boundProjectId?: string;
  /**
   * A personal run's token (F-027 A2): only from the verified bearer's signed `flux_run_id`/`flux_place`.
   * The run must stay in flight and every tool reaches only its place.
   */
  run?: RunTokenClaims;
  /**
   * Server-owned only (F-027 A3): the owner's Apply or the live-Wiki deferral re-executing one saved change.
   * Never constructed from a bearer or tool input.
   */
  approval?: AssistantApproval;
}
export type VerifiedFluxMcpClaims = FluxMcpClaims & { dispatch: McpDispatch };

export interface FluxAgentReadContext {
  tx: Transaction;
  connection: AgentConnectionContext;
  workspaceId: string;
  principal: { kind: 'agent'; id: string };
  /** F-029: the workspace AI policy epoch, held `FOR SHARE` for the transaction; new AI work rows record it. */
  aiEpoch: number;
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
    const grant = await (claims.run ? store.grantForRun : claims.dispatch ? store.grantForMcp : store.grantForOauth)(claims.ownerUserId,
      claims.grantReferenceId ?? claims.connectionId);
    if (!grant || grant.connection.id !== claims.connectionId || grant.clientId !== null && grant.clientId !== claims.clientId)
      throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
    const row = grant.connection;
    // F-029: every tool, resource and prompt, with or without a project, refuses while AI is off here.
    const { epoch: aiEpoch } = await requireWorkspaceAi(accessReader(tx), row.workspaceId, { lock: true });
    // A run token works only while its run is in flight, under its own id, for the owner's assistant.
    if (claims.run) await requireLiveRun(tx, { ownerUserId: claims.ownerUserId, connectionId: claims.connectionId, run: claims.run }, { newCall: true, lock: true });
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
      // Project-independent resources and runtime ACKs also require the owned
      // agent's current owner membership, under the same protected lock prefix.
      const actor = await loadActor({ kind: 'agent', id: row.agentId }, row.workspaceId, tx, { lock: true });
      if (!actor.active || actor.agent?.ownerUserId !== row.ownerUserId)
        throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
      claims.dispatch.admit(entry);
    }
    const connection: AgentConnectionContext = {
      connectionId: row.id, ownerUserId: row.ownerUserId, agentId: row.agentId,
      // A run reaches only its place (F-022): the selection narrows to the run's project.
      selectedProjectIds: (mcpPolicy ? mcpPolicy.selectedProjectIds.filter((id) => row.selectedProjectIds.includes(id)) : row.selectedProjectIds)
        .filter((id) => (!claims.run || id === claims.run.projectId) && (!claims.boundProjectId || id === claims.boundProjectId)),
      scopes: row.scopes.filter((selected) => claims.scopes.includes(selected)), computeSource: row.computeSource,
    };
    const requireProject = async (id: string, action: 'project.read' | 'project.write' = 'project.read') => {
      requireAgentSelection(connection, id, action === 'project.write' ? scope : 'flux.context.read');
      const checked = enforce(await evaluateProject({ kind: 'agent', id: row.agentId }, action, id, accessReader(tx), { lock: true }), 'project');
      if (checked.project!.workspaceId !== row.workspaceId) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found');
      claims.dispatch?.project(id, action);
    };
    if (projectId) {
      requireAgentSelection(connection, projectId, scope);
      await requireProject(projectId, scope === 'flux.context.read' ? 'project.read' : 'project.write');
    }
    const objects = agentProjectReads(agentProjectObjectRows(tx));
    return { tx, connection, workspaceId: row.workspaceId, principal: { kind: 'agent', id: row.agentId }, aiEpoch, mcpPolicy, requireProject,
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
