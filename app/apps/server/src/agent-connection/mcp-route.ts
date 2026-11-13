import type { FastifyInstance } from 'fastify';
import { requireMcpAuth } from '@better-auth/mcp';
import { enforce, evaluateProject, isUuid, requireSpaceAi, SpaceAiOffError } from '@flux/core';
import { agentConnectionWorkspaceId, loadActor, accessReader, schema, type Database, type QueryVectors, type Transaction } from '@flux/db';
import { and, eq } from 'drizzle-orm';
import type { FluxAuth } from '../identity/auth.js';
import type { Confirmation } from '../identity/confirmation.js';
import { createFluxMcpTools, type FluxMcpTools } from './mcp-tools.js';
import type { WebReader } from '../web-reads/reader.js';
import type { KeyWebSearcher } from './web-search.js';
import type { Provider as GithubActionProvider } from '../github/adapters.js';
import { signInAgainMessage, type IdpStanding } from '../identity/standing.js';
import { createAgentConnectionStore } from './store.js';
import { createMcpDispatch } from './mcp-dispatch.js';
import { createMcpRelay, fenceResponse } from './mcp-relay.js';
import { createFluxMcpHandler } from './mcp-protocol.js';
import { requireLiveRun, runTokenClaims, type RunTokenClaims } from './run-token.js';

/**
 * AG-10: a request bound to a space, or a run's token, gets this refusal while AI is off in that space, before any tool,
 * resource or prompt. It is a JSON-RPC error on HTTP 200, not 401/403: real clients read 401/403 from /mcp as a lost sign-in and
 * drop the connection's tokens (observed with Claude Code, 2026-10-23), so after AI is turned on again the person would have to
 * connect again. The connection is not lost; it is only refused while AI is off in that space. Every other tool call is checked
 * against the space it names.
 */
async function aiBlockedResponse(request: Request): Promise<Response> {
  const id = await request.clone().json().then((body: { id?: unknown }) => (typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null))
    .catch(() => null);
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'AI is off in this space',
    data: { code: 'SPACE_AI_OFF' } }, id }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/**
 * The only remote MCP entry point. A new server is bound to each verified bearer request; the tool definitions it offers are built once
 * for the process, when the first request needs them.
 */
