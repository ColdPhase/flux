import { fromDrizzle, type PgBoss } from 'pg-boss';
import { assistantJobRows, sql, type DbExecutor, type Database } from '@flux/db';
import {
  ASSISTANT_TICK_JOB, PERSONAL_RUN_JOB, assistantTick, createPersonalRunUseCases,
  type AssistantJobUnitOfWork, type PersonalConnectionLookup, type PersonalRuntimeAvailability,
} from '@flux/core';
import { personalRunPorts } from '../personal-runs/adapters.js';

// An agent's schedules in the worker (F-036 AG-9, #858; F-027 AST-7 "Engine"). One singleton tick a minute (pg-boss gives a scheduled job
// one slot per minute across all workers) fires what is due and closes what ended; it is also safe if two workers run it at
// once (see packages/core/src/assistant/job-tick.ts).

export interface AssistantTickComposition {
  connections: PersonalConnectionLookup;
  providerEnabled: boolean;
  runtime?: PersonalRuntimeAvailability;
}

/** A queue that sends a run's dispatch job inside the unit of work, so the run and its job commit together. */
const queueIn = (tx: DbExecutor, boss: Pick<PgBoss, 'send'>) => ({
  async enqueue(runId: string) {
    const jobId = await boss.send(PERSONAL_RUN_JOB, { runId }, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql) });
    if (!jobId) throw new Error('Job enqueue failed');
  },
});

export function assistantUnitOfWork(db: Database, boss: Pick<PgBoss, 'send'>): AssistantJobUnitOfWork {
  return { run: (work) => db.transaction((tx) => work({ ...personalRunPorts(tx, queueIn(tx, boss)), jobs: assistantJobRows(tx) })) };
}

export function startBackgroundOf(composition: AssistantTickComposition, db: Database, boss: Pick<PgBoss, 'send'>) {
  // The same use cases as the API's: the run starts through the personal-run path, with its consent, standing, access and caps.
  const runs = createPersonalRunUseCases({
    uow: { run: (work) => db.transaction((tx) => work(personalRunPorts(tx, queueIn(tx, boss)))) },
    connections: composition.connections, providerEnabled: composition.providerEnabled,
    ...(composition.runtime ? { runtime: composition.runtime } : {}),
  });
  return runs.startBackground;
}

/** The per-minute tick (`assistant.background.tick.v1`): fires due schedules and closes ended ones. */
export async function registerAssistantTick(boss: PgBoss, db: Database, composition: AssistantTickComposition, options: { log?: (line: Record<string, unknown>) => void } = {}) {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const uow = assistantUnitOfWork(db, boss);
  const startBackground = startBackgroundOf(composition, db, boss);
  await boss.work(ASSISTANT_TICK_JOB, async () => {
    await assistantTick({ uow, startBackground, log });
  });
  await boss.schedule(ASSISTANT_TICK_JOB, '* * * * *');
}
