import { aiCompany, recordEvent } from '@flux/core';
import { dmAiRows } from '@flux/db';
import { eventPorts } from '../events.js';
import type { FluxAgentReadContext, FluxMcpClaims } from './context.js';

// The one question every agent read of a direct message asks (C-73, #1591, AG-4). A run in a direct message reads that one; a run of its
// owner's private chat (a request or a schedule there, whose answer only they read) reads any its owner is in; nothing else reads one: not a
// run in a space, a thread or a task, not a server agent's task, not a local client. And none reads a conversation whose AI any of its
// people turned off. The MCP route asks the same of every conversation a response was given words of before it hands the bytes over
// (`dispatch.dm`), and the run's checks and the model gateway ask it of the run, so a turn-off that commits meanwhile still stops it.

/** Whether this call may be given words of the direct message: its run's place, its owner's part in it and its AI, held until the call ends. */
export async function agentReachesDm(ctx: FluxAgentReadContext, claims: FluxMcpClaims, dmId: string): Promise<boolean> {
  const run = claims.run;
  if (!run) return false;
  if (run.dmId !== dmId && (run.dmId !== null || run.projectId !== null || !(await dmAiRows(ctx.tx).chatRun(run.id)))) return false;
  return dmAiRows(ctx.tx).readable(dmId, ctx.workspaceId, ctx.connection.ownerUserId);
}

/** Whether this call is a private chat's, whose search also covers its owner's direct messages (C-73). */
export async function chatReachesDms(ctx: FluxAgentReadContext, claims: FluxMcpClaims): Promise<boolean> {
  const run = claims.run;
  return !!run && run.dmId === null && run.projectId === null && !!(await dmAiRows(ctx.tx).chatRun(run.id));
}

/**
 * The direct message's words go to this call: a private chat's read leaves the AG-4 line there once for the run ("Hubert used AI here
 * (Claude)", to everyone in it), and the route checks the conversation again when it hands the bytes over.
 */
export async function givenDm(ctx: FluxAgentReadContext, claims: FluxMcpClaims, dmId: string): Promise<void> {
  const run = claims.run;
  if (run && run.dmId !== dmId) {
    const chat = await dmAiRows(ctx.tx).chatRun(run.id);
    if (chat && await dmAiRows(ctx.tx).postReadLine(chat, dmId, aiCompany(chat.engine, chat.provider))) {
      await recordEvent(eventPorts(ctx.tx), { kind: 'human', id: chat.ownerUserId }, chat.workspaceId, 'dm.changed.v1', dmId, { op: 'ai_used' });
    }
  }
  claims.dispatch?.dm(dmId);
}
