import type { PgBoss } from 'pg-boss';
import { deleteExpiredIdempotencyKeys, IDEMPOTENCY_CLEANUP_JOB, type Database } from '@flux/core';
import { idempotencyRepository } from '@flux/db';

/**
 * Deletes expired idempotency keys every hour; keys are retained for 24 hours
 * (see docs/development/access-policy.md).
 */
export async function registerIdempotencyCleanup(boss: PgBoss, db: Database) {
  const keys = idempotencyRepository(db);
  await boss.work(IDEMPOTENCY_CLEANUP_JOB, async () => {
    const deleted = await deleteExpiredIdempotencyKeys(keys);
    console.log(JSON.stringify({ job: IDEMPOTENCY_CLEANUP_JOB, deleted }));
  });
  await boss.schedule(IDEMPOTENCY_CLEANUP_JOB, '17 * * * *');
}
