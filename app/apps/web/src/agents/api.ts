import { projectAgentsPath, taskDiscussionPath, type ConversationMessage, type ProjectAgents, type TaskContributionCommand, type TaskDiscussion } from '@flux/contracts';
import { request } from '../api/client';

/** The Agents view of a project (UI116-2, #136): current connections and the canonical task threads. */
export const getProjectAgents = (projectId: string, signal?: AbortSignal) => request<ProjectAgents>(projectAgentsPath(projectId), { signal });
/** The latest window of a task's thread, or the one before `beforeSequence`. */
export const getTaskDiscussion = (workId: string, signal?: AbortSignal, beforeSequence?: number) =>
  request<TaskDiscussion>(`${taskDiscussionPath(workId)}${beforeSequence ? `?beforeSequence=${beforeSequence}` : ''}`, { signal });
/** A contribution to the task's one thread; the caller reuses `clientMessageId` when retrying the same text. */
export const contributeToTask = (workId: string, command: TaskContributionCommand) =>
  request<ConversationMessage>(taskDiscussionPath(workId), { method: 'POST', body: command });
