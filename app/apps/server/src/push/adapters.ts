import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { markAllNotificationsRead, notificationRows, pushSubscriptionRepository, schema, type DbExecutor } from '@flux/db';
import {
  DRAFT_SUMMARY_JOB,
  PUSH_SEND_JOB,
  createNotification,
  policySourceReader,
  visibleFilter,
  type Database,
  type JobQueue,
  type NotificationInput,
  type NotificationRepository,
  type NotificationUnitOfWork,
  type PushSubscriptionRepository,
} from '@flux/core';

// Adapters that connect the core notification/push use cases to Drizzle, pg-boss and the
// access policy (issue #46: core defines the ports, the server assembles them).

const n = schema.notifications;

/**
 * The inbox audience as one SQL condition over `notifications`: per workspace the recipient has
 * notifications in, the source must pass the policy's own list filter (`visibleFilter`) for
 * projects, drafts and direct messages, or the workspace itself must be readable. Applied before the limit and
 * in the unread count, so invisible rows never reach pages, counts or payloads.
 */
async function inboxAudience(db: DbExecutor, userId: string): Promise<SQL> {
  const principal = { id: userId, kind: 'human' as const };
  const rows = notificationRows(db);
  const reader = policySourceReader(db);
  const conditions: SQL[] = [];
  for (const workspaceId of await rows.workspaceIdsForRecipient(userId)) {
    const workspace = await reader.canRead(userId, { type: 'workspace', id: workspaceId });
    if (!workspace.visible) continue;
    const projects = await visibleFilter(principal, workspaceId, 'project', db);
    const drafts = await visibleFilter(principal, workspaceId, 'draft', db);
    const dms = await visibleFilter(principal, workspaceId, 'dm', db);
    const sources: SQL[] = [
      sql`(${n.sourceType} = 'project' AND EXISTS (SELECT 1 FROM ${schema.projects} WHERE ${schema.projects.id} = ${n.sourceId} AND ${projects}))`,
      sql`(${n.sourceType} = 'draft' AND EXISTS (SELECT 1 FROM ${schema.drafts} WHERE ${schema.drafts.id} = ${n.sourceId} AND ${drafts}))`,
      // Direct messages (#116): only while the recipient is a participant (#107).
      sql`(${n.sourceType} = 'dm' AND EXISTS (SELECT 1 FROM ${schema.dms} WHERE ${schema.dms.id} = ${n.sourceId} AND ${dms}))`,
    ];
    if (workspace.allowed) sources.push(sql`(${n.sourceType} = 'workspace' AND ${n.sourceId} = ${workspaceId})`);
    conditions.push(and(eq(n.workspaceId, workspaceId), or(...sources))!);
  }
  return conditions.length ? or(...conditions)! : sql`false`;
}

export function notificationRepository(db: DbExecutor): NotificationRepository {
  const rows = notificationRows(db);
  return {
    insert: (record) => rows.insert(record),
    findForRecipient: (userId, id) => rows.findForRecipient(userId, id),
    markRead: (userId, id) => rows.markRead(userId, id),
    markAllRead: (userId) => markAllNotificationsRead(db, userId),
    async listReadable(userId, limit) {
      const audience = await inboxAudience(db, userId);
      return { items: await rows.listForRecipient(userId, audience, limit), unread: await rows.countUnread(userId, audience) };
    },
  };
}

export function subscriptionRepository(db: DbExecutor): PushSubscriptionRepository {
  return pushSubscriptionRepository(db);
}

/** Queues jobs inside the given transaction, so they commit with the rows that describe them. */
export type QueueFactory = (tx: DbExecutor) => JobQueue;

export function pgBossQueue(boss: Pick<PgBoss, 'send'>): QueueFactory {
  return (tx) => {
    const db = fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql);
    return {
      enqueuePushSend: (job) => boss.send(PUSH_SEND_JOB, job, { db, singletonKey: `${job.notificationId}:${job.subscriptionId}` }),
      enqueueDraftSummary: (job) => boss.send(DRAFT_SUMMARY_JOB, job, { db }),
    };
  };
}

export function notificationUnitOfWork(db: Database, queue: (tx: DbExecutor) => Pick<JobQueue, 'enqueuePushSend'>): NotificationUnitOfWork {
  return {
    run: (work) => db.transaction((tx) => work({
      authorizer: policySourceReader(tx),
      notifications: notificationRepository(tx),
      subscriptions: pushSubscriptionRepository(tx),
      queue: queue(tx),
    })),
  };
}

/** For server code: `notify(input)` stores the inbox row and queues its push jobs. */
export function createNotifier(db: Database, boss: PgBoss) {
  const uow = notificationUnitOfWork(db, pgBossQueue(boss));
  return (input: NotificationInput) => createNotification(uow, input);
}
