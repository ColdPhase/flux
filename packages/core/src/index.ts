import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { schema } from '@flux/db';
import type { SampleAccepted, SampleCommand } from '@flux/contracts';
import type { Database, Principal } from './types.js';

export type { Database, DatabaseHandle, Executor, Principal, Transaction } from './types.js';
export * from './access/errors.js';
export {
  authorize,
  assertAuthorized,
  authorizeEvent,
  eventResource,
  visibleFilter,
  visibleWorkspaceOf,
  loadActor,
  isUuid,
  AGENT_ACTIONS,
  DRAFT_ACTIONS,
  SKETCH_ACTIONS,
  PROJECT_ACTIONS,
  WORKSPACE_ACTIONS,
  type Action,
  type ActionsByResource,
  type Actor,
  type Decision,
  type EventRef,
  type ResourceRef,
  type ResourceType,
} from './access/policy.js';
export * from './access/domain.js';
export * from './idempotency.js';
export * from './jobs/draft-summary.js';
export * from './stream-audience.js';
export * from './sketches/index.js';
export { policySketchAccess } from './access/sketch-access.js';
export { recordEvent } from './events.js';

export const SAMPLE_JOB = 'sample.process';

export async function createSample(principal: Principal, command: SampleCommand, db: Database, boss: PgBoss, testFailureAfterInsert = false): Promise<SampleAccepted> {
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
    if (testFailureAfterInsert) throw new Error('Forced rollback');
    return { id, eventId, jobId };
  });
}

export * from './push/index.js';
export { policySourceReader } from './access/source-reader.js';
