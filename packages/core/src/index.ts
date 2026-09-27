import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { schema, type createDatabase } from '@flux/db';
import type { SampleAccepted, SampleCommand } from '@flux/contracts';

export const SAMPLE_JOB = 'sample.process';
export type Database = ReturnType<typeof createDatabase>['db'];

export interface Principal {
  id: string;
  kind: 'fixture' | 'human' | 'agent';
}

export async function createSample(principal: Principal, command: SampleCommand, db: Database, boss: PgBoss): Promise<SampleAccepted> {
  if (!principal.id) throw new Error('Unauthenticated actor');
  const title = command.title.trim();
  if (!title || title.length > 200) throw new Error('Title must be 1–200 characters');
  const id = randomUUID();
  const eventId = randomUUID();
  const outboxId = randomUUID();
  return db.transaction(async (tx) => {
    await tx.insert(schema.samples).values({ id, title, createdBy: principal.id });
    await tx.insert(schema.events).values({ id: eventId, kind: 'sample.created.v1', objectId: id, actorId: principal.id, data: { title } });
    await tx.insert(schema.outbox).values({ id: outboxId, eventId });
    const jobId = await boss.send(SAMPLE_JOB, { sampleId: id }, { db: fromDrizzle(tx, sql) });
    if (!jobId) throw new Error('Job enqueue failed');
    if (command.failAfterInsert) throw new Error('Forced rollback');
    return { id, eventId, jobId };
  });
}
