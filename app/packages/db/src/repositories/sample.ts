import { eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for the integration-fixture sample job (issues #46, #82): the worker records
 * which worker processed a committed sample, once per sample.
 */
export function sampleRepository(db: DbExecutor) {
  return {
    /** Records the result of a processed sample; false when the sample row does not exist. */
    async recordResult(sampleId: string, workerId: string): Promise<boolean> {
      const [sample] = await db.select({ id: schema.samples.id }).from(schema.samples).where(eq(schema.samples.id, sampleId));
      if (!sample) return false;
      await db.insert(schema.sampleResults).values({ sampleId: sample.id, workerId }).onConflictDoNothing();
      return true;
    },
  };
}
