import type { PgBoss } from 'pg-boss';
import { WORKSPACE_AI_SWEEP_JOB, type WorkspaceAiSweepJob } from '@flux/contracts';
import { sweepWorkspaceAi, WorkspaceAiSweepIncomplete, type Database } from '@flux/core';

/**
 * F-029 (S2): the worker's copy of the turn-off sweep. The flip sends `{ workspaceId, epoch }` in its own transaction; the API
 * sweeps at once, and this job repeats it, so a crash between the flip and the API's sweep cannot leave AI work behind. It
 * touches only work admitted under an older epoch, so running it late, twice, or after AI is on again is safe.
 */
export async function registerWorkspaceAiSweep(boss: PgBoss, db: Database) {
  await boss.work<WorkspaceAiSweepJob>(WORKSPACE_AI_SWEEP_JOB, async (jobs) => {
    for (const job of jobs) {
      try {
        const swept = await sweepWorkspaceAi(job.data, db);
        console.log(JSON.stringify({ job: WORKSPACE_AI_SWEEP_JOB, id: job.id, workspaceId: job.data.workspaceId, epoch: job.data.epoch, swept }));
      } catch (error) {
        // The steps that committed stay committed; the job is retried for the rest (the sweep is idempotent), and it is loud.
        console.error(JSON.stringify({ job: WORKSPACE_AI_SWEEP_JOB, id: job.id, workspaceId: job.data.workspaceId, epoch: job.data.epoch,
          error: (error as Error).message, swept: error instanceof WorkspaceAiSweepIncomplete ? error.swept : null }));
        throw error;
      }
    }
  });
}
