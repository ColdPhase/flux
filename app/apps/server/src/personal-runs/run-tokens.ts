import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { aiModelSeesPictures, ATTACH_PICTURE_TOOL, assistantRunTools, PICTURE_RUN_KINDS, VIEW_PICTURE_TOOL, personalRunTokenPath, RUN_TOKEN_LIMITS, type PersonalRunTokenGrant } from '@flux/contracts';
import { personalRunTokenRows, spaceAi, type Database } from '@flux/db';
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
// no scope (the run's exact tools are stored with its mint and listed by the route, A3), `flux_run_id`,
// `flux_place` = the run's project and conversation (or its direct message; none for a private chat), audience the Flux MCP resource, lifetime no longer
// than the run's clock.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_TOKEN_AUTHORIZED_PARTY = 'flux-personal-run';
/** A run in a direct message: reading a web page, and finding, reading around and summarising the messages of that direct message (F-042, #1290, #1292). Sorted, as every run's tools are. */
const DM_RUN_TOOLS = ['flux_read_around', 'flux_read_web', 'flux_search', 'flux_summarize'];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerPersonalRunTokenRoute(app: FastifyInstance, db: Database, auth: FluxAuth, publicOrigin: string) {
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
      if (!run || (run.status !== 'reading' && run.status !== 'dispatching') || run.stopRequestedAt || run.runTokenJti || !run.runTokenNonceHash
        || !sameHash(sha256(request.body.nonce), run.runTokenNonceHash)) return null;
      // AG-10, first: before anything is minted, AI must be on in the run's space at the run's epoch (a run in a DM or a chat has no space).
      if (run.projectId !== null) {
        const ai = await spaceAi(tx, run.projectId, { lock: true });
        if (ai.state !== 'allowed' || ai.epoch !== run.aiEpoch) return null;
      }
      const connectionId = await rows.assistantConnectionId(run.ownerUserId, run.agentId);
      if (!connectionId) return null;
      // The live connection and its owner's standing, exactly as the MCP route checks them. A read-only run token needs read
      // access only: the assistant reaches what its owner can (F-036 AG-3).
      const grant = await createAgentConnectionStore(tx).grantForRun(run.ownerUserId, connectionId);
      if (!grant || grant.connection.id !== connectionId || grant.connection.agentId !== run.agentId || grant.connection.computeSource !== 'owner_assistant') return null;
      // The run's exact tools: reads, and the changes unless its "What it may do" is Only read (F-036 AG-3).
      // An answer to another agent's question only reads, whatever the agent may do (TA-3: a question is not an instruction).
      // A private chat reads and answers and changes nothing (#842); a run in a direct message has one tool: reading a web page, since no
      // tool reads a DM and nothing of the owner's other places may reach an answer its audience reads. It finds older messages of that DM
      // with the two tools that find and read around a message, which reach that DM alone (F-042, #1290).
      const readOnly = grant.connection.mayDo === 'read' || run.kind === 'task_answer' || run.projectId === null;
      // A picture goes only on an answer to `/ai` in a space (#1217, C-59): its asker's card, its change line and Undo, and their Show everyone.
      const tools = run.dmId !== null ? DM_RUN_TOOLS : assistantRunTools(readOnly ? 'read' : grant.connection.mayDo)
        .filter((tool) => tool !== ATTACH_PICTURE_TOOL || (run.projectId !== null && PICTURE_RUN_KINDS.has(run.kind)))
        // A file the run made or wrote (#1437) goes on the same answers, and not (yet) on the private chat's.
        .filter((tool) => tool !== 'flux_attach_file' || (run.projectId !== null && PICTURE_RUN_KINDS.has(run.kind)))
        // …and on its answer in the agent's private chat (founder decision on #1217, 2026-11-12): read-only as it is, the chat's answer to its
        // owner can show a picture. A schedule's report cannot.
        .concat(run.projectId === null && run.dmId === null && run.kind === 'ask' ? [ATTACH_PICTURE_TOOL] : [])
        // A picture goes to the model only when it sees pictures (#1217): otherwise it is told it sees only the names of attached files.
        .filter((tool) => tool !== VIEW_PICTURE_TOOL || aiModelSeesPictures(run.provider, run.model, run.engine));
      const jti = randomUUID();
      const expiresAt = new Date(Date.now() + RUN_TOKEN_LIMITS.lifetimeSeconds * 1000);
      await rows.recordMint(runId, { jti, expiresAt, tools });
      return { run, connectionId, tools, jti, expiresAt };
    });
    if (!minted) return refuse();
    const { baseURL } = await auth.$context;
    const { token } = await auth.api.signJWT({ body: { payload: {
      sub: minted.run.ownerUserId, flux_owner_user_id: minted.run.ownerUserId, flux_connection_id: minted.connectionId,
      flux_run_id: minted.run.id, flux_place: { project: minted.run.projectId, conversation: minted.run.conversationId, dm: minted.run.dmId },
      jti: minted.jti, iat: Math.floor(Date.now() / 1000), exp: Math.floor(minted.expiresAt.getTime() / 1000),
      // The MCP resource server requires an `azp` (the party the token was issued to) since Better Auth 1.7.18. A run token has no
      // OAuth client, so it names its issuer's own flow; no client of that id exists, so nothing else accepts it as a client's.
      azp: RUN_TOKEN_AUTHORIZED_PARTY,
      iss: baseURL ?? `${publicOrigin}/api/auth`, aud: `${publicOrigin}/mcp`,
    } } });
    const grant: PersonalRunTokenGrant = { token, tools: minted.tools, expiresAt: minted.expiresAt.toISOString() };
    return reply.header('cache-control', 'no-store').send(grant);
  });
}
