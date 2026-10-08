import type { FastifyInstance } from 'fastify';
import { AGENT_MCP_ENTRIES, agentMcpPolicyPath, type SaveAgentMcpPolicy } from '@flux/contracts';
import { agentMcpPolicyUseCases, DomainError, evaluateProject, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { createMcpPolicyStore } from './mcp-policy-store.js';

/** Ordinary authenticated owner management; no recent-auth or additional login flow. */
export async function agentMcpPolicyRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  useDomainErrors(app);
  const useCases = agentMcpPolicyUseCases(createMcpPolicyStore(db));
  app.get<{ Params: { connectionId: string } }>(agentMcpPolicyPath(':connectionId'), async (request, reply) => {
    const principal = (await sessions.requirePrincipal(request)).principal;
    const result = await db.transaction(async (tx) => {
      const current = await agentMcpPolicyUseCases(createMcpPolicyStore(tx)).get(principal, request.params.connectionId);
      const projects = [];
      for (const projectId of [...current.connection.selectedProjectIds].sort()) {
        const actor = { kind: 'agent' as const, id: current.connection.agentId };
        const read = await evaluateProject(actor, 'project.read', projectId, tx, { lock: true });
        const write = await evaluateProject(actor, 'project.write', projectId, tx, { lock: true });
        projects.push({ id: projectId, selected: current.policy.selectedProjectIds.includes(projectId),
          readable: read.allowed, writable: write.allowed });
      }
      const entries = AGENT_MCP_ENTRIES.map((entry) => {
        const originalScope = current.connection.scopes.includes(entry.requiredScope);
        const admitted = current.policy.enabledEntryIds.includes(entry.id);
        const enabled = admitted && entry.requiredCapabilities.every((id) => current.policy.enabledCapabilityIds.includes(id));
        const selected = projects.filter((project) => project.selected);
        const rights = selected.some((project) => entry.requiredScope === 'flux.context.read' ? project.readable : project.writable);
        const reason = !originalScope ? 'outside_original_consent' : !admitted ? 'entry_not_enabled' : !enabled ? 'permission_off'
          : !selected.length ? 'no_selected_project' : !rights ? 'project_access_unavailable'
            : entry.operation ? 'bounded_action_grant_required' : null;
        return { ...entry, configured: enabled, available: reason === null, reason };
      });
      return { ...current, projects, entries };
    });
    return reply.header('cache-control', 'no-store').header('etag', `"mcp-policy-${result.policy.version}"`).send(result);
  });
  app.patch<{ Params: { connectionId: string }; Body: SaveAgentMcpPolicy }>(agentMcpPolicyPath(':connectionId'), {
    preValidation: async (request) => {
      const keys = ['enabledCapabilityIds', 'enabledEntryIds', 'selectedProjectIds'];
      if (request.body && typeof request.body === 'object' && Object.keys(request.body).some((key) => !keys.includes(key)))
        throw new DomainError(400, 'INVALID_INPUT', 'Only the displayed permissions and selected projects may change');
    },
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['enabledCapabilityIds', 'enabledEntryIds', 'selectedProjectIds'], properties: {
        enabledCapabilityIds: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', maxLength: 80 } },
        enabledEntryIds: { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string', maxLength: 120 } },
        selectedProjectIds: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string' } },
      } } },
  }, async (request, reply) => {
    const principal = (await sessions.requirePrincipal(request)).principal;
    const match = typeof request.headers['if-match'] === 'string'
      ? /^"mcp-policy-([1-9][0-9]*)"$/.exec(request.headers['if-match']) : null;
    if (!match) throw new DomainError(428, 'PRECONDITION_REQUIRED', 'Reload these permissions before saving');
    const policy = await useCases.save(principal, request.params.connectionId, Number(match[1]), request.body);
    return reply.header('cache-control', 'no-store').header('etag', `"mcp-policy-${policy.version}"`).send({ policy });
  });
}
