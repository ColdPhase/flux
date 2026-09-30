import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema.js';

/**
 * Drizzle persistence adapters for notifications and Web Push (issues #41, #46). They satisfy
 * the ports declared in `packages/core/src/push/ports.ts` structurally (this package does not
 * depend on core); the server and worker compose them with the access policy and the queue.
 * They make no access decisions themselves.
 */
export type DbExecutor = Pick<NodePgDatabase<typeof schema>, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'execute'>;

type SubscriptionRow = typeof schema.pushSubscriptions.$inferSelect;
type NotificationRow = typeof schema.notifications.$inferSelect;
const s = schema.pushSubscriptions;
const n = schema.notifications;

export function toSubscriptionRecord(row: SubscriptionRow) {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    expirationTime: row.expirationTime,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureStatus: row.lastFailureStatus,
  };
}

export function toNotificationRecord(row: NotificationRow) {
  return {
    id: row.id,
    userId: row.userId,
    source: { workspaceId: row.workspaceId, type: row.sourceType, id: row.sourceId },
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.createdAt,
    readAt: row.readAt,
    reason: row.reason ?? null,
  };
}

/** A session that still exists (not signed out or revoked) and has not expired. */
const activeSession = (sessionId: SQL | typeof s.sessionId) =>
  sql`EXISTS (SELECT 1 FROM ${schema.authSessions} WHERE ${schema.authSessions.id} = ${sessionId} AND ${schema.authSessions.expiresAt} > now())`;

export function pushSubscriptionRepository(db: DbExecutor) {
  return {
    async listForUser(userId: string) {
      return (await db.select().from(s).where(eq(s.userId, userId)).orderBy(s.createdAt)).map(toSubscriptionRecord);
    },
    async countForUser(userId: string) {
      const [row] = await db.select({ total: count() }).from(s).where(eq(s.userId, userId));
      return row?.total ?? 0;
    },
    async endpointExists(endpoint: string) {
      return (await db.select({ id: s.id }).from(s).where(eq(s.endpoint, endpoint))).length > 0;
    },
    async upsertByEndpoint(id: string, values: Omit<typeof s.$inferInsert, 'id'>) {
      const [row] = await db.insert(s).values({ id, ...values })
        .onConflictDoUpdate({ target: s.endpoint, set: { ...values, updatedAt: new Date(), lastFailureAt: null, lastFailureStatus: null } })
        .returning();
      return { record: toSubscriptionRecord(row!), created: row!.id === id };
    },
    async deleteForUser(userId: string, id: string) {
      return (await db.delete(s).where(and(eq(s.id, id), eq(s.userId, userId))).returning({ id: s.id })).length > 0;
    },
    async deliverableIdsForUser(userId: string) {
      return (await db.select({ id: s.id }).from(s).where(and(eq(s.userId, userId), activeSession(s.sessionId)))).map((row) => row.id);
    },
  };
}

/** Notification rows; `audience` is an access-policy condition over `notifications` supplied by the caller. */
export function notificationRows(db: DbExecutor) {
  return {
    async insert(record: { id: string; userId: string; source: { workspaceId: string; type: NotificationRow['sourceType']; id: string }; title: string; body: string; url: string | null }) {
      await db.insert(n).values({
        id: record.id, userId: record.userId, workspaceId: record.source.workspaceId, sourceType: record.source.type,
        sourceId: record.source.id, title: record.title, body: record.body, url: record.url,
      });
    },
    async findForRecipient(userId: string, id: string) {
      const [row] = await db.select().from(n).where(and(eq(n.id, id), eq(n.userId, userId)));
      return row ? toNotificationRecord(row) : null;
    },
    async workspaceIdsForRecipient(userId: string) {
      return (await db.selectDistinct({ id: n.workspaceId }).from(n).where(eq(n.userId, userId))).map((row) => row.id);
    },
    async listForRecipient(userId: string, audience: SQL, limit: number) {
      // Rows kept only for push or email (the person turned the inbox off for that reason) stay out.
      const rows = await db.select().from(n).where(and(eq(n.userId, userId), eq(n.inInbox, true), audience))
        .orderBy(desc(n.createdAt), desc(n.id)).limit(limit);
      return rows.map(toNotificationRecord);
    },
    async countUnread(userId: string, audience: SQL) {
      const [row] = await db.select({ unread: count() }).from(n).where(and(eq(n.userId, userId), eq(n.inInbox, true), isNull(n.readAt), audience));
      return row?.unread ?? 0;
    },
    async markRead(userId: string, id: string) {
      const [row] = await db.update(n).set({ readAt: sql`coalesce(${n.readAt}, now())` })
        .where(and(eq(n.id, id), eq(n.userId, userId))).returning({ readAt: n.readAt });
      return row?.readAt ?? null;
    },
  };
}

/** What the push worker reads and records per job. */
export function pushDeliveryRepository(db: DbExecutor) {
  return {
    async findTarget(job: { notificationId: string; subscriptionId: string; userId: string }) {
      const [row] = await db.select({
        subscription: s,
        notification: n,
        sessionActive: sql<boolean>`${schema.authSessions.id} IS NOT NULL AND ${schema.authSessions.expiresAt} > now()`.mapWith(Boolean),
      }).from(s)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, s.userId))
        .innerJoin(n, and(eq(n.id, job.notificationId), eq(n.userId, s.userId)))
        .leftJoin(schema.authSessions, and(eq(schema.authSessions.id, s.sessionId), eq(schema.authSessions.userId, s.userId)))
        .where(and(eq(s.id, job.subscriptionId), eq(s.userId, job.userId)));
      if (!row) return null;
      return { subscription: toSubscriptionRecord(row.subscription), notification: toNotificationRecord(row.notification), sessionActive: row.sessionActive };
    },
    async deleteSubscription(id: string) {
      await db.delete(s).where(eq(s.id, id));
    },
    async recordSuccess(id: string) {
      await db.update(s).set({ lastSuccessAt: sql`now()`, lastFailureAt: null, lastFailureStatus: null }).where(eq(s.id, id));
    },
    async recordFailure(id: string, status: number | null) {
      await db.update(s).set({ lastFailureAt: new Date(), lastFailureStatus: status }).where(eq(s.id, id));
    },
  };
}
