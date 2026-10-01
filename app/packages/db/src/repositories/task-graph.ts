import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Native task graph rows and locks (#152, migration 0039): direct prerequisite edges, the immutable plan
 * intent and the two advisory/row lock passes. They satisfy the graph part of core's `WorkRepository` and
 * `TaskGraphReader` ports structurally and make no access decisions. Core owns the rules and the errors
 * (`packages/core/src/work/task-graph.ts`); `apps/server/src/work/task-graph.ts` composes the exported
 * primitives. Callers hold the project graph locks first, then the complete sorted task rows, before any
 * dependency or intent write, and take nothing from here after the first stream insert.
 */

/** The advisory-lock namespace of a project's task graph. It is part of the contract. */
export const TASK_GRAPH_LOCK_NAMESPACE = 'flux.task-graph:';

type Window = { workspaceId: string; projectId: string };
const w = schema.projectWorkItems;
const e = schema.projectTaskDependencies;
const i = schema.projectTaskPlanIntents;

export function taskGraphRows(db: DbExecutor) {
  return {
    /**
     * One `pg_advisory_xact_lock(hashtextextended('flux.task-graph:' || projectId, 0))` per project, in the
     * order given (core passes ascending, de-duplicated lowercase ids). It locks no row.
     */
    async lockTaskGraphs(projectIds: readonly string[]) {
      for (const projectId of projectIds)
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${TASK_GRAPH_LOCK_NAMESPACE + projectId}, 0))`);
    },

    async directPrerequisiteIds(workspaceId: string, taskIds: readonly string[], limit: number): Promise<string[]> {
      if (!taskIds.length) return [];
      const rows = await db.selectDistinct({ id: e.prerequisiteId }).from(e)
        .where(and(eq(e.workspaceId, workspaceId), inArray(e.taskId, [...taskIds]))).orderBy(asc(e.prerequisiteId)).limit(limit);
      return rows.map((row) => row.id);
    },

    /** Locks exactly the task rows named, ascending by id (the sort runs before the locks). */
    async lockTasks(workspaceId: string, ids: readonly string[]) {
      if (!ids.length) return [];
      return db.select({ id: w.id, projectId: w.projectId }).from(w)
        .where(and(eq(w.workspaceId, workspaceId), inArray(w.id, [...ids]))).orderBy(asc(w.id)).for('update');
    },

    async prerequisiteStates(workspaceId: string, taskId: string) {
      const [task] = await db.select({ projectId: w.projectId }).from(w).where(and(eq(w.workspaceId, workspaceId), eq(w.id, taskId)));
      if (!task) return null;
      const p = alias(w, 'prerequisite');
      const rows = await db.select({ id: e.prerequisiteId, status: p.status, parkedAt: p.parkedAt }).from(e)
        .leftJoin(p, and(eq(p.workspaceId, e.workspaceId), eq(p.projectId, e.projectId), eq(p.id, e.prerequisiteId)))
        .where(and(eq(e.workspaceId, workspaceId), eq(e.taskId, taskId))).orderBy(asc(e.prerequisiteId));
      return { projectId: task.projectId, prerequisites: rows.map((row) => ({ id: row.id, status: row.status, parked: row.parkedAt !== null })) };
    },

    async replaceDependencies(scope: Window, taskId: string, prerequisiteIds: readonly string[]) {
      await db.delete(e).where(and(eq(e.workspaceId, scope.workspaceId), eq(e.projectId, scope.projectId), eq(e.taskId, taskId)));
      if (prerequisiteIds.length)
        await db.insert(e).values(prerequisiteIds.map((prerequisiteId) => ({ workspaceId: scope.workspaceId, projectId: scope.projectId, taskId, prerequisiteId })));
    },

    async taskPlans(taskIds: readonly string[]) {
      const plans = new Map<string, { prerequisites: { id: string; title: string; status: typeof w.$inferSelect['status']; parked: boolean }[];
        planIntent: { materialId: string; version: number; intentKey: string } | null }>();
      if (!taskIds.length) return plans;
      const entry = (id: string) => {
        let plan = plans.get(id);
        if (!plan) plans.set(id, plan = { prerequisites: [], planIntent: null });
        return plan;
      };
      const p = alias(w, 'prerequisite');
      const edges = await db.select({ taskId: e.taskId, id: p.id, title: p.title, status: p.status, parkedAt: p.parkedAt }).from(e)
        .innerJoin(p, and(eq(p.workspaceId, e.workspaceId), eq(p.projectId, e.projectId), eq(p.id, e.prerequisiteId)))
        .where(inArray(e.taskId, [...taskIds])).orderBy(asc(e.taskId), asc(e.prerequisiteId));
      for (const edge of edges) entry(edge.taskId).prerequisites.push({ id: edge.id, title: edge.title, status: edge.status, parked: edge.parkedAt !== null });
      const intents = await db.select().from(i).where(inArray(i.taskId, [...taskIds]));
      for (const intent of intents) entry(intent.taskId).planIntent = { materialId: intent.materialId, version: intent.materialVersion, intentKey: intent.intentKey };
      return plans;
    },

    /** FOR SHARE, like every other reader of a source's current version, so a writer of the plan waits. */
    async lockPlanSource(workspaceId: string, projectId: string, materialId: string) {
      const m = schema.projectMaterials;
      const [row] = await db.select({ currentVersion: m.currentVersion }).from(m)
        .where(and(eq(m.id, materialId), eq(m.workspaceId, workspaceId), eq(m.projectId, projectId))).for('share');
      return row ?? null;
    },

    async findPlanIntent(projectId: string, intent: { materialId: string; version: number; intentKey: string }) {
      const [row] = await db.select().from(i).where(and(eq(i.projectId, projectId), eq(i.materialId, intent.materialId),
        eq(i.materialVersion, intent.version), eq(i.intentKey, intent.intentKey)));
      return row ? { taskId: row.taskId, fingerprint: row.creationFingerprint, taskVersion: row.taskVersion } : null;
    },

    async insertPlanIntent(scope: Window, intent: { materialId: string; version: number; intentKey: string },
      record: { taskId: string; fingerprint: string; taskVersion: number }) {
      await db.insert(i).values({ workspaceId: scope.workspaceId, projectId: scope.projectId, materialId: intent.materialId,
        materialVersion: intent.version, intentKey: intent.intentKey, taskId: record.taskId,
        creationFingerprint: record.fingerprint, taskVersion: record.taskVersion });
    },
  };
}
