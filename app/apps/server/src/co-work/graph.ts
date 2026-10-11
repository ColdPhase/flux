import type { CoWorkSourceRef } from '@flux/contracts';
import { referencedTaskIds, TaskUseRefusal, workRows, type CoWorkTaskLockInput } from '@flux/db';
import type { Transaction } from '@flux/core';
import { lockProjectTaskGraphs, taskPrerequisiteIds } from '../work/task-graph.js';

/**
 * Production #171 lock provider for co-work compositions. It runs after the connection slots and before
 * the first native task lock. It takes the sorted project graph locks and returns the direct prerequisites,
 * which the caller adds to its single sorted task lock pass. Role eligibility is a separate check.
 */
export async function coWorkTaskGraphLocks(tx: Transaction, workspaceId: string,
  units: readonly CoWorkTaskLockInput[]): Promise<readonly string[]> {
  await lockProjectTaskGraphs(tx, units.map((unit) => unit.projectId));
  return taskPrerequisiteIds(tx, workspaceId, units.flatMap((unit) => [unit.taskId, unit.lineageTaskId]));
}

/** A co-work reference as a typed task-use target (#238): a linked pull request is located by its task link. */
export function coWorkTaskReference(ref: CoWorkSourceRef): { type: string; id: string } {
  return ref.type === 'github_pr' ? { type: ref.type, id: ref.linkId } : { type: ref.type, id: ref.id };
}

/**
 * #238: {@link coWorkTaskGraphLocks} for a writer that also names tasks (a request's target, sources and criteria, or a
 * completion outcome). The named tasks' projects join the ONE sorted graph pass; the names are resolved again under
 * those graph locks, and a task that appears meanwhile refuses with TASK_TARGET_SET_CHANGED rather than escaping the
 * fence. The returned ids join the caller's single sorted task pass, which refuses a task whose creation was undone.
 */
export async function coWorkNamedTaskGraphLocks(tx: Transaction, workspaceId: string, units: readonly CoWorkTaskLockInput[],
  refs: readonly CoWorkSourceRef[]): Promise<readonly string[]> {
  const resolve = () => refs.length ? referencedTaskIds(tx, refs.map(coWorkTaskReference)) : Promise.resolve([] as string[]);
  const named = await resolve();
  const located = await Promise.all(named.map((id) => workRows(tx).locate('work', id)));
  await lockProjectTaskGraphs(tx, [...units.map((unit) => unit.projectId), ...located.flatMap((row) => row ? [row.projectId] : [])]);
  const current = await resolve();
  if (current.some((id) => !named.includes(id))) throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
  return [...await taskPrerequisiteIds(tx, workspaceId, units.flatMap((unit) => [unit.taskId, unit.lineageTaskId])), ...current];
}
