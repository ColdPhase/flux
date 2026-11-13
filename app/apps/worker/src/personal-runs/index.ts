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
import { runLiveText, type Database } from '@flux/db';
import { personalRunWorkerUnitOfWork } from './adapters.js';
import { startPersonalRunRecovery } from './recovery.js';

export { personalRunWorkerUnitOfWork } from './adapters.js';
export { personalRunWorkerComposition } from './composition.js';
export { mcpToolHost } from './mcp-session.js';
export { runTokenIssuer } from './run-tokens.js';
export { managerPersonalRuntime } from './runtime-engine.js';

/** How many runs one poll of the queue may start. */
const RUNS_STARTED_PER_POLL = 16;
/** How long a stopping worker gives the runs in progress. */
const STOP_WAIT_MS = 5_000;

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
    // The asker sees `/ai` and a chat answered as they are written (#1248), over the API's live stream.
    live: runLiveText(db),
  });
  // A run may take an hour, and many people's agents run at once (#860): the job only starts it, and one long run never holds
  // up the next person's. Who may start is decided in the claim. A worker that dies mid-run is covered by the recovery below.
  const running = new Set<Promise<void>>();
  await boss.work<{ runId: string }>(PERSONAL_RUN_JOB, { batchSize: RUNS_STARTED_PER_POLL }, async (jobs) => {
    for (const job of jobs) {
      const run: Promise<void> = processor.process(job.data.runId)
        .then((outcome) => { console.log(JSON.stringify({ job: PERSONAL_RUN_JOB, id: job.id, runId: job.data.runId, outcome })); })
        .catch((error: unknown) => { console.error(`${PERSONAL_RUN_JOB} failed`, job.data.runId, error); })
        .then(startNextRequests)
        .catch((error: unknown) => { console.error('Could not start the next requests', error); })
        .finally(() => { running.delete(run); });
      running.add(run);
    }
  });
  // The lane is free again: the owner's next queued request starts. A duplicate job is harmless (only a queued run is claimed).
  async function startNextRequests() {
    for (const runId of await uow.run((ports) => ports.runs.startableQueued(20, options.runtime?.keys === true))) await boss.send(PERSONAL_RUN_JOB, { runId });
  }
  const recovery = startPersonalRunRecovery({ recover: async () => { const ended = await recoverPersonalRuns(uow); await startNextRequests(); return ended; } });
  return {
    async stop() {
      await recovery.stop();
      // Short runs finish; a long one is left to the recovery of the next worker, like a crash.
      await Promise.race([Promise.allSettled(running), new Promise((resume) => setTimeout(resume, STOP_WAIT_MS).unref())]);
    },
  };
}
