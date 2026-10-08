import type { FastifyInstance } from 'fastify';
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Database } from '@flux/core';
import type { FluxAuth } from '../identity/auth.js';
import { createFluxMcpServer } from './mcp-tools.js';
import { signInAgainMessage, type IdpStanding } from '../identity/standing.js';
import { createAgentConnectionStore } from './store.js';

/** The only remote MCP entry point. A new tool server is bound to each verified bearer request. */
export function registerMcpRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string,
  standing: { checker: Pick<IdpStanding, 'stands'>; label: string } | null = null) {
  const connections = createAgentConnectionStore(db);
  const handleVerified = async (request: Request, token: Record<string, unknown>) => {
    const ownerUserId = token.flux_owner_user_id;
    const connectionId = token.flux_connection_id;
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
    if (typeof ownerUserId !== 'string' || typeof connectionId !== 'string' || token.sub !== ownerUserId) {
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    // The owner's account must still stand at the identity provider, whatever the bearer (S4, #311). This reads
    // the stored state, so an outage at the provider adds no latency here. Nothing is revoked: the grant stays.
    if (standing && !await standing.checker.stands(ownerUserId)) {
      const description = signInAgainMessage(standing.label);
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: description }, id: null }), { status: 401, headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'www-authenticate': `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${description}"`,
      } });
    }
    // A signed JWT remains valid until expiry, so revocation must be checked
    // against the live connection before even listing tools.
    try {
      const referenceId = token.flux_grant_reference;
      // New references bind the verified, AS-owned client_id to one durable grant.
      // Explicit historic JWTs have no grant-reference claim and retain their existing format.
      if (referenceId !== undefined) {
        if (typeof referenceId !== 'string') throw new Error('Invalid grant');
        const grant = await connections.grantForOauth(ownerUserId, referenceId);
        if (!grant || grant.connection.id !== connectionId || grant.clientId !== null && grant.clientId !== token.client_id)
          throw new Error('Invalid grant');
      } else if (!await connections.resolve(ownerUserId, connectionId)) throw new Error('Connection revoked');
    } catch {
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    const cursorSecret = (await auth.$context).secret;
    const handler = createMcpHandler(() => createFluxMcpServer(db, { ownerUserId, connectionId, scopes,
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
