import { withTaskUseErrors } from '../work/task-use-errors.js';
import { sql } from '@flux/db';
import type { Database, Transaction } from '@flux/core';

/** Cancel in PostgreSQL before the unchanged 2s driver timeout, so rollback can drain. */
export function githubTransaction<T>(db: Database, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '750ms'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
    return withTaskUseErrors(() => work(tx));
  });
}
