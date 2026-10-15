import { and, eq, sql } from 'drizzle-orm';
import type { AuthenticatedAgentRuntime } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import type { TaskUseFence } from './task-use.js';

/** Closed internal native adapter only. No authorization, commits, reset flags or public registration. */
export function agentThreadGuardRows(tx: DbExecutor) {
  return {
    async thread(taskId: string, within: { workspaceId: string; projectId: string }) {
      const [row] = await tx.select().from(schema.projectConversations).where(and(eq(schema.projectConversations.workId, taskId),
        eq(schema.projectConversations.space, 'agents'), eq(schema.projectConversations.workspaceId, within.workspaceId),
        eq(schema.projectConversations.projectId, within.projectId)));
      return row ?? null;
    },
    async containsMessage(taskId: string, messageId: string, within: { workspaceId: string; projectId: string }) {
      const [row] = await tx.select({ id: schema.projectMessages.id }).from(schema.projectMessages)
        .innerJoin(schema.projectConversations, eq(schema.projectMessages.conversationId, schema.projectConversations.id))
        .where(and(eq(schema.projectMessages.id, messageId), eq(schema.projectMessages.workspaceId, within.workspaceId),
          eq(schema.projectMessages.projectId, within.projectId), eq(schema.projectConversations.workspaceId, within.workspaceId),
          eq(schema.projectConversations.projectId, within.projectId), eq(schema.projectConversations.workId, taskId),
          eq(schema.projectConversations.space, 'agents'))).for('share');
      return !!row;
    },
    async debit(fence: TaskUseFence, task: { id: string; workspaceId: string; projectId: string }, conversationId: string,
      messageId: string, runtime: AuthenticatedAgentRuntime, command: { clientCommandId: string; grantId: string }) {
      if (!fence.ids.includes(task.id) || !fence.projectIds.includes(task.projectId)) throw new Error('Native turn is outside the retained task fence');
      await tx.execute(sql`INSERT INTO agent_thread_guard_events(workspace_id, project_id, task_id, conversation_id,
        message_id, kind, turn_count, author_agent_id, connection_id, client_command_id, runtime_session_id, grant_id, transaction_id)
        VALUES(${task.workspaceId},${task.projectId},${task.id},${conversationId},${messageId},'agent_message',0,
          ${runtime.agentId},${runtime.connectionId},${command.clientCommandId},${runtime.id},${command.grantId},txid_current())`);
    },
  };
}
