import {
  decisionAcceptPath, decisionPath, projectDecisionsPath, projectLinksPath, projectResultsPath, projectWorkPath, resultPath, workItemPath, workspaceAssignedWorkPath,
  type AcceptDecisionCommand, type CreateObjectLinkCommand, type CreateResultCommand, type CreateWorkCommand, type Decision, type ObjectLink, type Page,
  type ProposeDecisionCommand, type UpdateWorkCommand, type WorkItem, type WorkResult, type Agent,
} from '@flux/contracts';
import { request } from '../api/client';
import { readAssignedAcross } from './assigned';

/** Work, decisions and results of one project (#101); the project's audience is theirs. */
export interface ProjectWork { work: WorkItem[]; decisions: Decision[]; results: WorkResult[] }

/**
 * Work the caller owns across these workspaces (#190 HOME-2): up to `cap` items in all, with the sum
 * of every workspace's total so a capped list can say how many it leaves out.
 */
export const listAssignedWork = (workspaceIds: string[], cap: number, signal?: AbortSignal) =>
  readAssignedAcross(workspaceIds, (workspaceId, limit, offset) =>
    request<Page<WorkItem>>(`${workspaceAssignedWorkPath(workspaceId)}?limit=${limit}&offset=${offset}`, { signal }), cap, signal);

const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });

export const getWork = (id: string, signal?: AbortSignal) => request<WorkItem>(workItemPath(id), { signal });
export const getDecision = (id: string, signal?: AbortSignal) => request<Decision>(decisionPath(id), { signal });
export const getResult = (id: string, signal?: AbortSignal) => request<WorkResult>(resultPath(id), { signal });
/** Create commands carry an Idempotency-Key that the caller reuses when retrying the same submission. */
export const createWork = (projectId: string, command: CreateWorkCommand, idempotencyKey: string) =>
  request<WorkItem>(projectWorkPath(projectId), { method: 'POST', body: { ...command, clientCommandId: command.clientCommandId ?? idempotencyKey }, headers: key(idempotencyKey) });
/** A change carries a stable command UUID that the caller reuses when it retries the same change (#154). */
export const updateWork = (item: Pick<WorkItem, 'id' | 'version'>, command: UpdateWorkCommand, clientCommandId: string) =>
  request<WorkItem>(workItemPath(item.id), { method: 'PATCH', body: { ...command, clientCommandId }, headers: ifMatch(item.version) });
export const proposeDecision = (projectId: string, command: ProposeDecisionCommand, idempotencyKey: string) =>
  request<Decision>(projectDecisionsPath(projectId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const acceptDecision = (decision: Pick<Decision, 'id' | 'version'>, command: AcceptDecisionCommand, idempotencyKey: string) =>
  request<Decision>(decisionAcceptPath(decision.id), { method: 'POST', body: command, headers: { ...ifMatch(decision.version), ...key(idempotencyKey) } });
/** Connects a task to another object of its project (#289: a task made first in Tasks, linked to a map thought). */
export const linkObjects = (projectId: string, command: CreateObjectLinkCommand, idempotencyKey: string) =>
  request<ObjectLink>(projectLinksPath(projectId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const createResult = (projectId: string, command: CreateResultCommand, idempotencyKey: string) =>
  request<WorkResult>(projectResultsPath(projectId), { method: 'POST', body: { ...command, clientCommandId: command.clientCommandId ?? idempotencyKey }, headers: key(idempotencyKey) });
export const listAgents = (workspaceId: string, signal?: AbortSignal) => request<Agent[]>(`/api/v1/workspaces/${workspaceId}/agents`, { signal });
