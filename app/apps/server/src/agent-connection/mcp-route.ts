import type { FastifyInstance } from 'fastify';
import { requireMcpAuth } from '@better-auth/mcp';
import type { AgentScope } from '@flux/contracts';
import { AGENT_MCP_ENTRIES, agentScopeRefusal, assistantRunTools } from '@flux/contracts';
import { enforce, evaluateProject, isUuid, requireAgentMcpEntry, requireWorkspaceAi, WorkspaceAiBlockedError, type Database, type Transaction } from '@flux/core';
import { agentConnectionWorkspaceId, lockAgentMcpPolicy, loadActor, workspaceAi, accessReader } from '@flux/db';
import type { FluxAuth } from '../identity/auth.js';
import type { Confirmation } from '../identity/confirmation.js';
import { createFluxMcpServer } from './mcp-tools.js';
import { signInAgainMessage, type IdpStanding } from '../identity/standing.js';
import { createAgentConnectionStore } from './store.js';
import { createMcpDispatch, type McpDispatch } from './mcp-dispatch.js';
import { createMcpRelay, fenceResponse } from './mcp-relay.js';
import { createFluxMcpHandler } from './mcp-protocol.js';
import { requireLiveRun, runTokenClaims, type RunTokenClaims } from './run-token.js';

/**
 * F-029: a connection of a workspace whose AI is off gets this refusal, before any tool, resource or prompt. It is a
 * JSON-RPC error on HTTP 200, not 401/403: real clients read 401/403 from /mcp as a lost sign-in and drop the connection's
 * tokens (observed with Claude Code, 2026-10-23), so after AI is turned on again the person would have to connect again.
 * The connection is not lost; it is only refused while AI is off.
 */
async function aiBlockedResponse(request: Request): Promise<Response> {
  const id = await request.clone().json().then((body: { id?: unknown }) => (typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null))
    .catch(() => null);
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'AI is turned off in this workspace',
    data: { code: 'WORKSPACE_AI_BLOCKED' } }, id }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** The only remote MCP entry point. A new tool server is bound to each verified bearer request. */
