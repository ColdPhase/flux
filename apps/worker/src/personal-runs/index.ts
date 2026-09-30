import type { PgBoss } from 'pg-boss';
import {
  createPersonalRunProcessor,
  noPersonalConnections,
  PERSONAL_RUN_JOB,
  unavailablePersonalCompute,
  type Database,
  type PersonalCompute,
  type PersonalConnectionLookup,
} from '@flux/core';
import { personalRunWorkerUnitOfWork } from './adapters.js';

export { personalRunWorkerUnitOfWork } from './adapters.js';
export { personalRunWorkerComposition } from './composition.js';

/**
 * Consumes `personal-run.dispatch.v1` (#68). The payload is a run id only; the processor rechecks
 * the owner's enablement, connection, agent and project access before reading, before dispatch
 * and inside the commit. Until #124's key connection and the provider adapter land, production
 * has no usable connection and the provider is off, so every run ends `unavailable` at zero cost.
 * The queue never retries a dispatch (`PERSONAL_RUN_QUEUE`, created by the migrator).
 */
export async function registerPersonalRunWorker(boss: PgBoss, db: Database, options: { connections?: PersonalConnectionLookup; compute?: PersonalCompute } = {}) {
  const processor = createPersonalRunProcessor({
    uow: personalRunWorkerUnitOfWork(db),
    connections: options.connections ?? noPersonalConnections,
    compute: options.compute ?? unavailablePersonalCompute,
  });
  await boss.work<{ runId: string }>(PERSONAL_RUN_JOB, async (jobs) => {
    for (const job of jobs) {
      const outcome = await processor.process(job.data.runId);
      console.log(JSON.stringify({ job: PERSONAL_RUN_JOB, id: job.id, runId: job.data.runId, outcome }));
    }
  });
}
