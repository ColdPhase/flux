import { and, asc, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { taskGraphRows } from './task-graph.js';

/** Persistence refusal only; composition roots translate this outcome to domain/transport errors. */
export class TaskUseRefusal extends Error {
  constructor(readonly code: 'TASK_TARGET_NOT_FOUND' | 'TASK_CREATION_REVERTED' | 'TASK_TARGET_SET_CHANGED') {
    super(code);
    this.name = 'TaskUseRefusal';
  }
}

export interface TaskUseFence {
  /** Complete ascending task set retained by this transaction. */
  readonly ids: readonly string[];
  readonly projectIds: readonly string[];
  /** Call only after a successful persisted effect, before the caller's final event batch. */
  mark(ids?: readonly string[]): Promise<void>;
}

/**
 * The shared task-use fence (#238). Caller-owned transaction only: authority, command, material and connection
 * locks precede it. No transaction, authorization, event, receipt or commit happens here, and observations never
 * call `mark`. Every writer that persists a task-targeted effect takes the project graph locks, then ONE sorted pass
 * over its complete task set (`FOR UPDATE`), refuses a missing or creation-reverted task, and marks the monotonic
 * first-use timestamp only after its effect is saved. Undo takes the same graph and task locks without marking use,
 * so Undo and a first use serialize: exactly one wins.
 */
export function taskUseRows(tx: DbExecutor) {
  const w = schema.projectWorkItems;
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  async function lockPrepared(ids: readonly string[]): Promise<TaskUseFence> {
    const wanted = sorted(ids);
    const rows = wanted.length ? await tx.select({ id: w.id, projectId: w.projectId, revertedAt: w.creationRevertedAt })
      .from(w).where(inArray(w.id, wanted)).orderBy(asc(w.id)).for('update') : [];
    if (rows.length !== wanted.length) throw new TaskUseRefusal('TASK_TARGET_NOT_FOUND');
    if (rows.some((row) => row.revertedAt !== null)) throw new TaskUseRefusal('TASK_CREATION_REVERTED');
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
      await taskGraphRows(tx).lockTaskGraphs(sorted(projects.map((row) => row.projectId)));
      return lockPrepared(wanted);
    },
    /** Caller has already taken ALL graph/dependency/material/connection locks. Acquires no upstream lock. */
    lockPrepared,
  };
}
