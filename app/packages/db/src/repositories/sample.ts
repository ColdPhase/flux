import { eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** The integration fixture's job (#82, #88): one per committed sample. */
export const SAMPLE_JOB = 'sample.process';

/**
 * Drizzle adapter for the integration-fixture sample (issues #46, #82, #88): the API's fixture
 * command writes a sample with its event and outbox row in one transaction, and the worker records
 * which worker processed it, once per sample.
 */
export function sampleRepository(db: DbExecutor) {
  return {
    /** The sample, its `sample.created.v1` event and its outbox row; run inside the command's transaction. */
    async create(sample: { id: string; title: string; createdBy: string; eventId: string; outboxId: string }): Promise<void> {
      await db.insert(schema.samples).values({ id: sample.id, title: sample.title, createdBy: sample.createdBy });
      await db.insert(schema.events).values({ id: sample.eventId, kind: 'sample.created.v1', objectId: sample.id, actorId: sample.createdBy, data: { title: sample.title } });
      await db.insert(schema.outbox).values({ id: sample.outboxId, eventId: sample.eventId });
    },
    /** Records the result of a processed sample; false when the sample row does not exist. */
    async recordResult(sampleId: string, workerId: string): Promise<boolean> {
      const [sample] = await db.select({ id: schema.samples.id }).from(schema.samples).where(eq(schema.samples.id, sampleId));
      if (!sample) return false;
      await db.insert(schema.sampleResults).values({ sampleId: sample.id, workerId }).onConflictDoNothing();
      return true;
    },
  };
}
