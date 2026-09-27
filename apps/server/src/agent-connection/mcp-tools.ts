import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { agentProposalRepository } from '@flux/db';
import {
  agentProposalUseCases, DomainError, enforce, evaluateProject, getProject,
  requireAgentSelection, recordEvent, type AgentConnectionContext, type Database,
} from '@flux/core';
import { conversationStore } from '../conversation/store.js';
import { createAgentConnectionStore } from './store.js';

/** Claims are verified by the HTTP entry point; neither an agent nor a project comes from tool input. */
export interface FluxMcpClaims {
  ownerUserId: string;
  connectionId: string;
  scopes: readonly string[];
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(error: unknown) {
  const safe = error instanceof DomainError
    ? { code: error.code, error: error.message }
    : { code: 'MCP_TOOL_UNAVAILABLE', error: 'Tool unavailable' };
  return { ...toolResult(safe), isError: true };
}

/** A fresh server is bound to one verified bearer request; each tool rechecks current grants. */
export function createFluxMcpServer(db: Database, claims: FluxMcpClaims): McpServer {
  const server = new McpServer({ name: 'flux', version: '0.1.0' });
  const connections = createAgentConnectionStore(db);
  const materials = conversationStore(db);
  const proposals = agentProposalUseCases(agentProposalRepository(db, {
    async authorizeWrite(principal, projectId, tx) {
      const checked = enforce(await evaluateProject(principal, 'project.write', projectId, tx, { lock: true }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    async authorizeRead(principal, projectId, tx) {
      enforce(await evaluateProject(principal, 'project.read', projectId, tx, { lock: true }), 'project');
    },
    async recordCreated(principal, workspaceId, projectId, tx) {
      await recordEvent(tx, principal, workspaceId, 'project.proposal_created.v1', projectId, {});
    },
  }));

  async function current(scope: 'flux.context.read' | 'flux.proposal.write'): Promise<AgentConnectionContext> {
    const connection = await connections.resolve(claims.ownerUserId, claims.connectionId);
    if (!connection) throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
    if (!claims.scopes.includes(scope) || !connection.scopes.includes(scope))
      throw new DomainError(403, 'MCP_SCOPE_REQUIRED', 'The connection lacks the required scope');
    return {
      connectionId: connection.id,
      ownerUserId: connection.ownerUserId,
      agentId: connection.agentId,
      selectedProjectIds: connection.selectedProjectIds,
      scopes: connection.scopes.filter((selected) => claims.scopes.includes(selected)),
      computeSource: connection.computeSource,
    };
  }

  server.registerTool('flux_list_contexts', {
    title: 'List selected Flux projects',
    description: 'List the projects selected for this agent connection and still readable under current grants.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const connection = await current('flux.context.read');
      const principal = { kind: 'agent' as const, id: connection.agentId };
      const projects = await Promise.all(connection.selectedProjectIds.map(async (id) => {
        const project = await getProject(principal, id, db);
        return { id: project.id, name: project.name, workspaceId: project.workspaceId };
      }));
      return toolResult({ projects });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('flux_read_material', {
    title: 'Read a project material',
    description: 'Read one current project material and its exact version from a selected project. Private drafts are excluded.',
    inputSchema: z.object({ projectId: z.uuid(), materialId: z.uuid() }),
    annotations: { readOnlyHint: true },
  }, async ({ projectId, materialId }) => {
    try {
      const connection = await current('flux.context.read');
      requireAgentSelection(connection, projectId, 'flux.context.read');
      const material = await materials.getMaterial({ kind: 'agent', id: connection.agentId }, materialId);
      if (material.projectId !== projectId) throw new DomainError(404, 'MATERIAL_NOT_FOUND', 'Material not found');
      return toolResult({ projectId, materialId: material.materialId, version: material.version,
        title: material.title, body: material.body, url: material.url, updatedAt: material.updatedAt });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('flux_create_proposal', {
    title: 'Propose a sourced project action',
    description: 'Submit a human-reviewable suggestion based on the current version of a selected project material.',
    inputSchema: z.object({
      projectId: z.uuid(), materialId: z.uuid(), version: z.int().min(1), clientCommandId: z.uuid(),
      fact: z.string().min(1).max(10_000), interpretation: z.string().min(1).max(10_000),
      suggestedAction: z.string().min(1).max(10_000),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ projectId, materialId, version, clientCommandId, fact, interpretation, suggestedAction }) => {
    try {
      const connection = await current('flux.proposal.write');
      const proposal = await proposals.create(connection, {
        projectId, source: { materialId, version }, clientCommandId, fact, interpretation, suggestedAction,
      });
      return toolResult(proposal);
    } catch (error) { return toolError(error); }
  });

  return server;
}
