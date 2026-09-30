import type { FastifyInstance } from 'fastify';
import { agentOauthUseCases, type Database } from '@flux/core';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import type { FluxAuth } from './auth.js';
import { oauthFlow, verifiedOauthQuery } from './oauth-query.js';
import type { SessionResolver } from './session.js';

/** Only signed, current OAuth requests may supply the consent screen's display data. */
export function registerAgentOauthContext(app: FastifyInstance, db: Database, sessions: SessionResolver, auth: FluxAuth, publicOrigin: string) {
  const connections = agentOauthUseCases(createAgentConnectionStore(db));
  app.get<{ Querystring: { oauth_query?: string } }>('/api/v1/agent-oauth/consent-context', {
    schema: { querystring: { type: 'object', required: ['oauth_query'], additionalProperties: false,
      properties: { oauth_query: { type: 'string', minLength: 1, maxLength: 8192 } } } },
  }, async (request, reply) => {
    const session = await sessions.requirePrincipal(request);
    const { secret } = await auth.$context;
    const params = await verifiedOauthQuery(request.query.oauth_query ?? '', secret);
    const flow = params ? oauthFlow(params, `${publicOrigin}/mcp`) : null;
    const clientId = flow?.clientId;
    if (!params || !flow || !clientId || params.get('ba_pl') && params.get('ba_pl') !== session.sessionId)
      return reply.code(400).send({ error: 'Invalid OAuth request', code: 'INVALID_OAUTH_QUERY' });
    const context = await connections.consentForOauth(session.principal.id, session.sessionId, flow);
    if (!context) return reply.code(403).send({ error: 'Agent connection is unavailable', code: 'AGENT_CONNECTION_UNAVAILABLE' });
    return context;
  });
}
