import type { TaskAgentThread, TaskDiscussion } from '@flux/contracts';
import { getTaskAgentThread } from '../composer/api';

/** The agents' thread of one task, read in the shape the thread view shares with a task discussion. */
export type AgentThreadView = TaskDiscussion & { canWrite: boolean; postingAvailable: boolean; task: TaskAgentThread['task']; messageCount: number };

/**
 * One bounded page of the thread. An absent thread is a real empty state (reading never creates it); the first
 * accepted post by a person creates it. All messages sit in `messages`: this thread has no separate root.
 */
export async function readAgentThread(workId: string, options: { limit?: number; beforeSequence?: number; signal?: AbortSignal } = {}): Promise<AgentThreadView> {
  const thread = await getTaskAgentThread(workId, { limit: options.limit ?? 50, beforeSequence: options.beforeSequence, signal: options.signal });
  const conversation = thread.conversation;
  return {
    workId, workspaceId: '', projectId: thread.task.projectId, conversationId: conversation?.id ?? null, rootMessageId: null, root: null,
    messages: conversation?.messages ?? [], messagePage: conversation?.messagePage ?? { hasMoreBefore: false, nextBeforeSequence: null, limit: options.limit ?? 50 },
    canWrite: thread.canWrite, postingAvailable: thread.postingAvailable, task: thread.task, messageCount: thread.messageCount,
  };
}
