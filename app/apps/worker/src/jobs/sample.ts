import type { PgBoss } from 'pg-boss';
import type { Database } from '@flux/core';
import { SAMPLE_JOB, sampleRepository } from '@flux/db';

/**
 * Consumes sample.process jobs, the integration fixture: each committed sample gets one result
 * naming the worker that processed it. A missing sample fails the job so pg-boss retries it.
 */
export async function registerSampleWorker(boss: PgBoss, db: Database, workerId: string) {
  const samples = sampleRepository(db);
  await boss.work<{ sampleId: string }>(SAMPLE_JOB, async (jobs) => {
    for (const job of jobs) {
      if (!(await samples.recordResult(job.data.sampleId, workerId))) throw new Error(`Sample ${job.data.sampleId} missing`);
    }
  });
}
