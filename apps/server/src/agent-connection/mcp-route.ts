import type { FastifyInstance } from 'fastify';
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Database } from '@flux/core';
import type { FluxAuth } from '../identity/auth.js';
import { createFluxMcpServer } from './mcp-tools.js';

/** The only remote MCP entry point. A new tool server is bound to each verified bearer request. */
export function registerMcpRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string) {
  const protectedFetch = requireMcpAuth(auth, async (request, token) => {
    const ownerUserId = token.flux_owner_user_id;
    const connectionId = token.flux_connection_id;
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
    if (typeof ownerUserId !== 'string' || typeof connectionId !== 'string') {
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    const handler = createMcpHandler(() => createFluxMcpServer(db, { ownerUserId, connectionId, scopes }), { legacy: 'reject' });
    return handler.fetch(request);
  }, { resource: `${publicOrigin}/mcp` });
  const node = toNodeHandler({ fetch: protectedFetch }, { onerror: (error) => app.log.error({ error }, 'MCP request failed') });
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: async (request, reply) => {
    reply.hijack();
    await node(request.raw, reply.raw, request.body);
  } });
}
