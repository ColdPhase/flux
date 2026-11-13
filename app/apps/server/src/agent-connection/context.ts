import type { AgentMayDo, AgentToolAccess } from '@flux/contracts';
import { agentProjectReads, DomainError, enforce, evaluateProject, requireAgentProject, requireSpaceAi, type AgentConnectionContext,
  type AgentProjectObjectKind } from '@flux/core';
import { agentProjectObjectRows, commitWithoutFlush, reachableProjectIds, accessReader, type Database, type Transaction } from '@flux/db';
import { createAgentConnectionStore } from './store.js';
import type { McpDispatch } from './mcp-dispatch.js';
import { requireLiveRun, runReaches, type RunTokenClaims } from './run-token.js';
import type { AssistantApproval } from './assistant-changes.js';

/** Constructed only from the verified authorization-server bearer, never MCP clientInfo. */
export interface FluxMcpClaims {
  ownerUserId: string;
  connectionId: string;
  clientId: string | null;
  grantReferenceId: string | null;
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
   * Server-owned only (F-027 A3): the owner's Approve re-executing one saved change.
   * Never constructed from a bearer or tool input.
   */
  approval?: AssistantApproval;
}
export type VerifiedFluxMcpClaims = FluxMcpClaims & { dispatch: McpDispatch };

export interface FluxAgentReadContext {
  tx: Transaction;
  connection: AgentConnectionContext;
  /** Ask me first, read with the connection row held. */
  mayDo: AgentMayDo;
  workspaceId: string;
  principal: { kind: 'agent'; id: string };
  /** Every project the connection's owner can see now. A run reaches only its place. Whether the agent may use one is `requireProject`'s. */
  reachable(): Promise<string[]>;
  requireProject(projectId: string, action?: 'project.read' | 'project.write'): Promise<void>;
  requireObject(projectId: string, kind: AgentProjectObjectKind, id: string): Promise<void>;
}

/**
 * Hold live binding, connection and central access locks throughout content projection/effect. `onlyReads`: the tool writes nothing, so
 * its COMMIT, which only ends those locks, does not wait for a disk flush (#1429).
 */
export function withAgentConnection<T>(db: Database, claims: FluxMcpClaims, access: AgentToolAccess,
  projectId: string | null, read: (context: FluxAgentReadContext) => Promise<T>, options: { onlyReads?: boolean } = {}): Promise<T> {
  return db.transaction(async (tx) => {
    if (options.onlyReads && access === 'read') await commitWithoutFlush(tx);
    return read(await agentConnectionInTransaction(tx, claims, access, projectId));
  });
}

/**
 * The same authorization boundary composed into #152/#153's caller-owned transaction. A client acts with its owner's rights at
 * this moment and does what its Ask me first says: there is no scope, project list or capability switch to consult (#859).
 */
export async function agentConnectionInTransaction(tx: Transaction, claims: FluxMcpClaims, access: AgentToolAccess,
  projectId: string | null): Promise<FluxAgentReadContext> {
    const store = createAgentConnectionStore(tx);
    const grant = await (claims.run ? store.grantForRun : store.grantForOauth)(claims.ownerUserId, claims.grantReferenceId ?? claims.connectionId);
    if (!grant || grant.connection.id !== claims.connectionId || grant.clientId !== null && grant.clientId !== claims.clientId)
      throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
    const row = grant.connection;
    // A run token works only while its run is in flight, under its own id, for the owner's assistant.
    if (claims.run) await requireLiveRun(tx, { ownerUserId: claims.ownerUserId, connectionId: claims.connectionId, run: claims.run }, { newCall: true, lock: true });
    // C-22: the agent acts only while its owner is a non-guest member of the company, checked in this transaction before any write
    // (a project-independent call such as a runtime acknowledgement reaches no project, so nothing else would stop it).
    const actor = await accessReader(tx).loadActor({ kind: 'agent', id: row.agentId }, row.workspaceId, { lock: true });
    if (!actor.active || actor.agent?.ownerUserId !== row.ownerUserId)
      throw new DomainError(403, 'AGENT_OWNER_UNAVAILABLE', 'This client is unavailable: its owner is no longer a member of the company');
    const connection: AgentConnectionContext = { connectionId: row.id, ownerUserId: row.ownerUserId, agentId: row.agentId, computeSource: row.computeSource };
    const reachable = async () => (await reachableProjectIds(tx, row.id)).filter((id) => (!claims.run || runReaches(claims.run, id)) && (!claims.boundProjectId || id === claims.boundProjectId));
    const requireProject = async (id: string, action: 'project.read' | 'project.write' = 'project.read') => {
      requireAgentProject(connection, id);
      // A run reaches only its place (F-022), and a request bound to one project only that one.
      if (claims.run && !runReaches(claims.run, id) || claims.boundProjectId && id !== claims.boundProjectId) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found');
      // AG-10: every tool, resource and prompt that names a space refuses while AI is off there.
      await requireSpaceAi(accessReader(tx), id, { lock: true });
      // The agent's standing was read and locked when the connection was checked, in this transaction (#1429).
      const checked = enforce(await evaluateProject({ kind: 'agent', id: row.agentId }, action, id, accessReader(tx), { lock: true, known: actor }), 'project');
      if (checked.project!.workspaceId !== row.workspaceId) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found');
      claims.dispatch?.project(id, action);
    };
    if (projectId) await requireProject(projectId, access === 'read' ? 'project.read' : 'project.write');
    const objects = agentProjectReads(agentProjectObjectRows(tx));
    return { tx, connection, mayDo: row.mayDo, workspaceId: row.workspaceId, principal: { kind: 'agent', id: row.agentId }, reachable, requireProject,
      requireObject: async (project, kind, id) => {
        await requireProject(project);
        await objects.requireObject(connection, row.workspaceId, project, kind, id);
        claims.dispatch?.object(project, kind, id);
      } };
}
