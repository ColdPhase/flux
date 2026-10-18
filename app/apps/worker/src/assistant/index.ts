import { fromDrizzle, type PgBoss } from 'pg-boss';
import { assistantReactionRows, assistantJobRows, assistantSummaryRows, pushSubscriptionRepository, sql, type DbExecutor } from '@flux/db';
import {
  ASSISTANT_TICK_JOB, PERSONAL_RUN_JOB, assistantReactionTick, PUSH_SEND_JOB, assistantTick, createPersonalRunUseCases, settleAssistantSummaries, startAssistantSummary,
  type AssistantReactionUnitOfWork, type AssistantSummaryUnitOfWork, type Database, type PersonalConnectionLookup, type PersonalRuntimeAvailability,
} from '@flux/core';
import { summaryPorts, type AssistantSummaryStart } from '../jobs/morning-summary.js';
import { personalRunPorts } from '../personal-runs/adapters.js';

// "On a schedule" and the morning summary written by the assistant, in the worker (F-027 AST-7 "Engine", A8 #408). One
// singleton tick a minute (pg-boss gives a scheduled job one slot per minute across all workers) fires what is due and closes
// what ended; it is also safe if two workers run it at once (see packages/core/src/assistant/job-tick.ts). The morning summary
// stays on #350's own tick (`MORNING_SUMMARY_JOB`): this module gives that tick the assistant's start hook and settles the
// summaries whose run ended.

export interface AssistantTickComposition {
  connections: PersonalConnectionLookup;
  providerEnabled: boolean;
  toolTurns?: number;
  runtime?: PersonalRuntimeAvailability;
}

/** A queue that sends a run's dispatch job inside the unit of work, so the run and its job commit together. */
const queueIn = (tx: DbExecutor, boss: Pick<PgBoss, 'send'>) => ({
  async enqueue(runId: string) {
    const jobId = await boss.send(PERSONAL_RUN_JOB, { runId }, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql) });
    if (!jobId) throw new Error('Job enqueue failed');
  },
});

/** The Inbox item of a paused schedule, with its push, inside the tick's transaction. */
function inboxIn(tx: DbExecutor, boss: Pick<PgBoss, 'send'>) {
  return {
    async tell(ownerUserId: string, projectId: string, title: string, body: string, url: string) {
      const id = await assistantJobRows(tx).notify(ownerUserId, projectId, title, body, url);
      for (const subscriptionId of await pushSubscriptionRepository(tx).deliverableIdsForUser(ownerUserId))
        await boss.send(PUSH_SEND_JOB, { notificationId: id, subscriptionId, userId: ownerUserId }, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql), singletonKey: `${id}:${subscriptionId}` });
      return id;
    },
  };
}

export function assistantUnitOfWork(db: Database, boss: Pick<PgBoss, 'send'>): AssistantReactionUnitOfWork {
  return { run: (work) => db.transaction((tx) => work({ ...personalRunPorts(tx, queueIn(tx, boss)), jobs: assistantJobRows(tx), reactions: assistantReactionRows(tx), inbox: inboxIn(tx, boss) })) };
}

export function startBackgroundOf(composition: AssistantTickComposition, db: Database, boss: Pick<PgBoss, 'send'>) {
  // The same use cases as the API's: the run starts through the personal-run path, with its consent, standing, access and caps.
  const runs = createPersonalRunUseCases({
    uow: { run: (work) => db.transaction((tx) => work(personalRunPorts(tx, queueIn(tx, boss)))) },
    connections: composition.connections, providerEnabled: composition.providerEnabled,
    ...(composition.toolTurns !== undefined ? { toolTurns: composition.toolTurns } : {}), ...(composition.runtime ? { runtime: composition.runtime } : {}),
  });
  return runs.startBackground;
}

/** The hook of #350's tick: starts the assistant's run for a person's morning summary in the claim's own transaction. */
export function assistantSummaryStart(db: Database, boss: Pick<PgBoss, 'send'>, composition: AssistantTickComposition): AssistantSummaryStart {
  const startBackground = startBackgroundOf(composition, db, boss);
  return (tx, summary, userId, day, now) => startAssistantSummary({ ...personalRunPorts(tx, queueIn(tx, boss)), jobs: assistantJobRows(tx), summaries: assistantSummaryRows(tx) },
    summary, startBackground, userId, day, now);
}

/** Closes the summaries whose run ended: the line on Home and its one push, or the plain summary. */
export function settleSummaries(db: Database, boss: Pick<PgBoss, 'send'>, now: Date = new Date()) {
  const uow: AssistantSummaryUnitOfWork = {
    run: (work) => db.transaction((tx) => work({ ...personalRunPorts(tx, queueIn(tx, boss)), jobs: assistantJobRows(tx), summaries: assistantSummaryRows(tx) }, summaryPorts(tx, boss))),
  };
  return settleAssistantSummaries(uow, now);
}

/** The per-minute tick (`assistant.background.tick.v1`): fires due schedules, closes ended ones and settles written summaries. */
export async function registerAssistantTick(boss: PgBoss, db: Database, composition: AssistantTickComposition, options: { log?: (line: Record<string, unknown>) => void } = {}) {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const uow = assistantUnitOfWork(db, boss);
  const startBackground = startBackgroundOf(composition, db, boss);
  await boss.work(ASSISTANT_TICK_JOB, async () => {
    await assistantTick({ uow, startBackground, log });
    await assistantReactionTick({ uow, startBackground });
    const settled = await settleSummaries(db, boss);
    if (settled.written || settled.plain) log({ job: ASSISTANT_TICK_JOB, summaries: settled });
  });
  await boss.schedule(ASSISTANT_TICK_JOB, '* * * * *');
}
