import type { FastifyInstance } from 'fastify';
import { agentOauthUseCases, workspaceAi, type Database } from '@flux/core';
import { agentConnectionWorkspaceId, workspaceIdOfOauthFlow, workspaceIdsOfOauthClient } from '@flux/db';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import type { FluxAuth } from './auth.js';
import { oauthFlow, verifiedOauthQuery } from './oauth-query.js';
import type { SessionResolver } from './session.js';

const aiOff = (reply: { code(status: number): { send(body: unknown): unknown } }) =>
  reply.code(403).send({ error: 'AI is turned off in this workspace', code: 'WORKSPACE_AI_BLOCKED' });

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
    // F-029, before the chosen connection is resolved (its agent is inactive while AI is off).
    const chosen = await workspaceIdOfOauthFlow(db, session.principal.id, session.sessionId, flow.fingerprint);
    if (chosen && (await workspaceAi(db, chosen)).state !== 'allowed') return aiOff(reply);
    const context = await connections.consentForOauth(session.principal.id, session.sessionId, flow);
    if (!context) return reply.code(403).send({ error: 'Agent connection is unavailable', code: 'AGENT_CONNECTION_UNAVAILABLE' });
    // F-029: a connection of a workspace whose AI is off is never offered for consent.
    if ((await workspaceAi(db, context.connection.workspaceId)).state !== 'allowed') return aiOff(reply);
    return context;
  });
  // Which saved connection this client held before, so a client sent through the provider again finds it chosen (F-024 S2, #312).
  app.get<{ Querystring: { oauth_query?: string } }>('/api/v1/agent-oauth/held-connection', {
    schema: { querystring: { type: 'object', required: ['oauth_query'], additionalProperties: false,
      properties: { oauth_query: { type: 'string', minLength: 1, maxLength: 8192 } } } },
  }, async (request, reply) => {
    const session = await sessions.requirePrincipal(request);
    const { secret } = await auth.$context;
    const params = await verifiedOauthQuery(request.query.oauth_query ?? '', secret);
    const flow = params ? oauthFlow(params, `${publicOrigin}/mcp`) : null;
    if (!params || !flow || params.get('ba_pl') && params.get('ba_pl') !== session.sessionId)
      return reply.code(400).send({ error: 'Invalid OAuth request', code: 'INVALID_OAUTH_QUERY' });
    // F-029: the newest connection this owner bound to the client, if its workspace has AI off, fails closed.
    const held = await workspaceIdsOfOauthClient(db, session.principal.id, flow.clientId);
    if (held[0] && (await workspaceAi(db, held[0])).state !== 'allowed') return aiOff(reply);
    const connectionId = await connections.heldConnectionId(session.principal.id, flow.clientId);
    const workspaceId = connectionId ? await agentConnectionWorkspaceId(db, connectionId, session.principal.id) : null;
    if (workspaceId && (await workspaceAi(db, workspaceId)).state !== 'allowed') return aiOff(reply);
    return { connectionId };
  });
}
