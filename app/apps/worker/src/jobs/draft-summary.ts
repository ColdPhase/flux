import type { PgBoss } from 'pg-boss';
import { DRAFT_SUMMARY_JOB, processDraftSummary, type Database } from '@flux/core';

/**
 * Consumes draft.summarize.v1 jobs. The payload is a result id only. processDraftSummary rechecks
 * the requester's access before reading the draft and inside the commit transaction.
 */
export async function registerDraftSummaryWorker(boss: PgBoss, db: Database) {
  await boss.work<{ resultId: string }>(DRAFT_SUMMARY_JOB, async (jobs) => {
    for (const job of jobs) {
      const outcome = await processDraftSummary(job.data.resultId, db);
      console.log(JSON.stringify({ job: DRAFT_SUMMARY_JOB, id: job.id, resultId: job.data.resultId, outcome }));
    }
  });
}
