import { TASK_TAKING_PATH, taskAgentPath, taskAgentRetryPath, taskAgentStopPath, taskPeoplePath, type SetTaskTaking, type TaskAgentState, type TaskPeople, type TaskTaking } from '@flux/contracts';
import { request } from '../api/client';

// People's agents take tasks (#856, F-036 AG-5): the one setting, the agents a task can be given to, and an agent's state on a task.

export const getTaskTaking = (signal?: AbortSignal) => request<TaskTaking>(TASK_TAKING_PATH, { signal });
export const setTaskTaking = (agentId: string | null) => request<TaskTaking>(TASK_TAKING_PATH, { method: 'PUT', body: { agentId } satisfies SetTaskTaking });
export const getTaskAgentState = (workId: string, signal?: AbortSignal) => request<TaskAgentState>(taskAgentPath(workId), { signal });
export const stopTaskAgent = (workId: string) => request<{ ok: true }>(taskAgentStopPath(workId), { method: 'POST', body: {} });
export const retryTaskAgent = (workId: string) => request<{ ok: true }>(taskAgentRetryPath(workId), { method: 'POST', body: {} });

/** The agents the Owner field offers: your own agents that run on the server (#904). A failed read offers none. */
export const ownTaskAgents = (signal?: AbortSignal) => getTaskTaking(signal).then((taking) => taking.agents, () => [] as TaskTaking['agents']);

export const getTaskPeople = (workId: string, signal?: AbortSignal) => request<TaskPeople>(taskPeoplePath(workId), { signal });
