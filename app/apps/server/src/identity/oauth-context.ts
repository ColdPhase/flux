import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import type { FluxAuth } from './auth.js';
import { verifiedOauthQuery } from './oauth-query.js';
import type { SessionResolver } from './session.js';

/** Only signed, current OAuth requests may supply the consent screen's display data. */
export function registerAgentOauthContext(app: FastifyInstance, db: Database, sessions: SessionResolver, auth: FluxAuth) {
  const connections = createAgentConnectionStore(db);
  app.get<{ Querystring: { oauth_query?: string } }>('/api/v1/agent-oauth/consent-context', {
    schema: { querystring: { type: 'object', required: ['oauth_query'], additionalProperties: false,
      properties: { oauth_query: { type: 'string', minLength: 1, maxLength: 8192 } } } },
  }, async (request, reply) => {
    const session = await sessions.requirePrincipal(request);
    const { secret } = await auth.$context;
    const params = await verifiedOauthQuery(request.query.oauth_query ?? '', secret);
    const clientId = params?.get('client_id');
    if (!params || !clientId) return reply.code(400).send({ error: 'Invalid OAuth request', code: 'INVALID_OAUTH_QUERY' });
    const connection = await connections.selectedForOauth(session.principal.id, session.sessionId);
    if (!connection) return reply.code(403).send({ error: 'Agent connection is unavailable', code: 'AGENT_CONNECTION_UNAVAILABLE' });
    const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
    if (scopes.some((scope) => scope !== 'offline_access' && !connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write'))) {
      return reply.code(403).send({ error: 'Requested scope is unavailable', code: 'AGENT_SCOPE_UNAVAILABLE' });
    }
    const [client] = await db.select({ name: schema.oauthClient.name, clientId: schema.oauthClient.clientId })
      .from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId));
    if (!client) return reply.code(400).send({ error: 'OAuth client is unavailable', code: 'OAUTH_CLIENT_UNAVAILABLE' });
    const [agent] = await db.select({ name: schema.agents.name }).from(schema.agents).where(and(
      eq(schema.agents.id, connection.agentId), eq(schema.agents.ownerUserId, session.principal.id)));
    const selectedProjects = await db.select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects).where(inArray(schema.projects.id, connection.selectedProjectIds));
    return { clientName: client.name ?? client.clientId, scopes, connection,
      agentName: agent?.name ?? connection.agentId, selectedProjects };
  });
}
