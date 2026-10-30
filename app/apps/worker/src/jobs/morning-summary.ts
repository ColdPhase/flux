import { fromDrizzle, type PgBoss } from 'pg-boss';
import { morningSummaryRows, notificationPreferenceRows, pushSubscriptionRepository, sql, accessReader, type Database, type Transaction } from '@flux/db';
import { MORNING_SUMMARY_JOB, PUSH_SEND_JOB, policySourceReader, sendMorningSummaries, type SummaryPorts, type SummaryUnitOfWork } from '@flux/core';

/**
 * Starts the assistant's run for a person's morning summary inside the claim's transaction (F-027 A8, AST-7.6); false: the plain
 * summary goes out. Composed by `apps/worker/src/assistant`, which owns the personal-run path.
 */
export type AssistantSummaryStart = (tx: Transaction, summary: SummaryPorts, userId: string, day: string, now: Date) => Promise<boolean>;

/** Drizzle rows, the access policy and pg-boss for the morning summary (#350); the rules are in core. */
export function summaryPorts(tx: Transaction, boss: Pick<PgBoss, 'send'>, start?: AssistantSummaryStart): SummaryPorts {
  const rows = morningSummaryRows(tx);
  // Push jobs are sent in the same transaction, so they commit with the claimed day.
  const queueDb = fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql);
  const ports: SummaryPorts = {
    authorizer: policySourceReader(accessReader(tx)),
    lockCandidate: (userId) => rows.lockCandidate(userId),
    isMuted: (userId, source) => notificationPreferenceRows(tx).isMuted(userId, source),
    claimDay: (userId, day) => rows.claimDay(userId, day),
    unread: (userId, limit) => rows.unread(userId, limit),
    insertSummary: (row) => rows.insertSummary(row),
    sealedWorkspace: (workspaceId) => rows.sealedWorkspace(workspaceId),
    deliverableSubscriptions: (userId) => pushSubscriptionRepository(tx).deliverableIdsForUser(userId),
    enqueuePush: (job) => boss.send(PUSH_SEND_JOB, job, { db: queueDb, singletonKey: `${job.notificationId}:${job.subscriptionId}` }),
  };
  if (start) ports.assistantSummary = { start: (userId, day, now) => start(tx, ports, userId, day, now) };
  return ports;
}

export function summaryUnitOfWork(db: Database, boss: Pick<PgBoss, 'send'>, start?: AssistantSummaryStart): SummaryUnitOfWork {
  return {
    candidates: () => morningSummaryRows(db).candidates(),
    run: (work) => db.transaction((tx) => work(summaryPorts(tx, boss, start))),
  };
}

/** Every 15 minutes: the morning summaries that are due now, in each person's own time zone. */
export async function registerMorningSummary(boss: PgBoss, db: Database, start?: AssistantSummaryStart) {
  const uow = summaryUnitOfWork(db, boss, start);
  await boss.work(MORNING_SUMMARY_JOB, async () => {
    const result = await sendMorningSummaries(uow);
    if (result.sent || result.empty || result.writing) console.log(JSON.stringify({ job: MORNING_SUMMARY_JOB, ...result }));
  });
  await boss.schedule(MORNING_SUMMARY_JOB, '*/15 * * * *');
}
