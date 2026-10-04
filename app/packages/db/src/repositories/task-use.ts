import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ConflictError, RuleViolationError } from '@flux/core';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

export interface TaskUseFence {
  /** Complete ascending task set retained by this transaction. */
  readonly ids: readonly string[];
  readonly projectIds: readonly string[];
  /** Call only after a successful persisted effect, before the caller's final event batch. */
  mark(ids?: readonly string[]): Promise<void>;
}

/**
 * Caller-owned transaction only. Authority/command/material/connection locks precede this seam.
 * No transaction, authorization, event, receipt or commit occurs here. Observations never call mark.
 */
export function taskUseRows(tx: DbExecutor) {
  const w = schema.projectWorkItems;
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  async function lockPrepared(ids: readonly string[]): Promise<TaskUseFence> {
    const wanted = sorted(ids);
    const rows = wanted.length ? await tx.select({ id: w.id, projectId: w.projectId, revertedAt: w.creationRevertedAt })
      .from(w).where(inArray(w.id, wanted)).orderBy(asc(w.id)).for('update') : [];
    if (rows.length !== wanted.length) throw new RuleViolationError('A task target is unavailable', 'TASK_TARGET_NOT_FOUND');
    if (rows.some((row) => row.revertedAt !== null)) throw new ConflictError('Task creation was undone; open its history', 'TASK_CREATION_REVERTED');
    const held = new Set(wanted);
    return { ids: wanted, projectIds: sorted(rows.map((row) => row.projectId)), async mark(ids = wanted) {
      const used = sorted(ids);
      if (used.some((id) => !held.has(id))) throw new Error('Task use must be inside the complete retained task fence');
      if (used.length) await tx.update(w).set({ firstPersistedUseAt: sql`COALESCE(${w.firstPersistedUseAt}, clock_timestamp())` })
        .where(and(inArray(w.id, used), sql`${w.creationRevertedAt} IS NULL`));
    } };
  }
  return {
    /** Gather project identity without locking, then graph locks, then ONE complete sorted task pass. */
    async prepare(ids: readonly string[]): Promise<TaskUseFence> {
      const wanted = sorted(ids);
      const projects = wanted.length ? await tx.select({ projectId: w.projectId }).from(w).where(inArray(w.id, wanted)) : [];
      for (const projectId of sorted(projects.map((row) => row.projectId)))
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`flux.task-graph:${projectId}`}))`);
      return lockPrepared(wanted);
    },
    /** Caller has already prepared ALL graph/dependency/material/connection locks. Acquires no upstream lock. */
    lockPrepared,
  };
}
