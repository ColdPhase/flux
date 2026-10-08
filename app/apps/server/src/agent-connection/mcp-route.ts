import type { FastifyInstance } from 'fastify';
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Database } from '@flux/core';
import { lockAgentMcpPolicy } from '@flux/db';
import type { FluxAuth } from '../identity/auth.js';
import { createFluxMcpServer } from './mcp-tools.js';
import { createAgentConnectionStore } from './store.js';
import { createMcpDispatch, type McpDispatch } from './mcp-dispatch.js';

/** The only remote MCP entry point. A new tool server is bound to each verified bearer request. */
export function registerMcpRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string) {
  const handleVerified = async (request: Request, token: Record<string, unknown>) => {
    const ownerUserId = token.flux_owner_user_id;
    const connectionId = token.flux_connection_id;
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
    if (typeof ownerUserId !== 'string' || typeof connectionId !== 'string' || token.sub !== ownerUserId) {
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    // A signed JWT remains valid until expiry, so revocation must be checked
    // against the live connection before even listing tools.
    let dispatch: McpDispatch;
    try {
      const referenceId = token.flux_grant_reference;
      // New references bind the verified, AS-owned client_id to one durable grant.
      // Explicit historic JWTs have no grant-reference claim and retain their existing format.
      if (referenceId !== undefined && typeof referenceId !== 'string') throw new Error('Invalid grant');
      dispatch = await db.transaction(async (tx) => {
        const grant = await createAgentConnectionStore(tx).grantForMcp(ownerUserId,
          typeof referenceId === 'string' ? referenceId : connectionId);
        if (!grant || grant.connection.id !== connectionId || grant.clientId !== null && grant.clientId !== token.client_id)
          throw new Error('Invalid grant');
        const policy = await lockAgentMcpPolicy(tx, connectionId);
        if (!policy) throw new Error('Policy unavailable');
        return createMcpDispatch(policy.version);
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    const cursorSecret = (await auth.$context).secret;
    const handler = createMcpHandler(() => createFluxMcpServer(db, { ownerUserId, connectionId, scopes, dispatch,
      clientId: typeof token.client_id === 'string' ? token.client_id : null,
      grantReferenceId: typeof token.flux_grant_reference === 'string' ? token.flux_grant_reference : null,
    }, cursorSecret), { legacy: 'reject' });
    return handler.fetch(request);
  };
  // The public origin can be a host-only loopback URL in Compose and is not
  // necessarily reachable from the API container. Fetch our own JWKS on the
  // bound loopback port while verifying the token's public issuer and audience.
  let protectedFetch: ReturnType<typeof requireMcpAuth> | undefined;
  const node = toNodeHandler({ fetch: (request: Request) => {
    if (!protectedFetch) {
      const address = app.server.address();
      // app.inject() has no bound socket; unauthenticated route tests still
      // need a challenge and never fetch JWKS.
      const port = address && typeof address !== 'string' ? address.port : Number(process.env.PORT ?? 8080);
      protectedFetch = requireMcpAuth(auth, handleVerified, {
        resource: `${publicOrigin}/mcp`,
        jwksUrl: `http://127.0.0.1:${port}/api/auth/jwks`,
      });
    }
    return protectedFetch(request);
  } }, { onerror: (error) => app.log.error({ error }, 'MCP request failed') });
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: async (request, reply) => {
    reply.hijack();
    await node(request.raw, reply.raw, request.body);
  } });
}
