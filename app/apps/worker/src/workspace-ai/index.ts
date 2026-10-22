import type { PgBoss } from 'pg-boss';
import { WORKSPACE_AI_SWEEP_JOB, type WorkspaceAiSweepJob } from '@flux/contracts';
import { sweepWorkspaceAi, type Database } from '@flux/core';

/**
 * F-029 (S2): the worker's copy of the turn-off sweep. The flip sends `{ workspaceId, epoch }` in its own transaction; the API
 * sweeps at once, and this job repeats it, so a crash between the flip and the API's sweep cannot leave AI work behind. It
 * touches only work admitted under an older epoch, so running it late, twice, or after AI is on again is safe.
 */
export async function registerWorkspaceAiSweep(boss: PgBoss, db: Database) {
  await boss.work<WorkspaceAiSweepJob>(WORKSPACE_AI_SWEEP_JOB, async (jobs) => {
    for (const job of jobs) {
      const swept = await sweepWorkspaceAi(job.data, db);
      console.log(JSON.stringify({ job: WORKSPACE_AI_SWEEP_JOB, id: job.id, workspaceId: job.data.workspaceId, epoch: job.data.epoch, swept }));
    }
  });
}
