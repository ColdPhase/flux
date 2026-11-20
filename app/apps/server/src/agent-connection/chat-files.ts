import { and, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { FluxAgentReadContext, FluxMcpClaims } from './context.js';

/** What of a stored file decides whether a run reaches it as a file of an agent's chat. */
export interface ChatFileFacts { workspaceId: string; agentId?: string | null; runId?: string | null; uploaderId: string | null }

/**
 * Whether this call reaches a file of an agent's private chat (#1438 point 10, C-64). Only a run of that chat reaches it: a run token whose
 * place is no space and no direct message, of the same agent and owner, while the file was sent by that owner with a request of that chat.
 * A run in a space or a direct message, a local client, another agent of the same owner and anyone else's agent reach none, and are told
 * the same "not there" as for a file that does not exist.
 */
export async function reachesChatFile(ctx: FluxAgentReadContext, claims: FluxMcpClaims, file: ChatFileFacts): Promise<boolean> {
  const run = claims.run;
  if (!run || run.projectId !== null || run.dmId !== null || !file.agentId || !file.runId) return false;
  if (file.workspaceId !== ctx.workspaceId || file.agentId !== ctx.connection.agentId || file.uploaderId !== ctx.connection.ownerUserId) return false;
  const r = schema.personalRuns;
  const row = async (id: string) => (await ctx.tx.select({ agentId: r.agentId, ownerUserId: r.ownerUserId, projectId: r.projectId, dmId: r.dmId })
    .from(r).where(eq(r.id, id)))[0];
  const inChat = (found: Awaited<ReturnType<typeof row>>) => !!found && found.agentId === file.agentId && found.ownerUserId === file.uploaderId
    && found.projectId === null && found.dmId === null;
  return inChat(await row(run.id)) && inChat(await row(file.runId));
}

/**
 * Whether this call reaches a file sent in a direct message (#1590, C-64 (3)): only a run in that conversation (`/ai` in it or in its thread), while the
 * run's owner is one of its people now, exactly as it reaches the conversation's messages (AG-4). A run in a space, the owner's private chat, another
 * conversation and a local client reach none, and are told the same "not there" as for a file that does not exist. The participant row is read
 * `FOR SHARE`, so a person removed at the same moment waits for this read to end.
 */
export async function reachesDmFile(ctx: FluxAgentReadContext, claims: FluxMcpClaims, file: { workspaceId: string; dmId: string }): Promise<boolean> {
  if (claims.run?.dmId !== file.dmId || file.workspaceId !== ctx.workspaceId) return false;
  const p = schema.dmParticipants;
  const [member] = await ctx.tx.select({ userId: p.userId }).from(p).where(and(eq(p.dmId, file.dmId), eq(p.userId, ctx.connection.ownerUserId))).for('share');
  return !!member;
}
