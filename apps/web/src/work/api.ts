import {
  decisionAcceptPath, decisionPath, projectDecisionsPath, projectResultsPath, projectWorkPath, resultPath, workItemPath, workspaceAssignedWorkPath,
  type AcceptDecisionCommand, type CreateResultCommand, type CreateWorkCommand, type Decision, type Page, type ProposeDecisionCommand,
  type UpdateWorkCommand, type WorkItem, type WorkResult, type Agent,
} from '@flux/contracts';
import { request } from '../api/client';

/** Work, decisions and results of one project (#101); the project's audience is theirs. */
export interface ProjectWork { work: WorkItem[]; decisions: Decision[]; results: WorkResult[] }

const LIMIT = 100;
export async function loadProjectWork(projectId: string, signal?: AbortSignal): Promise<ProjectWork> {
  const [work, decisions, results] = await Promise.all([
    request<Page<WorkItem>>(`${projectWorkPath(projectId)}?limit=${LIMIT}`, { signal }),
    request<Page<Decision>>(`${projectDecisionsPath(projectId)}?limit=${LIMIT}`, { signal }),
    request<Page<WorkResult>>(`${projectResultsPath(projectId)}?limit=${LIMIT}`, { signal }),
  ]);
  return { work: work.items, decisions: decisions.items, results: results.items };
}

const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });

export const getWork = (id: string, signal?: AbortSignal) => request<WorkItem>(workItemPath(id), { signal });
export const getDecision = (id: string, signal?: AbortSignal) => request<Decision>(decisionPath(id), { signal });
export const getResult = (id: string, signal?: AbortSignal) => request<WorkResult>(resultPath(id), { signal });
/** Create commands carry an Idempotency-Key that the caller reuses when retrying the same submission. */
export const createWork = (projectId: string, command: CreateWorkCommand, idempotencyKey: string) =>
  request<WorkItem>(projectWorkPath(projectId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const updateWork = (item: WorkItem, command: UpdateWorkCommand) =>
  request<WorkItem>(workItemPath(item.id), { method: 'PATCH', body: command, headers: ifMatch(item.version) });
export const proposeDecision = (projectId: string, command: ProposeDecisionCommand, idempotencyKey: string) =>
  request<Decision>(projectDecisionsPath(projectId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const acceptDecision = (decision: Decision, command: AcceptDecisionCommand, idempotencyKey: string) =>
  request<Decision>(decisionAcceptPath(decision.id), { method: 'POST', body: command, headers: { ...ifMatch(decision.version), ...key(idempotencyKey) } });
export const createResult = (projectId: string, command: CreateResultCommand, idempotencyKey: string) =>
  request<WorkResult>(projectResultsPath(projectId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const listAssignedWork = (workspaceId: string, signal?: AbortSignal) =>
  request<Page<WorkItem>>(`${workspaceAssignedWorkPath(workspaceId)}?limit=${LIMIT}`, { signal });
export const listAgents = (workspaceId: string, signal?: AbortSignal) => request<Agent[]>(`/api/v1/workspaces/${workspaceId}/agents`, { signal });
