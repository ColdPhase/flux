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
    // Each set is built from the reader's own notifications of that kind in this workspace, then
    // passed through the policy's filter: an uncorrelated `IN (SELECT …)` that PostgreSQL decides
    // once per query and probes as a hash per row. Its size and estimate follow the reader's
    // notifications, never the workspace's projects, drafts or DMs (#298). As correlated EXISTS
    // the checks were costed once per notification and crossed jit_above_cost at about a thousand
    // of them; as sets of every readable draft they grew with the workspace.
    const own = (type: 'project' | 'draft' | 'dm') => sql`SELECT mine.source_id FROM notifications mine
      WHERE mine.user_id = ${userId} AND mine.workspace_id = ${workspaceId} AND mine.source_type = ${type}`;
    const sources: SQL[] = [
      sql`(${n.sourceType} = 'project' AND ${n.sourceId} IN (SELECT ${schema.projects.id} FROM ${schema.projects}
        WHERE ${schema.projects.id} IN (${own('project')}) AND ${projects}))`,
      sql`(${n.sourceType} = 'draft' AND ${n.sourceId} IN (SELECT ${schema.drafts.id} FROM ${schema.drafts}
        WHERE ${schema.drafts.id} IN (${own('draft')}) AND ${drafts}))`,
      // Direct messages (#116): only while the recipient is a participant (#107).
      sql`(${n.sourceType} = 'dm' AND ${n.sourceId} IN (SELECT ${schema.dms.id} FROM ${schema.dms}
        WHERE ${schema.dms.id} IN (${own('dm')}) AND ${dms}))`,
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
