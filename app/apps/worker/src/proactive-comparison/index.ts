import type { PgBoss } from 'pg-boss';
import { COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB, type ComparisonProvider, type Database } from '@flux/core';
import { dispatchProactiveComparison } from './dispatch.js';
import { comparisonRecoveryTick } from './recovery.js';
import { comparisonSchedulingTick } from './scheduling.js';

export { COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB } from '@flux/core';

export interface ComparisonWorkerOptions {
  /** `FLUX_BACKGROUND_COMPARISONS=on` (#58); off unschedules both jobs. */
  enabled: boolean;
  /** The background key custody key; without it every ready candidate is recorded as not run. */
  masterKey: Buffer | null;
  /** The adapter registry for the owner's connection (F-020) or a test double. */
  provider: ComparisonProvider;
  log?: (line: Record<string, unknown>) => void;
}

/**
 * Background comparisons in the worker (#58, O-007), registered only when the operator switched
 * them on. One scheduled tick a minute selects ready candidate ids (no key or provider port) and
 * dispatches them one at a time; each dispatch rechecks access, budget and sources and reserves
 * before any provider call, so a tick on a second worker cannot run a candidate twice. Recovery
 * only settles interrupted reservations; it never dispatches or retries.
 */
export async function registerComparisonWorker(boss: Pick<PgBoss, 'work' | 'schedule' | 'unschedule'>, db: Database, options: ComparisonWorkerOptions) {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  if (!options.enabled) {
    // Turning the switch off also stops schedules an earlier run left in the queue.
    for (const name of [COMPARISON_TICK_JOB, COMPARISON_RECOVERY_JOB]) await boss.unschedule(name).catch(() => undefined);
    return { enabled: false };
  }
  await boss.work(COMPARISON_TICK_JOB, async () => {
    const tick = await comparisonSchedulingTick(db);
    for (const candidateId of tick.readyIds) {
      const outcome = await dispatchProactiveComparison({ db, candidateId, masterKey: options.masterKey, provider: options.provider });
      log({ job: COMPARISON_TICK_JOB, candidateId, outcome: outcome.status, ...('reason' in outcome ? { reason: outcome.reason } : {}) });
    }
    log({ job: COMPARISON_TICK_JOB, events: tick.events, projects: tick.projects, created: tick.created, obsolete: tick.obsolete, dispatched: tick.readyIds.length });
  });
  await boss.work(COMPARISON_RECOVERY_JOB, async () => {
    log({ job: COMPARISON_RECOVERY_JOB, ...(await comparisonRecoveryTick(db)) });
  });
  await boss.schedule(COMPARISON_TICK_JOB, '* * * * *');
  await boss.schedule(COMPARISON_RECOVERY_JOB, '*/10 * * * *');
  return { enabled: true };
}
