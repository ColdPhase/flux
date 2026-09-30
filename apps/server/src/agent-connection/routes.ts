import type { FastifyError, FastifyInstance } from 'fastify';
import type { CreateAgentConnectionCommand, PageQuery } from '@flux/contracts';
import { agentProposalRepository } from '@flux/db';
import { agentConnectionUseCases, agentOauthUseCases, agentProposalUseCases, DomainError, enforce, evaluateProject, recordEvent, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { createAgentConnectionStore } from './store.js';
import { oauthFlow, verifiedOauthQuery } from '../identity/oauth-query.js';

interface Options { db: Database; sessions: SessionResolver; oauthSecret: string; publicOrigin: string }

/** The human review surface uses the same current project policy as conversations. */
export async function agentProposalRoutes(app: FastifyInstance, { db, sessions, oauthSecret, publicOrigin }: Options) {
  const connectionStore = createAgentConnectionStore(db);
  const connections = agentConnectionUseCases(connectionStore);
  const oauth = agentOauthUseCases(connectionStore);
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
        items: { type: 'string', enum: ['flux.context.read', 'flux.proposal.write'] } },
        name: { type: 'string', minLength: 1, maxLength: 120 }, clientDesignation: { type: 'string', enum: ['claude_code', 'codex', 'other'] } } } },
  }, async (request, reply) => reply.code(201).send(await connections.create(
    (await sessions.requirePrincipal(request)).principal, request.body)));
  app.get('/api/v1/agent-connections', async (request) => connections.list(
    (await sessions.requirePrincipal(request)).principal));
  app.delete<{ Params: { connectionId: string } }>('/api/v1/agent-connections/:connectionId', async (request, reply) => {
    await connections.revoke((await sessions.requirePrincipal(request)).principal, request.params.connectionId);
    return reply.code(204).send();
  });
  app.post<{ Params: { connectionId: string }; Body: { oauth_query: string } }>('/api/v1/agent-connections/:connectionId/select-for-oauth',
    { schema: { body: { type: 'object', required: ['oauth_query'], additionalProperties: false,
      properties: { oauth_query: { type: 'string', minLength: 1, maxLength: 8192 } } } } },
    async (request, reply) => {
      const session = await sessions.requirePrincipal(request);
      const params = await verifiedOauthQuery(request.body.oauth_query, oauthSecret);
      const flow = params ? oauthFlow(params, `${publicOrigin}/mcp`) : null;
      if (!params || !flow || params.get('ba_pl') && params.get('ba_pl') !== session.sessionId)
        return reply.code(400).send({ error: 'Invalid OAuth request', code: 'INVALID_OAUTH_QUERY' });
      const result = await oauth.chooseFlow(session.principal.id, session.sessionId, request.params.connectionId, flow);
      if (result === 'CONNECTION_NOT_FOUND') return reply.code(404).send({ error: 'Connection not found', code: result });
      if (result === 'ALREADY_SELECTED') return reply.code(409).send({ error: 'A different connection is selected for this OAuth request', code: result });
      return reply.code(204).send();
    });
  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/agent-proposals',
    { schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } } },
    async (request) => store.listForPerson((await sessions.requirePrincipal(request)).principal, request.params.projectId, request.query));
}
