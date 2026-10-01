import { createHash } from 'node:crypto';
import type { ObjectRef, PrincipalRef, WorkStatus } from '@flux/contracts';
import { ConflictError, NotFoundError, RuleViolationError } from '../access/errors.js';
import * as valid from './validation.js';

// The native task graph (#152): direct same-project prerequisites, bounded cycle detection, start
// eligibility and the immutable plan-intent decision. Pure rules over a small reader port; the SQL and
// the locks live in `@flux/db` (`taskGraphRows`) and are composed by `apps/server/src/work/task-graph.ts`,
// which exports the three transaction-bound primitives other tasks consume.
//
// Lock order for every writer, after the access/grant/command rows and any plan-material row:
// project graph locks (ascending project id) -> the complete task rows (ascending id) -> the rest.

/**
 * One safety bound for the graph: the most direct prerequisites a reader returns at once and the most
 * tasks a cycle check visits. Exceeding it is the visible 409 TASK_GRAPH_LIMIT, never a partial answer.
 */
export const TASK_GRAPH_LIMIT = 1_000;

export function taskGraphLimitError(): ConflictError {
  return new ConflictError(`The task dependency graph is larger than ${TASK_GRAPH_LIMIT} tasks; split the plan`, 'TASK_GRAPH_LIMIT');
}

export interface PrerequisiteState {
  id: string;
  /** Null when the prerequisite row is not in the task's workspace and project. */
  status: WorkStatus | null;
  parked: boolean;
}

/** The reads and the lock the graph rules need. `workRows`/`taskGraphRows` implement it. */
export interface TaskGraphReader {
  /** One transaction-scoped advisory lock per project; callers pass normalized ascending ids. */
  lockTaskGraphs(projectIds: readonly string[]): Promise<void>;
  /** Distinct ascending direct prerequisite ids of the tasks in this workspace, at most `limit` of them. */
  directPrerequisiteIds(workspaceId: string, taskIds: readonly string[], limit: number): Promise<string[]>;
  /** The task's project and its direct prerequisites as stored, or null when the task does not exist there. */
  prerequisiteStates(workspaceId: string, taskId: string): Promise<{ projectId: string; prerequisites: PrerequisiteState[] } | null>;
}

/** Lowercase, de-duplicated, ascending UUIDs: the one order every lock pass uses. */
export function sortedIds(values: readonly unknown[], label: string): string[] {
  return [...new Set(values.map((value, index) => valid.id(value, `${label}[${index}]`)))].sort();
}

/** Takes the project graph locks in ascending project order. Locks nothing else. */
export async function lockProjectGraphs(reader: Pick<TaskGraphReader, 'lockTaskGraphs'>, projectIds: readonly string[]): Promise<void> {
  const projects = sortedIds(projectIds, 'projectIds');
  if (projects.length > TASK_GRAPH_LIMIT) throw taskGraphLimitError();
  if (projects.length) await reader.lockTaskGraphs(projects);
}

/** Direct prerequisites of the tasks, distinct, ascending and bounded. Read-only: it locks nothing. */
export async function directPrerequisiteIds(reader: Pick<TaskGraphReader, 'directPrerequisiteIds'>, workspaceId: string, taskIds: readonly string[],
  limit = TASK_GRAPH_LIMIT): Promise<string[]> {
  const workspace = valid.id(workspaceId, 'workspaceId');
  const tasks = sortedIds(taskIds, 'taskIds');
  if (!tasks.length) return [];
  if (tasks.length > limit) throw taskGraphLimitError();
  const found = await reader.directPrerequisiteIds(workspace, tasks, limit + 1);
  if (found.length > limit) throw taskGraphLimitError();
  return found;
}

/**
 * Whether `taskId` depending on `prerequisiteIds` would close a cycle: it does when any prerequisite
 * already depends on the task, directly or through others. The walk follows existing edges level by
 * level and stops the moment the task is reached. It visits at most `limit` tasks.
 */
