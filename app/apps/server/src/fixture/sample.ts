import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { SampleAccepted, SampleCommand } from '@flux/contracts';
import type { Database, Principal } from '@flux/core';
import { SAMPLE_JOB, sampleRepository } from '@flux/db';

/** A sample title outside 1–200 characters. */
export class InvalidSampleError extends Error {}

/** The test deployment asked the command to fail after its writes; nothing was committed. */
export class ForcedRollbackError extends Error {
  constructor() { super('Forced rollback'); }
}

/**
 * The integration fixture (#88): the sample, its event, its outbox row and its job commit in one
 * transaction, or none of them. `testFailureAfterInsert` fails after every write, so a test can
 * prove the rollback. Only the fixture route and tests call it; it is not part of the product.
 */
export async function createSample(principal: Principal, command: SampleCommand, db: Database, boss: Pick<PgBoss, 'send'>, testFailureAfterInsert = false): Promise<SampleAccepted> {
  if (!principal.id) throw new Error('Unauthenticated actor');
  const title = command.title.trim();
  if (!title || title.length > 200) throw new InvalidSampleError('Title must be 1–200 characters');
  const id = randomUUID();
  const eventId = randomUUID();
  const outboxId = randomUUID();
  return db.transaction(async (tx) => {
    await sampleRepository(tx).create({ id, title, createdBy: principal.id, eventId, outboxId });
    const jobId = await boss.send(SAMPLE_JOB, { sampleId: id }, { db: fromDrizzle(tx, sql) });
    if (!jobId) throw new Error('Job enqueue failed');
    if (testFailureAfterInsert) throw new ForcedRollbackError();
    return { id, eventId, jobId };
  });
}
