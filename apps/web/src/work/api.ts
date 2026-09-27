import {
  decisionAcceptPath, decisionPath, projectDecisionsPath, projectResultsPath, projectWorkPath, resultPath, workItemPath,
  type AcceptDecisionCommand, type CreateResultCommand, type CreateWorkCommand, type Decision, type Page, type ProposeDecisionCommand,
  type UpdateWorkCommand, type WorkItem, type WorkResult, type Agent,
} from '@flux/contracts';
import { request } from '../api/client';

/** Work, decisions and results of one project (#101); the project's audience is theirs. */
export interface ProjectWork { work: WorkItem[]; decisions: Decision[]; results: WorkResult[] }

const LIMIT = 100;

/**
 * Every record of a list, page by page until `total`. The state line, the Tasks tab and the
 * objects under each message need the whole set; a record added while paging shifts the pages,
 * so items are de-duplicated by id and paging stops at the server's offset limit.
 */
async function everything<T extends { id: string }>(path: string, signal?: AbortSignal): Promise<T[]> {
  const byId = new Map<string, T>();
  for (let offset = 0; offset <= 10_000; offset += LIMIT) {
    const page = await request<Page<T>>(`${path}?limit=${LIMIT}&offset=${offset}`, { signal });
    for (const item of page.items) if (!byId.has(item.id)) byId.set(item.id, item);
    if (!page.items.length || offset + page.items.length >= page.total) break;
  }
  return [...byId.values()];
}

export async function loadProjectWork(projectId: string, signal?: AbortSignal): Promise<ProjectWork> {
  const [work, decisions, results] = await Promise.all([
    everything<WorkItem>(projectWorkPath(projectId), signal),
    everything<Decision>(projectDecisionsPath(projectId), signal),
    everything<WorkResult>(projectResultsPath(projectId), signal),
  ]);
  return { work, decisions, results };
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
export const listAgents = (workspaceId: string, signal?: AbortSignal) => request<Agent[]>(`/api/v1/workspaces/${workspaceId}/agents`, { signal });
