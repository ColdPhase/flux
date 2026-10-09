import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { agentProposalRepository } from '@flux/db';
import { agentProposalUseCases, enforce, evaluateProject, recordEvent, type Database } from '@flux/core';
import { registerAgentPlaybook } from './playbook.js';
import { registerAgentPolicyResource } from './project-policy.js';
import { agentToolRegistry } from './tool-registry.js';
import type { AgentScope, AgentToolCapability } from '@flux/contracts';

const AGENT_SCOPES: readonly AgentScope[] = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
import { registerAgentBootstrap } from './bootstrap.js';
import { registerAgentDomainReads } from './domain-reads.js';
import { registerAgentWorkActions } from './work-actions.js';
import { registerAgentMapActions } from './map-actions.js';
import { registerAgentDocActions } from './doc-actions.js';
import { registerAgentConversationActions } from './conversation-actions.js';
import { registerAgentCoworkActions } from './cowork-actions.js';
import { withAgentConnection, type FluxMcpClaims } from './context.js';
import { toolError, toolResult } from './tool-results.js';
import { eventPorts } from '../events.js';

export type { FluxMcpClaims } from './context.js';

/** A fresh server is bound to one verified bearer; each tool rechecks inside its transaction. */
export function createFluxMcpServer(db: Database, claims: FluxMcpClaims, cursorSecret: string): McpServer {
  const server = new McpServer({ name: 'flux', version: '0.1.0' });
  registerFluxTools(server, db, claims, cursorSecret);
  return server;
}

/**
 * The tools of this connection, as the live server registers them, with whether its scopes make each one
 * available. A run's tool list is derived from this (run-tools.ts), so it follows the same registrations.
 */
export function fluxToolCapabilities(db: Database, claims: FluxMcpClaims, cursorSecret: string): AgentToolCapability[] {
  const tools = registerFluxTools(new McpServer({ name: 'flux', version: '0.1.0' }), db, claims, cursorSecret);
  const scopes = claims.scopes.filter((scope): scope is AgentScope => AGENT_SCOPES.includes(scope as AgentScope));
  return tools.capabilities(scopes);
}

function registerFluxTools(server: McpServer, db: Database, claims: FluxMcpClaims, cursorSecret: string) {
  const tools = agentToolRegistry(server);
  registerAgentPlaybook(server, tools, db, claims);
  registerAgentPolicyResource(server, db, claims);
  registerAgentDomainReads(tools.forScope('flux.context.read'), db, claims, cursorSecret);
  registerAgentBootstrap(tools, db, claims);
  registerAgentWorkActions(tools, db, claims);
  registerAgentMapActions(tools, db, claims);
  registerAgentDocActions(tools, db, claims);
  registerAgentConversationActions(tools, db, claims);
  registerAgentCoworkActions(tools, db, claims);
  tools.forScope('flux.proposal.write').registerTool('flux_create_proposal', {
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
      const proposal = await withAgentConnection(db, claims, 'flux.proposal.write', projectId, async ({ tx, connection }) => {
        const proposals = agentProposalUseCases(agentProposalRepository(tx, {
          async authorizeWrite(principal, id, transaction) {
            const checked = enforce(await evaluateProject(principal, 'project.write', id, transaction, { lock: true }), 'project');
            return { workspaceId: checked.project!.workspaceId };
          },
          async authorizeRead(principal, id, transaction) {
            enforce(await evaluateProject(principal, 'project.read', id, transaction, { lock: true }), 'project');
          },
          async recordCreated(principal, workspaceId, id, transaction) {
            await recordEvent(eventPorts(transaction), principal, workspaceId, 'project.proposal_created.v1', id, {});
          },
        }));
        return proposals.create(connection, { projectId, source: { materialId, version }, clientCommandId, fact, interpretation, suggestedAction });
      });
      return toolResult(proposal);
    } catch (error) { return toolError(error); }
  });
  return tools;
}