export function registerMcpRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string, testDeliveryGate = false,
  standing: { checker: Pick<IdpStanding, 'stands'>; label: string } | null = null, confirmation?: Confirmation, label = 'your identity provider',
  github: GithubActionProvider | null = null, webReader: WebReader | null = null, vectors?: QueryVectors, searcher: KeyWebSearcher | null = null) {
  let mcpTools: Promise<FluxMcpTools> | undefined;
  const tools = () => mcpTools ??= Promise.resolve().then(() => createFluxMcpTools(db, github, webReader, vectors, searcher));
  const handleVerified = async (request: Request, token: Record<string, unknown>) => {
    const ownerUserId = token.flux_owner_user_id;
    const connectionId = token.flux_connection_id;
    const runClaims = runTokenClaims(token);
    const params = new URL(request.url).searchParams;
    const connections = params.getAll('flux_connection'), projects = params.getAll('flux_project');
    const bound = connections.length || projects.length;
    const invalidBinding = bound && (connections.length !== 1 || projects.length !== 1 || !isUuid(connections[0]!)
      || !isUuid(projects[0]!) || connections[0]!.toLowerCase() !== connectionId);
    const boundProjectId = bound && !invalidBinding ? projects[0]!.toLowerCase() : undefined;
    if (typeof ownerUserId !== 'string' || typeof connectionId !== 'string' || token.sub !== ownerUserId || runClaims === 'invalid' || invalidBinding) {
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    // The owner's account must still stand at the identity provider, whatever the bearer (S4, #311), and the
    // provider's confirmation must be within FLUX_OIDC_CONFIRMATION_MAX_AGE (S2, #312). Both read stored state,
    // so an outage at the provider adds no latency here. Nothing is revoked: the grant stays, and a client
    // that authorizes again through the provider finds the connection it held chosen.
    const refused = !!standing && !await standing.checker.stands(ownerUserId) || !!await confirmation?.lapsed(ownerUserId);
    if (refused) {
      const description = signInAgainMessage(standing?.label ?? label);
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: description }, id: null }), { status: 401, headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'www-authenticate': `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${description}"`,
      } });
    }
    // A signed JWT remains valid until expiry, so revocation must be checked
    // against the live connection before even listing tools.
    const dispatch = createMcpDispatch();
    let run: RunTokenClaims | undefined;
    try {
      const referenceId = token.flux_grant_reference;
      // New references bind the verified, AS-owned client_id to one durable grant.
      if (referenceId !== undefined && typeof referenceId !== 'string') throw new Error('Invalid grant');
      await db.transaction(async (tx) => {
        const store = createAgentConnectionStore(tx);
        const grant = await (runClaims ? store.grantForRun : store.grantForOauth)(ownerUserId,
          typeof referenceId === 'string' ? referenceId : connectionId);
        if (!grant || grant.connection.id !== connectionId || grant.clientId !== null && grant.clientId !== token.client_id)
          throw new Error('Invalid grant');
        if (boundProjectId) {
          // The owner must be able to see the space at all before anything about it, even its AI switch, is said: a space that is not
          // theirs, or not there, is refused the same way (the client has its owner's rights and no more, #859).
          enforce(await evaluateProject({ kind: 'human', id: ownerUserId }, 'project.read', boundProjectId, accessReader(tx), { lock: true }), 'project');
          await requireSpaceAi(accessReader(tx), boundProjectId, { lock: true });
          const checked = enforce(await evaluateProject({ kind: 'agent', id: grant.connection.agentId }, 'project.read', boundProjectId, accessReader(tx), { lock: true }), 'project');
          if (checked.project!.workspaceId !== grant.connection.workspaceId) throw new Error('Bound project unavailable');
        }
        if (runClaims) {
          // A personal run's token (F-027 A2): its run is in flight under this token's id, and the route lists the run's tools. An owner
          // who sets Only read mid-run gets the plain words at the run's next change (the executor refuses it), not an unknown tool.
          const live = await requireLiveRun(tx, { ownerUserId, connectionId, run: runClaims }, { newCall: true, lock: true });
          run = { ...runClaims, tools: [...live.runTools] };
        }
      });
    } catch (error) {
      if (error instanceof SpaceAiOffError) return aiBlockedResponse(request);
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    const mcp = await tools();
    const handler = createFluxMcpHandler(() => mcp.server({ ownerUserId, connectionId, dispatch,
      clientId: typeof token.client_id === 'string' ? token.client_id : null,
      grantReferenceId: typeof token.flux_grant_reference === 'string' ? token.flux_grant_reference : null,
      ...(boundProjectId ? { boundProjectId } : {}),
      ...(run ? { run } : {}),
    }), run ? { refuseTool: (name: string) => !run!.tools.includes(name), noResources: true } : {});
    // Protected bytes are handed to the transport only while the connection and the owner's access still hold.
    const referenceId = typeof token.flux_grant_reference === 'string' ? token.flux_grant_reference : connectionId;
    const fence = { async check(tx: Transaction) {
      // AG-10, first: no byte, not even a tool list or a refusal, of a space-bound request after its AI is turned off.
      if (boundProjectId) await requireSpaceAi(accessReader(tx), boundProjectId, { lock: true });
      if (!await agentConnectionWorkspaceId(tx, connectionId, ownerUserId)) throw new Error('Connection unavailable');
      // Nothing more reaches a run token once its run ended, was stopped or its token closed.
      if (run) await requireLiveRun(tx, { ownerUserId, connectionId, run }, { newCall: false, lock: true });
      const store = createAgentConnectionStore(tx);
      const grant = await (run ? store.grantForRun : store.grantForOauth)(ownerUserId, referenceId);
      if (!grant || grant.connection.id !== connectionId || grant.clientId !== null && grant.clientId !== token.client_id)
        throw new Error('Connection unavailable');
      if (boundProjectId) {
        const checked = enforce(await evaluateProject({ kind: 'agent', id: grant.connection.agentId }, 'project.read', boundProjectId, accessReader(tx), { lock: true }), 'project');
        if (checked.project!.workspaceId !== grant.connection.workspaceId) throw new Error('Bound project unavailable');
      }
      const d = dispatch.dependencies;
      if (!d.protectedOutput) return;
      const actor = await loadActor({ kind: 'agent', id: grant.connection.agentId }, grant.connection.workspaceId, tx, { lock: true });
      if (!actor.active || actor.agent?.ownerUserId !== ownerUserId) throw new Error('Agent unavailable');
      for (const [projectId, action] of [...d.projects].sort(([a], [b]) => a.localeCompare(b))) {
        const checked = enforce(await evaluateProject({ kind: 'agent', id: grant.connection.agentId }, action, projectId, accessReader(tx), { lock: true }), 'project');
        if (checked.project!.workspaceId !== grant.connection.workspaceId) throw new Error('Project unavailable');
      }
      // A direct message's words (a run in it, #1290) go out only while its owner is still one of its people.
      for (const dmId of [...d.dms].sort()) {
        const [member] = await tx.select({ userId: schema.dmParticipants.userId }).from(schema.dmParticipants)
          .where(and(eq(schema.dmParticipants.dmId, dmId), eq(schema.dmParticipants.userId, ownerUserId))).for('share');
        if (!member) throw new Error('Direct message unavailable');
      }
    } };
    return fenceResponse(await handler.fetch(request), fence);
  };
  // The public origin can be a host-only loopback URL in Compose and is not
  // necessarily reachable from the API container. Fetch our own JWKS on the
  // bound loopback port while verifying the token's public issuer and audience.
  let protectedFetch: ReturnType<typeof requireMcpAuth> | undefined;
  const relay = createMcpRelay(db, { testGate: testDeliveryGate, onerror: (error) => app.log.error({ error }, 'MCP request failed') });
  const protectedHandle = (request: Request) => {
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
  };
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: async (request, reply) => {
    reply.hijack();
    // The bearer is accepted once the server answers it with anything but a 401: the API's request limit then gives it a budget of its own,
    // and a 401 takes it away again (#1022). The reply is hijacked, so no response hook of the limiter sees it.
    await relay(request.raw, reply.raw, request.body, async (webRequest) => {
      const response = await protectedHandle(webRequest);
      if (response.status === 401) request.refuseCredential?.();
      else request.acceptCredential?.({ bearer: true });
      return response;
    });
  } });
}
