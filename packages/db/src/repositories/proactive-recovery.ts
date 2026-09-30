import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

const q = schema.proactiveComparisonOutbox;

/** Internal metadata-only recovery, composed in a transaction by the worker. */
export function comparisonRecoveryRows(db: DbExecutor) {
  return {
    lockStale(cutoff: Date, limit: number) {
      return db.select({ id: q.id, status: q.status, updatedAt: q.updatedAt, dispatchStartedAt: q.dispatchStartedAt })
        .from(q).where(and(eq(q.status, 'reserved'), lte(q.updatedAt, cutoff)))
        .orderBy(asc(q.updatedAt), asc(q.id)).limit(limit).for('update', { skipLocked: true });
    },
    async notRun(id: string, cutoff: Date, at: Date) {
      const rows = await db.update(q).set({ status: 'not_run', failureCode: 'WORKER_INTERRUPTED_BEFORE_DISPATCH',
        connectionId: null, reservedAt: null, dispatchStartedAt: null,
        reservedCents: 0, usageInputTokens: 0, usageOutputTokens: 0, usageEstimatedCents: 0, finishedAt: at, updatedAt: at })
        .where(and(eq(q.id, id), eq(q.status, 'reserved'), lte(q.updatedAt, cutoff), isNull(q.dispatchStartedAt)))
        .returning({ id: q.id });
      return rows.length === 1;
    },
    async unknown(id: string, cutoff: Date, at: Date) {
      const rows = await db.update(q).set({ status: 'unknown', failureCode: 'WORKER_INTERRUPTED_AFTER_DISPATCH_INTENT',
        finishedAt: at, updatedAt: at })
        .where(and(eq(q.id, id), eq(q.status, 'reserved'), lte(q.updatedAt, cutoff), isNotNull(q.dispatchStartedAt)))
        .returning({ id: q.id });
      return rows.length === 1;
    },
  };
}
