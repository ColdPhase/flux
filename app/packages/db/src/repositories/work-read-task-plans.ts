import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { WORK_LIMITS } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** One scalar batch for selected rows. Full task plans belong only to own-object detail. */
export async function nativePrerequisiteCounts(db: DbExecutor, projectId: string, taskIds: readonly string[]) {
  if (taskIds.length > 100) throw new Error('Native prerequisite count window exceeds its bound');
  const counts = new Map<string, { total: number; unmet: number }>();
  if (!taskIds.length) return counts;
  const task = schema.projectWorkItems, edge = schema.projectTaskDependencies;
  const prerequisite = alias(task, 'bounded_prerequisite');
  const rows = await db.select({ id: task.id,
    total: sql<number>`count(${edge.prerequisiteId})::integer`,
    unmet: sql<number>`count(${edge.prerequisiteId}) FILTER (WHERE ${prerequisite.id} IS NULL OR ${prerequisite.status} <> 'done' OR ${prerequisite.parkedAt} IS NOT NULL)::integer`,
    invalid: sql<number>`count(${edge.prerequisiteId}) FILTER (WHERE ${edge.workspaceId} <> ${task.workspaceId} OR ${edge.projectId} <> ${task.projectId} OR ${prerequisite.id} IS NULL)::integer`,
  }).from(task).leftJoin(edge, eq(edge.taskId, task.id))
    .leftJoin(prerequisite, and(eq(prerequisite.id, edge.prerequisiteId), eq(prerequisite.workspaceId, task.workspaceId), eq(prerequisite.projectId, task.projectId)))
    .where(and(eq(task.projectId, projectId), inArray(task.id, [...taskIds]))).groupBy(task.id);
  for (const row of rows) {
    if (row.invalid || row.total > WORK_LIMITS.dependencies || row.unmet > row.total)
      throw new Error('Invalid native prerequisite observation');
    counts.set(row.id, { total: row.total, unmet: row.unmet });
  }
  if (counts.size !== new Set(taskIds).size) throw new Error('Missing native prerequisite task');
  return counts;
}
