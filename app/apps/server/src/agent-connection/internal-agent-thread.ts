import { requireMcpAuth } from '@better-auth/mcp';
import { z } from 'zod';
import { agentExecutionUseCases, derivedUuid, DomainError, normalizeMessage, type Database } from '@flux/core';
import type { AgentExecutionCommand, AgentJsonValue } from '@flux/contracts';
import type { FluxAuth } from '../identity/auth.js';
import { guardedAgentThreadInEventSession } from '../conversation/store.js';
import { transactionEventSession } from '../work/transaction-events.js';
import { actionId, actionInput, actionVersion } from './action-execution.js';
import { agentExecutionInTransaction } from './execution.js';

const input = z.strictObject({ ...actionInput(['execute', 'plan']), taskId: actionId,
  message: z.strictObject({ body: z.string().min(1).max(100_000),
    cite: z.strictObject({ materialId: actionId, version: actionVersion }).optional() }) });

/** CLOSED internal verification composition; intentionally absent from every HTTP/MCP registry.
 * Authentication uses the same real AS bearer verifier as /mcp, never a fabricated principal/context.
 * This server-selected task mode cannot be supplied in the strict command body.
 */
export function internalAgentThreadWriter(db: Database, auth: FluxAuth, publicOrigin: string, jwksUrl: string) {
  return requireMcpAuth(auth, async (request, token) => {
    const ownerUserId = token.flux_owner_user_id, connectionId = token.flux_connection_id;
    if (typeof ownerUserId !== 'string' || typeof connectionId !== 'string' || token.sub !== ownerUserId
      || typeof token.client_id !== 'string' || typeof token.flux_grant_reference !== 'string')
      throw new DomainError(403, 'AGENT_EXECUTION_UNAVAILABLE', 'Current agent bearer is unavailable');
    const parsed = input.parse(await request.json());
    const claims = { ownerUserId, connectionId, clientId: token.client_id, grantReferenceId: token.flux_grant_reference,
      scopes: typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [] };
    const command: AgentExecutionCommand = { runtimeSessionId: parsed.runtimeSessionId, grantId: parsed.grantId,
      clientCommandId: parsed.clientCommandId, projectId: parsed.projectId, operation: 'conversation.reply',
      peerRequestClass: parsed.peerRequestClass, audience: { kind: 'project', projectId: parsed.projectId },
      objectId: parsed.taskId, sources: parsed.sources, payload: parsed.message as AgentJsonValue };
    try {
      const result = await db.transaction(async (tx) => {
        const session = transactionEventSession(tx); let replayed = false;
        const value = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims, {}, 'task-agent-thread/v1'))
          .run(command, async (scope) => {
            if (scope.replay) { replayed = true; return { value: scope.replay.value, postconditions: scope.replay.postconditions }; }
            const normalized = normalizeMessage({ body: parsed.message.body,
              clientMessageId: derivedUuid('flux.agent-thread-message.v1', scope.context.connectionId, parsed.clientCommandId),
              ...(parsed.message.cite ? { source: parsed.message.cite } : {}) });
            const sent = await guardedAgentThreadInEventSession(tx, session, scope.context, parsed, parsed.taskId,
              { ...normalized, projectId: parsed.projectId });
            return { value: { taskId: parsed.taskId, conversationId: sent.conversationId, messageId: sent.id, sequence: sent.sequence },
              postconditions: [{ kind: 'message' as const, id: sent.id }] };
          });
        await session.flushEvents(); return { ...(value as Record<string, AgentJsonValue>), replayed };
      });
      return Response.json(result);
    } catch (error) {
      let cause: unknown = error;
      while (cause && typeof cause === 'object') {
        if ('constraint' in cause && cause.constraint === 'agent_thread_turn_limit')
          throw new DomainError(409, 'AGENT_THREAD_TURN_LIMIT', 'Five agent messages require a new authoritative work boundary');
        cause = 'cause' in cause ? cause.cause : null;
      }
      throw error;
    }
  }, { resource: `${publicOrigin}/mcp`, jwksUrl });
}
