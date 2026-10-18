import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { assistantRunScopes, assistantRunTools, personalRunTokenPath, RUN_TOKEN_LIMITS, type PersonalRunTokenGrant } from '@flux/contracts';
import { redactSecrets, type Database } from '@flux/core';
import { lockAgentMcpPolicy, personalRunTokenRows } from '@flux/db';
import type { FluxAuth } from '../identity/auth.js';
import { createAgentConnectionStore } from '../agent-connection/store.js';

// The run token's minting (F-022 "Agent connection and permissions", F-027 A2, #280/#484). The API is
// Flux's authorization server, so it signs the token with the same keys as every MCP access token; the
// worker asks for it. INTERNAL: the worker proves it holds the run with a one-time nonce whose SHA-256 it
// stored on the run row in its own transaction. One token per run, only while the run is in flight, for
// the owner's assistant connection in the run's workspace. The token itself is never stored or logged:
// the run keeps its id (`jti`), its expiry and the exact tools it was minted for.
//
// Claims: `sub` and `flux_owner_user_id` = the owner, `flux_connection_id` = the assistant connection,
// `scope` = the scopes the run's tools need (reads, and `flux.action.execute` with change tools, A3), `flux_run_id`,
// `flux_place` = the run's project and conversation, audience the Flux MCP resource, lifetime no longer
// than the run's clock.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerPersonalRunTokenRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string, githubFacts?: (ownerUserId: string, taskId: string, linkId?: string) => Promise<unknown>) {
  app.post<{ Params: { runId: string }; Body: { nonce: string } }>(personalRunTokenPath(':runId'), {
    schema: { body: { type: 'object', required: ['nonce'], additionalProperties: false, properties: { nonce: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
  }, async (request, reply) => {
    const runId = request.params.runId.toLowerCase();
    // One answer for every refusal: nothing tells a caller which run exists or why it was refused.
    const refuse = () => reply.code(404).header('cache-control', 'no-store').send({ code: 'RUN_TOKEN_UNAVAILABLE', error: 'No run token is available' });
    if (!UUID.test(runId)) return refuse();
    const minted = await db.transaction(async (tx) => {
      const rows = personalRunTokenRows(tx);
      const run = await rows.find(runId, { lock: 'update' });
      if (!run || run.reactionActive === false || (run.status !== 'reading' && run.status !== 'dispatching') || run.stopRequestedAt || run.runTokenJti || !run.runTokenNonceHash
        || !sameHash(sha256(request.body.nonce), run.runTokenNonceHash)) return null;
      const connectionId = await rows.assistantConnectionId(run.ownerUserId, run.workspaceId);
      if (!connectionId) return null;
      // The live connection, its owner's standing and its current selection, exactly as the MCP route checks them.
      // A read-only run token needs read access to a selected project, not write (an assistant a manager let only read).
      const grant = await createAgentConnectionStore(tx).grantForRun(run.ownerUserId, connectionId);
      if (!grant || grant.connection.id !== connectionId || grant.connection.agentId !== run.agentId || grant.connection.computeSource !== 'owner_assistant') return null;
      const policy = await lockAgentMcpPolicy(tx, connectionId);
      if (!policy) return null;
      // The run's exact tools from the owner's switches (F-027 AST-4): reads, and changes of areas switched to edit (A3).
      const readOnly = run.reactionAction && ['tell', 'draft_reply', 'check_task'].includes(run.reactionAction);
      const tools = assistantRunTools(policy, readOnly ? ['flux.context.read'] : grant.connection.scopes);
      let context: string | undefined;
      if (run.reactionTaskId) {
        if (!githubFacts) return null;
        try {
          const text = redactSecrets(JSON.stringify(await githubFacts(run.ownerUserId, run.reactionTaskId, run.reactionLinkId ?? undefined))).text;
          if (Buffer.byteLength(text, 'utf8') > 16000) return null;
          context = `<github-facts-data>\n${text}\n</github-facts-data>`;
        } catch { return null; }
      }
      const jti = randomUUID();
      const expiresAt = new Date(Date.now() + RUN_TOKEN_LIMITS.lifetimeSeconds * 1000);
      await rows.recordMint(runId, { jti, expiresAt, tools });
      return { run, connectionId, tools, jti, expiresAt, context };
    });
    if (!minted) return refuse();
    const { baseURL } = await auth.$context;
    const { token } = await auth.api.signJWT({ body: { payload: {
      sub: minted.run.ownerUserId, flux_owner_user_id: minted.run.ownerUserId, flux_connection_id: minted.connectionId,
      scope: assistantRunScopes(minted.tools).join(' '), flux_run_id: minted.run.id, flux_place: { project: minted.run.projectId, conversation: minted.run.conversationId },
      jti: minted.jti, iat: Math.floor(Date.now() / 1000), exp: Math.floor(minted.expiresAt.getTime() / 1000),
      iss: baseURL ?? `${publicOrigin}/api/auth`, aud: `${publicOrigin}/mcp`,
    } } });
    const grant: PersonalRunTokenGrant = { token, tools: minted.tools, expiresAt: minted.expiresAt.toISOString(), ...(minted.context ? { context: minted.context } : {}) };
    return reply.header('cache-control', 'no-store').send(grant);
  });
}
