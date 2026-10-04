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

/** Caller reserves additions before allocation and retains them through transaction settlement. */
export interface TaskUseMemory {
  reserve(bytes: number): void;
  /** Optional short-lived discovery ownership; callers retain it across every SQL await in that scope. */
  temporary?(bytes: number): () => void;
}
/** Retire only discovery allocations; the final fence is separately owned by the outer command. */
export function taskUseMemoryScope(outer?: TaskUseMemory) {
  const releases: Array<() => void> = [];
  return { memory: outer?.temporary ? { reserve(bytes: number) { releases.push(outer.temporary!(bytes)); } } : outer,
    release() { for (const release of releases.splice(0)) release(); } };
}

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
export function taskUseRows(tx: DbExecutor, memory?: TaskUseMemory) {
  const w = schema.projectWorkItems;
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  async function lockPrepared(ids: readonly string[]): Promise<TaskUseFence> {
    memory?.reserve(4096 + ids.length * 2048);
    const wanted = sorted(ids);
    const rows = wanted.length ? await tx.select({ id: w.id, projectId: w.projectId, revertedAt: w.creationRevertedAt })
      .from(w).where(inArray(w.id, wanted)).orderBy(asc(w.id)).for('update') : [];
    if (rows.length !== wanted.length) throw new TaskUseRefusal('TASK_TARGET_NOT_FOUND');
    if (rows.some((row) => row.revertedAt !== null)) throw new TaskUseRefusal('TASK_CREATION_REVERTED');
    const held = new Set(wanted);
    return { ids: wanted, projectIds: sorted(rows.map((row) => row.projectId)), async mark(ids = wanted) {
      memory?.reserve(2048 + ids.length * 1024);
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
    /** Caller has already prepared ALL graph/dependency/material/connection locks. Acquires no upstream lock. */
    lockPrepared,
  };
}