export function registerMcpRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string, testDeliveryGate = false,
  standing: { checker: Pick<IdpStanding, 'stands'>; label: string } | null = null, confirmation?: Confirmation, label = 'your identity provider') {
  const handleVerified = async (request: Request, token: Record<string, unknown>) => {
    const ownerUserId = token.flux_owner_user_id;
    const connectionId = token.flux_connection_id;
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
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
    // F-029: whatever the token, grant or role, nothing is served for a workspace whose AI is off.
    const blocked = await db.transaction(async (tx) => {
      const workspaceId = await agentConnectionWorkspaceId(tx, connectionId, ownerUserId);
      return workspaceId !== null && (await workspaceAi(tx, workspaceId, { lock: true })).state !== 'allowed';
    });
    if (blocked) return aiBlockedResponse(request);
    // A signed JWT remains valid until expiry, so revocation must be checked
    // against the live connection before even listing tools.
    let dispatch: McpDispatch;
    let run: RunTokenClaims | undefined;
    // Partial consent (#548): only what the token carries and the connection still grants.
    let granted: string[] = [];
    try {
      const referenceId = token.flux_grant_reference;
      // New references bind the verified, AS-owned client_id to one durable grant.
      // Explicit historic JWTs have no grant-reference claim and retain their existing format.
      if (referenceId !== undefined && typeof referenceId !== 'string') throw new Error('Invalid grant');
      dispatch = await db.transaction(async (tx) => {
        const store = createAgentConnectionStore(tx);
        const grant = await (runClaims ? store.grantForRun : store.grantForMcp)(ownerUserId,
          typeof referenceId === 'string' ? referenceId : connectionId);
        if (!grant || grant.connection.id !== connectionId || grant.clientId !== null && grant.clientId !== token.client_id)
          throw new Error('Invalid grant');
        await requireWorkspaceAi(accessReader(tx), grant.connection.workspaceId, { lock: true });
        const policy = await lockAgentMcpPolicy(tx, connectionId);
        if (!policy) throw new Error('Policy unavailable');
        if (boundProjectId && (!grant.connection.selectedProjectIds.includes(boundProjectId) || !policy.selectedProjectIds.includes(boundProjectId)))
          throw new Error('Bound project unavailable');
        if (boundProjectId) {
          const checked = enforce(await evaluateProject({ kind: 'agent', id: grant.connection.agentId }, 'project.read', boundProjectId, accessReader(tx), { lock: true }), 'project');
          if (checked.project!.workspaceId !== grant.connection.workspaceId) throw new Error('Bound project unavailable');
        }
        granted = scopes.filter((scope) => grant.connection.scopes.includes(scope as AgentScope));
        if (runClaims) {
          // A personal run's token (F-027 A2): its run is in flight under this token's id, and the route lists
          // exactly the run's tools that the owner's switches still allow (Off means off, AST-4).
          const live = await requireLiveRun(tx, { ownerUserId, connectionId, run: runClaims }, { newCall: true, lock: true });
          const allowed = new Set(assistantRunTools(policy, grant.connection.scopes.filter((scope) => scopes.includes(scope))));
          run = { ...runClaims, tools: live.runTools.filter((name) => allowed.has(name)) };
        }
        return createMcpDispatch(policy.version);
      });
    } catch (error) {
      if (error instanceof WorkspaceAiBlockedError) return aiBlockedResponse(request);
      return new Response(JSON.stringify({ error: 'Agent connection is unavailable' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    const cursorSecret = (await auth.$context).secret;
    const handler = createFluxMcpHandler(() => createFluxMcpServer(db, { ownerUserId, connectionId, scopes: granted, dispatch,
      clientId: typeof token.client_id === 'string' ? token.client_id : null,
      grantReferenceId: typeof token.flux_grant_reference === 'string' ? token.flux_grant_reference : null,
      ...(boundProjectId ? { boundProjectId } : {}),
      ...(run ? { run } : {}),
    }, cursorSecret), { refuseScope: (name) => agentScopeRefusal(name, granted), ...(run ? { refuseTool: (name: string) => !run!.tools.includes(name) } : {}) });
    // Protected bytes are handed to the transport only while the live policy and access still hold.
    const referenceId = typeof token.flux_grant_reference === 'string' ? token.flux_grant_reference : connectionId;
    const fence = { async check(tx: Transaction) {
      // F-029, first and unconditionally: no byte, not even a tool list or a refusal, after AI is turned off.
      const fencedWorkspace = await agentConnectionWorkspaceId(tx, connectionId, ownerUserId);
      if (!fencedWorkspace) throw new Error('Connection unavailable');
      await requireWorkspaceAi(accessReader(tx), fencedWorkspace, { lock: true });
      // Nothing more reaches a run token once its run ended, was stopped or its token closed.
      if (run) await requireLiveRun(tx, { ownerUserId, connectionId, run }, { newCall: false, lock: true });
      const store = createAgentConnectionStore(tx);
      const grant = await (run ? store.grantForRun : store.grantForMcp)(ownerUserId, referenceId);
      if (!grant || grant.connection.id !== connectionId || grant.clientId !== null && grant.clientId !== token.client_id)
        throw new Error('Connection unavailable');
      const policy = await lockAgentMcpPolicy(tx, connectionId);
      if (!policy) throw new Error('Policy unavailable');
      if (boundProjectId && (!grant.connection.selectedProjectIds.includes(boundProjectId) || !policy.selectedProjectIds.includes(boundProjectId)))
        throw new Error('Bound project unavailable');
      if (boundProjectId) {
        const checked = enforce(await evaluateProject({ kind: 'agent', id: grant.connection.agentId }, 'project.read', boundProjectId, accessReader(tx), { lock: true }), 'project');
        if (checked.project!.workspaceId !== grant.connection.workspaceId) throw new Error('Bound project unavailable');
      }
      const d = dispatch.dependencies;
      if (!d.protectedOutput || !d.admitted.size) return;
      if (policy.version !== d.capturedVersion) throw new Error('Policy changed');
      for (const id of d.admitted) {
        const entry = AGENT_MCP_ENTRIES.find((candidate) => candidate.id === id);
        if (!entry || !scopes.includes(entry.requiredScope) || !grant.connection.scopes.includes(entry.requiredScope))
          throw new Error('Scope unavailable');
        requireAgentMcpEntry(policy, d.capturedVersion, entry, d.sources);
      }
      const actor = await loadActor({ kind: 'agent', id: grant.connection.agentId }, grant.connection.workspaceId, tx, { lock: true });
      if (!actor.active || actor.agent?.ownerUserId !== ownerUserId) throw new Error('Agent unavailable');
      for (const [projectId, action] of [...d.projects].sort(([a], [b]) => a.localeCompare(b))) {
        if (!policy.selectedProjectIds.includes(projectId) || !grant.connection.selectedProjectIds.includes(projectId))
          throw new Error('Project unavailable');
        const checked = enforce(await evaluateProject({ kind: 'agent', id: grant.connection.agentId }, action, projectId, accessReader(tx), { lock: true }), 'project');
        if (checked.project!.workspaceId !== grant.connection.workspaceId) throw new Error('Project unavailable');
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
    await relay(request.raw, reply.raw, request.body, protectedHandle);
  } });
}
