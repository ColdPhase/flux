import { taskAgentPath, taskAgentRetryPath, taskAgentStopPath, taskPeoplePath, type TaskAgentState, type TaskPeople } from '@flux/contracts';
import { request } from '../api/client';

// People's agents take tasks (#856, F-036 AG-5): an agent's state on a task, Stop and Try again, and the task's people.

export const getTaskAgentState = (workId: string, signal?: AbortSignal) => request<TaskAgentState>(taskAgentPath(workId), { signal });
export const stopTaskAgent = (workId: string) => request<{ ok: true }>(taskAgentStopPath(workId), { method: 'POST', body: {} });
export const retryTaskAgent = (workId: string) => request<{ ok: true }>(taskAgentRetryPath(workId), { method: 'POST', body: {} });

export const getTaskPeople = (workId: string, signal?: AbortSignal) => request<TaskPeople>(taskPeoplePath(workId), { signal });
