import type { FastifyError, FastifyInstance } from 'fastify';
import { AGENT_MAY_DO, type UpdateAgentConnectionCommand, type PageQuery } from '@flux/contracts';
import { agentProposalRepository, accessReader, type Database } from '@flux/db';
import { agentConnectionUseCases, agentProposalUseCases, DomainError, enforce, evaluateProject, recordEvent } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { createAgentConnectionStore } from './store.js';
import { eventPorts } from '../events.js';
import { securityEvent } from '../security-log.js';

interface Options { db: Database; sessions: SessionResolver }

/** The human review surface uses the same current project policy as conversations. */
export async function agentProposalRoutes(app: FastifyInstance, { db, sessions }: Options) {
  const connectionStore = createAgentConnectionStore(db);
  const connections = agentConnectionUseCases(connectionStore);
  const store = agentProposalUseCases(agentProposalRepository(db, {
    async authorizeWrite(principal, projectId, tx) {
      const checked = enforce(await evaluateProject(principal, 'project.write', projectId, accessReader(tx), { lock: true }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    async authorizeRead(principal, projectId, tx) {
      enforce(await evaluateProject(principal, 'project.read', projectId, accessReader(tx), { lock: true }), 'project');
    },
    async recordCreated(principal, workspaceId, projectId, tx) {
      await recordEvent(eventPorts(tx), principal, workspaceId, 'project.proposal_created.v1', projectId, {});
    },
  }));
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if ((error as FastifyError).statusCode === 401)
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.get('/api/v1/agent-connections', async (request) => connections.list(
    (await sessions.requirePrincipal(request)).principal));
  // Ask me first (F-036 AG-3): a browser session of the owner only; no bearer, run token or MCP client reaches it.
  app.patch<{ Params: { connectionId: string }; Body: UpdateAgentConnectionCommand }>('/api/v1/agent-connections/:connectionId', {
    schema: { body: { type: 'object', required: ['mayDo'], additionalProperties: false, properties: { mayDo: { type: 'string', enum: [...AGENT_MAY_DO] } } } },
  }, async (request) => connections.update((await sessions.requirePrincipal(request)).principal, request.params.connectionId, request.body));
  app.delete<{ Params: { connectionId: string } }>('/api/v1/agent-connections/:connectionId', async (request, reply) => {
    const who = (await sessions.requirePrincipal(request)).principal;
    await connections.revoke(who, request.params.connectionId);
    securityEvent(request.log, { event: 'client_disconnected', outcome: 'success', reason: 'disconnect', userId: who.id, count: 1, ip: request.ip });
    return reply.code(204).send();
  });
  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/agent-proposals',
    { schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } } },
    async (request) => store.listForPerson((await sessions.requirePrincipal(request)).principal, request.params.projectId, request.query));
}
