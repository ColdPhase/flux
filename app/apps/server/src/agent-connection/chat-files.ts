import { eq } from 'drizzle-orm';
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
