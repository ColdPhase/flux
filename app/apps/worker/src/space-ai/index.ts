import type { PgBoss } from 'pg-boss';
import { SPACE_AI_SWEEP_JOB, type SpaceAiSweepJob } from '@flux/contracts';
import { sweepSpaceAi, SpaceAiSweepIncomplete } from '@flux/core';
import { accessPorts, type Database } from '@flux/db';

/**
 * AG-10: the worker's copy of the turn-off sweep. The flip sends `{ projectId, epoch }` in its own transaction; the API
 * sweeps at once, and this job repeats it, so a crash between the flip and the API's sweep cannot leave AI work behind. It
 * touches only work admitted under an older epoch, so running it late, twice, or after AI is on again is safe.
 */
export async function registerSpaceAiSweep(boss: PgBoss, db: Database) {
  await boss.work<SpaceAiSweepJob>(SPACE_AI_SWEEP_JOB, async (jobs) => {
    for (const job of jobs) {
      try {
        const swept = await sweepSpaceAi(job.data, db, accessPorts);
        console.log(JSON.stringify({ job: SPACE_AI_SWEEP_JOB, id: job.id, projectId: job.data.projectId, epoch: job.data.epoch, swept }));
      } catch (error) {
        // The steps that committed stay committed; the job is retried for the rest (the sweep is idempotent), and it is loud.
        console.error(JSON.stringify({ job: SPACE_AI_SWEEP_JOB, id: job.id, projectId: job.data.projectId, epoch: job.data.epoch,
          error: (error as Error).message, swept: error instanceof SpaceAiSweepIncomplete ? error.swept : null }));
        throw error;
      }
    }
  });
}