export async function assertNoDependencyCycle(reader: Pick<TaskGraphReader, 'directPrerequisiteIds'>, workspaceId: string, taskId: string,
  prerequisiteIds: readonly string[], limit = TASK_GRAPH_LIMIT): Promise<void> {
  const task = valid.id(taskId, 'taskId');
  const visited = new Set(sortedIds(prerequisiteIds, 'dependencyIds'));
  if (visited.has(task)) throw new RuleViolationError('A task cannot depend on itself', 'TASK_SELF_DEPENDENCY');
  if (visited.size > limit) throw taskGraphLimitError();
  let frontier = [...visited];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of await directPrerequisiteIds(reader, workspaceId, frontier, limit)) {
      if (id === task) throw new ConflictError('These prerequisites would make the task wait on itself', 'TASK_DEPENDENCY_CYCLE');
      if (visited.has(id)) continue;
      visited.add(id);
      if (visited.size > limit) throw taskGraphLimitError();
      next.push(id);
    }
    frontier = next;
  }
}

/** A prerequisite is met only when it exists in the task's project, is done and is not parked. */
export function unmetPrerequisites(prerequisites: readonly PrerequisiteState[]): PrerequisiteState[] {
  return prerequisites.filter((item) => item.status !== 'done' || item.parked);
}

/**
 * Runs after the caller holds the complete sorted task locks and acquires none itself: it reads the
 * locked current rows. Every direct prerequisite must be done and unparked; a missing, foreign, open,
 * blocked, in-progress, not-pursued or parked one is a visible 409 TASK_PREREQUISITES_UNMET.
 */
export async function assertPrerequisitesMet(reader: Pick<TaskGraphReader, 'prerequisiteStates'>, workspaceId: string, taskId: string): Promise<void> {
  const state = await reader.prerequisiteStates(valid.id(workspaceId, 'workspaceId'), valid.id(taskId, 'taskId'));
  if (!state) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
  const unmet = unmetPrerequisites(state.prerequisites);
  if (!unmet.length) return;
  const error = new ConflictError(`Finish its ${unmet.length === 1 ? 'prerequisite' : `${unmet.length} prerequisites`} first: it can start only when every prerequisite is done and not parked`,
    'TASK_PREREQUISITES_UNMET');
  error.details = { prerequisites: unmet.slice(0, 50).map((item) => ({ id: item.id, status: item.status, parked: item.parked })) };
  throw error;
}

/** Statuses that need every prerequisite met: the task has started or finished. */
export const ELIGIBLE_STATUSES: ReadonlySet<WorkStatus> = new Set<WorkStatus>(['in_progress', 'done']);

export interface PlanIntentRecord {
  taskId: string;
  fingerprint: string;
  /** The produced task's version when it was created; any later edit makes it stale. */
  taskVersion: number;
}

export type PlanIntentDecision = { kind: 'create' } | { kind: 'replay'; taskId: string };

/**
 * An earlier intent with the same canonical creation and an unchanged task is the same outcome. Another
 * canonical creation is a conflict, and a task edited (or removed) since is stale: neither becomes
 * another task or overwrites the first.
 */
export function decidePlanIntent(existing: PlanIntentRecord | null, fingerprint: string, task: { version: number } | null): PlanIntentDecision {
  if (!existing) return { kind: 'create' };
  if (existing.fingerprint !== fingerprint) {
    const error = new ConflictError('This plan intent already produced a different task', 'TASK_INTENT_CONFLICT');
    error.details = { taskId: existing.taskId };
    throw error;
  }
  if (!task || task.version !== existing.taskVersion) {
    const error = new ConflictError('The task this plan intent produced has been changed since; review it instead of creating another', 'TASK_INTENT_STALE');
    error.details = { taskId: existing.taskId };
    throw error;
  }
  return { kind: 'replay', taskId: existing.taskId };
}

const refKey = (ref: ObjectRef) => valid.refKey(ref);

/**
 * The normalized creation: references and prerequisites are sets, criteria keep their order, and the
 * retry identity and actor are not part of it. Two planners that decompose a plan into the same task
 * produce the same fingerprint.
 */
export function creationFingerprint(creation: { title: string; outcome: string; status: WorkStatus; blocker: string | null;
  owner: PrincipalRef | null; sources: ObjectRef[]; related: ObjectRef[]; criteria: string[]; dependencyIds: string[] }): string {
  const by = (a: ObjectRef, b: ObjectRef) => refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0;
  return createHash('sha256').update(JSON.stringify({ title: creation.title, outcome: creation.outcome, status: creation.status,
    blocker: creation.blocker, owner: creation.owner, sources: [...creation.sources].sort(by), related: [...creation.related].sort(by),
    criteria: creation.criteria, dependencyIds: [...creation.dependencyIds].sort() })).digest('hex');
}
