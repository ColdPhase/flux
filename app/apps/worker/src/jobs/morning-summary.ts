import { fromDrizzle, type PgBoss } from 'pg-boss';
import { morningSummaryRows, notificationPreferenceRows, pushSubscriptionRepository, sql } from '@flux/db';
import { MORNING_SUMMARY_JOB, PUSH_SEND_JOB, policySourceReader, sendMorningSummaries, type Database, type SummaryUnitOfWork } from '@flux/core';

/** Drizzle rows, the access policy and pg-boss for the morning summary (#350); the rules are in core. */
export function summaryUnitOfWork(db: Database, boss: PgBoss): SummaryUnitOfWork {
  return {
    candidates: () => morningSummaryRows(db).candidates(),
    run: (work) => db.transaction((tx) => {
      const rows = morningSummaryRows(tx);
      // Push jobs are sent in the same transaction, so they commit with the claimed day.
      const queueDb = fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql);
      return work({
        authorizer: policySourceReader(tx),
        lockCandidate: (userId) => rows.lockCandidate(userId),
        isMuted: (userId, source) => notificationPreferenceRows(tx).isMuted(userId, source),
        claimDay: (userId, day) => rows.claimDay(userId, day),
        unread: (userId, limit) => rows.unread(userId, limit),
        insertSummary: (row) => rows.insertSummary(row),
        deliverableSubscriptions: (userId) => pushSubscriptionRepository(tx).deliverableIdsForUser(userId),
        enqueuePush: (job) => boss.send(PUSH_SEND_JOB, job, { db: queueDb, singletonKey: `${job.notificationId}:${job.subscriptionId}` }),
      });
    }),
  };
}

/** Every 15 minutes: the morning summaries that are due now, in each person's own time zone. */
export async function registerMorningSummary(boss: PgBoss, db: Database) {
  const uow = summaryUnitOfWork(db, boss);
  await boss.work(MORNING_SUMMARY_JOB, async () => {
    const result = await sendMorningSummaries(uow);
    if (result.sent || result.empty) console.log(JSON.stringify({ job: MORNING_SUMMARY_JOB, ...result }));
  });
  await boss.schedule(MORNING_SUMMARY_JOB, '*/15 * * * *');
}
