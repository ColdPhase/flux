import type { FastifyError, FastifyInstance } from 'fastify';
import type { CreateAgentConnectionCommand, PageQuery } from '@flux/contracts';
import { agentConnectionRepository, agentProposalRepository } from '@flux/db';
import { agentConnectionUseCases, agentProposalUseCases, DomainError, enforce, evaluateProject, recordEvent, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

interface Options { db: Database; sessions: SessionResolver }

/** The human review surface uses the same current project policy as conversations. */
export async function agentProposalRoutes(app: FastifyInstance, { db, sessions }: Options) {
  const connections = agentConnectionUseCases(agentConnectionRepository(db, {
    async authorizeProject(agentId, projectId, action, tx) {
      const checked = enforce(await evaluateProject({ kind: 'agent', id: agentId }, action, projectId, tx, { lock: true }), 'project');
      return checked.project!.workspaceId;
    },
  }));
  const store = agentProposalUseCases(agentProposalRepository(db, {
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
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if ((error as FastifyError).statusCode === 401)
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.post<{ Body: CreateAgentConnectionCommand }>('/api/v1/agent-connections', {
    schema: { body: { type: 'object', required: ['agentId', 'selectedProjectIds', 'scopes'], additionalProperties: false,
      properties: { agentId: { type: 'string' }, selectedProjectIds: { type: 'array', minItems: 1, maxItems: 50,
        items: { type: 'string' } }, scopes: { type: 'array', minItems: 1, maxItems: 2,
        items: { type: 'string', enum: ['flux.context.read', 'flux.proposal.write'] } } } } },
  }, async (request, reply) => reply.code(201).send(await connections.create(
    (await sessions.requirePrincipal(request)).principal, request.body)));
  app.get('/api/v1/agent-connections', async (request) => connections.list(
    (await sessions.requirePrincipal(request)).principal));
  app.delete<{ Params: { connectionId: string } }>('/api/v1/agent-connections/:connectionId', async (request, reply) => {
    await connections.revoke((await sessions.requirePrincipal(request)).principal, request.params.connectionId);
    return reply.code(204).send();
  });
  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/agent-proposals',
    { schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } } },
    async (request) => store.listForPerson((await sessions.requirePrincipal(request)).principal, request.params.projectId, request.query));
}
