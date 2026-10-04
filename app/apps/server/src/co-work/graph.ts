import type { CoWorkTaskLockInput } from '@flux/db';
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
