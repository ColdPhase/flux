import type { PgBoss } from 'pg-boss';
import {
  createPersonalRunProcessor,
  noPersonalConnections,
  PERSONAL_RUN_JOB,
  recoverPersonalRuns,
  unavailablePersonalCompute,
  type PersonalCompute,
  type PersonalConnectionLookup,
  type PersonalRunTokenIssuer,
  type PersonalRuntime,
  type PersonalToolHost,
} from '@flux/core';
import type { Database } from '@flux/db';
import { personalRunWorkerUnitOfWork } from './adapters.js';
import { startPersonalRunRecovery } from './recovery.js';

export { personalRunWorkerUnitOfWork } from './adapters.js';
export { personalRunWorkerComposition } from './composition.js';
export { mcpToolHost } from './mcp-session.js';
export { runTokenIssuer } from './run-tokens.js';
export { managerPersonalRuntime } from './runtime-engine.js';

/**
 * Consumes `personal-run.dispatch.v1` (#68). The payload is a run id only; the processor rechecks
 * the owner's enablement, connection, agent and project access before reading, before dispatch
 * and inside the commit. Until #124's key connection and the provider adapter land, production
 * has no usable connection and the provider is off, so every run ends `unavailable` at zero cost.
 * The queue never retries a dispatch (`PERSONAL_RUN_QUEUE`, created by the migrator).
 */
export async function registerPersonalRunWorker(boss: PgBoss, db: Database, options: {
  connections?: PersonalConnectionLookup; compute?: PersonalCompute; tools?: PersonalToolHost; tokens?: PersonalRunTokenIssuer; runtime?: PersonalRuntime;
} = {}) {
  const uow = personalRunWorkerUnitOfWork(db);
  const processor = createPersonalRunProcessor({
    uow,
    connections: options.connections ?? noPersonalConnections,
    compute: options.compute ?? unavailablePersonalCompute,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.tokens ? { tokens: options.tokens } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
  await boss.work<{ runId: string }>(PERSONAL_RUN_JOB, async (jobs) => {
    for (const job of jobs) {
      const outcome = await processor.process(job.data.runId);
      console.log(JSON.stringify({ job: PERSONAL_RUN_JOB, id: job.id, runId: job.data.runId, outcome }));
    }
    await startNextRequests();
  });
  // The lane is free again: the owner's next queued request starts. A duplicate job is harmless (only a queued run is claimed).
  async function startNextRequests() {
    for (const runId of await uow.run((ports) => ports.runs.startableQueued(20))) await boss.send(PERSONAL_RUN_JOB, { runId });
  }
  return startPersonalRunRecovery({ recover: async () => { const ended = await recoverPersonalRuns(uow); await startNextRequests(); return ended; } });
}
