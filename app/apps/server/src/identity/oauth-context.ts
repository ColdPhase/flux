import type { FastifyInstance } from 'fastify';
import { agentOauthUseCases } from '@flux/core';
import { oauthClientName, type Database } from '@flux/db';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import { createOneClickSignIn } from '../agent-connection/one-click.js';
import type { FluxAuth } from './auth.js';
import { oauthFlow, verifiedOauthQuery } from './oauth-query.js';
import type { SessionResolver } from './session.js';

/** Only signed, current OAuth requests may supply the consent screen's display data. */
export function registerAgentOauthContext(app: FastifyInstance, db: Database, sessions: SessionResolver, auth: FluxAuth, publicOrigin: string) {
  const connections = agentOauthUseCases(createAgentConnectionStore(db));
  const signIn = createOneClickSignIn(db);
  app.get<{ Querystring: { oauth_query?: string } }>('/api/v1/agent-oauth/consent-context', {
    schema: { querystring: { type: 'object', required: ['oauth_query'], additionalProperties: false,
      properties: { oauth_query: { type: 'string', minLength: 1, maxLength: 8192 } } } },
  }, async (request, reply) => {
    const session = await sessions.requirePrincipal(request);
    const { secret } = await auth.$context;
    const params = await verifiedOauthQuery(request.query.oauth_query ?? '', secret);
    const flow = params ? oauthFlow(params, `${publicOrigin}/mcp`) : null;
    // The request is bound to the session that reached the consent page (#859): another browser's session cannot approve it.
    if (!params || !flow || params.get('ba_pl') !== session.sessionId)
      return reply.code(400).send({ error: 'Invalid OAuth request', code: 'INVALID_OAUTH_QUERY' });
    // The client's own name is its claim, a recognition aid only. A client that is unknown or disabled is not offered.
    const clientName = await oauthClientName(db, flow.clientId);
    if (clientName === null || !await signIn.available(session.principal.id, flow.clientId))
      return reply.code(403).send({ error: 'Agent connection is unavailable', code: 'AGENT_CONNECTION_UNAVAILABLE' });
    return connections.consentContext(session.principal.id, flow, clientName || flow.clientId);
  });
}
