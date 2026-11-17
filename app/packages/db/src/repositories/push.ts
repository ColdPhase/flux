import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { removedName } from '@flux/contracts';
import { assignmentNotificationActive, assignmentNotificationsReverted } from './notification-lifecycle.js';
import * as schema from '../schema.js';
import { hiddenNotice, notificationHiddenWhileAiOff } from './space-ai.js';

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
    ...(row.answer ? { answer: true } : {}),
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
    /**
     * Inserts the subscription, or moves the endpoint's row to these values. An endpoint another account holds moves only when the same
     * browser keys (`p256dh` and `auth`) come with it (#1347): the endpoint alone is a URL anyone who saw it could name, and the keys are what
     * only that browser has. Null when the row is another account's and the keys differ.
     */
    async upsertByEndpoint(id: string, values: Omit<typeof s.$inferInsert, 'id'>) {
      const [row] = await db.insert(s).values({ id, ...values })
        .onConflictDoUpdate({ target: s.endpoint, set: { ...values, updatedAt: new Date(), lastFailureAt: null, lastFailureStatus: null },
          setWhere: sql`${s.userId} = ${values.userId} OR (${s.p256dh} = ${values.p256dh} AND ${s.auth} = ${values.auth})` })
        .returning();
      return row ? { record: toSubscriptionRecord(row), created: row.id === id } : null;
    },
    async deleteForUser(userId: string, id: string) {
      return (await db.delete(s).where(and(eq(s.id, id), eq(s.userId, userId))).returning({ id: s.id })).length > 0;
    },
    async deliverableIdsForUser(userId: string) {
      return (await db.select({ id: s.id }).from(s).where(and(eq(s.userId, userId), activeSession(s.sessionId)))).map((row) => row.id);
    },
  };
}

type Sender = { kind: 'human' | 'agent'; id: string; name: string };

/**
 * Who each of a page of notifications comes from, read together (#1243, #1424): the one its title names, as the generator recorded it
 * (`from_actor`, personas-28: a question reaching someone who joined later comes from its asker, not from the joiner), else the actor of the
 * event it was made from; with the id the Inbox draws a face from. Three reads however long the page; a notification made directly, or whose
 * sender is gone, has none.
 */
async function sendersOf(db: DbExecutor, rows: readonly Pick<NotificationRow, 'id' | 'eventId' | 'fromActor' | 'workspaceId'>[]): Promise<Map<string, Sender>> {
  const found = new Map<string, Sender>();
  const eventIds = [...new Set(rows.flatMap((row) => !row.fromActor && row.eventId ? [row.eventId] : []))];
  const actorOf = new Map(eventIds.length ? (await db.select({ id: schema.events.id, actorId: schema.events.actorId }).from(schema.events)
    .where(inArray(schema.events.id, eventIds))).map((event) => [event.id, event.actorId]) : []);
  const actors = rows.flatMap((row) => {
    const principal = row.fromActor ?? (row.eventId ? actorOf.get(row.eventId) : undefined);
    return principal ? [{ row: row.id, workspaceId: row.workspaceId, kind: principal.slice(0, principal.indexOf(':')), id: principal.slice(principal.indexOf(':') + 1) }] : [];
  });
  if (!actors.length) return found;
  const humans = [...new Set(actors.filter((actor) => actor.kind === 'human' && actor.id).map((actor) => actor.id))];
  // An agent with its id, so the answer gives it its colour (#1528).
  const agents = [...new Set(actors.filter((actor) => actor.kind === 'agent' && /^[0-9a-f-]{36}$/i.test(actor.id)).map((actor) => actor.id))];
  const userNames = new Map(humans.length ? (await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, humans))).map((row) => [row.id, row.name]) : []);
  const agentNames = new Map(agents.length ? (await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agents))).map((row) => [row.id, row.name]) : []);
  // Someone who left the notification's company or was removed, and has not come back, is "Stefan Kowal (removed)" (founder decision, Hubert,
  // 2026-11-17, #1424), as the conversation it came from names them; the same rule as `formerMembers`.
  const spaces = [...new Set(actors.filter((actor) => actor.kind === 'human').map((actor) => actor.workspaceId))];
  const gone = humans.length && spaces.length ? new Set(((await db.execute(sql`SELECT w.id::text AS workspace_id, r.user_id FROM workspaces w
    JOIN workspace_removed_people r ON r.workspace_id = w.id OR r.workspace_id = w.company_workspace_id
    WHERE w.id = ANY(${sql.param(spaces)}::uuid[]) AND r.user_id = ANY(${sql.param(humans)}::text[])`)).rows as { workspace_id: string; user_id: string }[])
    .map((row) => `${row.workspace_id}:${row.user_id}`)) : new Set<string>();
  for (const actor of actors) {
    const name = actor.kind === 'human' ? userNames.get(actor.id) : actor.kind === 'agent' ? agentNames.get(actor.id) : undefined;
    if (name && (actor.kind === 'human' || actor.kind === 'agent'))
      found.set(actor.row, { kind: actor.kind, id: actor.id, name: actor.kind === 'human' && gone.has(`${actor.workspaceId}:${actor.id}`) ? removedName(name) : name });
  }
  return found;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The task each of a page of `assigned` notifications gave its recipient (#1424 C), by notification id: the event it was made from named
 * the recipient as `assignedTo`. One read however long the page; "waiting for you" and "can continue" notifications are absent.
 */
async function givenTasks(db: DbExecutor, rows: readonly Pick<NotificationRow, 'id' | 'userId' | 'reason' | 'eventId'>[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const eventIds = [...new Set(rows.flatMap((row) => row.reason === 'assigned' && row.eventId ? [row.eventId] : []))];
  if (!eventIds.length) return found;
  const data = new Map((await db.select({ id: schema.events.id, data: schema.events.data }).from(schema.events).where(inArray(schema.events.id, eventIds)))
    .map((event) => [event.id, event.data as { workId?: unknown; assignedTo?: unknown } | null]));
  for (const row of rows) {
    const event = row.reason === 'assigned' && row.eventId ? data.get(row.eventId) : undefined;
    if (event && event.assignedTo === row.userId && typeof event.workId === 'string' && UUID.test(event.workId)) found.set(row.id, event.workId.toLowerCase());
  }
  return found;
}

/** Notification rows; `audience` is an access-policy condition over `notifications` supplied by the caller. */
export function notificationRows(db: DbExecutor) {
  const withHistory = (reverted: ReadonlySet<string>) => (row: { notification: NotificationRow }) => {
    const record = toNotificationRecord(row.notification);
    return row.notification.eventId && reverted.has(row.notification.eventId)
      ? { ...record, body: `${record.body}${record.body ? ' · ' : ''}Task creation undone` } : record;
  };
  /** One page of rows with the undone-creation line, reading the tasks they point at together rather than one by one (#828). */
  const withHistories = async (rows: { notification: NotificationRow }[]) =>
    rows.map(withHistory(await assignmentNotificationsReverted(db, rows.map((row) => row.notification))));
  return {
    async insert(record: { id: string; userId: string; source: { workspaceId: string; type: NotificationRow['sourceType']; id: string }; title: string; body: string; url: string | null; aiOrigin: boolean }) {
      await db.insert(n).values({
        id: record.id, userId: record.userId, workspaceId: record.source.workspaceId, sourceType: record.source.type,
        sourceId: record.source.id, title: record.title, body: record.body, url: record.url, aiOrigin: record.aiOrigin,
      });
    },
    async findForRecipient(userId: string, id: string) {
      const [row] = await db.select({ notification: n }).from(n)
        .where(and(eq(n.id, id), eq(n.userId, userId), sql`NOT ${hiddenNotice(n)}`));
      if (!row) return null;
      return { ...(await withHistories([row]))[0]!, from: (await sendersOf(db, [row.notification])).get(row.notification.id) ?? null };
    },
    async workspaceIdsForRecipient(userId: string) {
      return (await db.selectDistinct({ id: n.workspaceId }).from(n).where(eq(n.userId, userId))).map((row) => row.id);
    },
    /** `from`: also who each row comes from (the Inbox's "Kind · who · space", #1424); the notifications list does not ask for it. */
    async listForRecipient(userId: string, audience: SQL, limit: number, options: { from?: boolean } = {}) {
      // Rows kept only for push or email (the person turned the inbox off for that reason) stay out.
      const rows = await db.select({ notification: n }).from(n)
        .where(and(eq(n.userId, userId), eq(n.inInbox, true), audience, sql`NOT ${hiddenNotice(n)}`))
        .orderBy(desc(n.createdAt), desc(n.id)).limit(limit);
      const records = await withHistories(rows);
      if (!options.from) return records;
      const senders = await sendersOf(db, rows.map((row) => row.notification));
      const given = await givenTasks(db, rows.map((row) => row.notification));
      return records.map((record, at) => {
        const id = rows[at]!.notification.id;
        const from = senders.get(id);
        const task = given.get(id);
        return { ...record, ...(from ? { from } : {}), ...(task ? { given: task } : {}) };
      });
    },
    /**
     * The notifications that can be items of the Inbox's "Needs you" queue (#342), newest first, however many other notifications are newer
     * (an ordinary message never pushes a question out): mentions and invitations since `since` that are unread or in `keep` (done today),
     * questions since `since` read or not (an agent question finds the notification that announced it), and `assigned` ones that are unread or
     * in `keep`. With each unread `assigned` one come the read ones that gave the same task later (the newest gives the item). Read from the
     * partial index `notifications_needs_idx` (migration 0094), which holds only these four reasons, with who each row comes from and its task.
     */
    async listNeeds(userId: string, audience: SQL, options: { since: Date; keep: readonly string[]; limit: number }) {
      const keep = options.keep.filter((id) => UUID.test(id));
      const kept = keep.length ? sql`${n.id} = ANY(${sql.param(keep)}::uuid[])` : sql`false`;
      // The index's own predicate, written as it is there, so the planner reads the index whatever the parameters.
      const wanted = and(eq(n.userId, userId), sql`${n.inInbox} AND ${n.reason} IN ('mention', 'question', 'invitation', 'assigned')`, audience,
        sql`NOT ${hiddenNotice(n)}`);
      const rows = await db.select({ notification: n }).from(n)
        .where(and(wanted, sql`((${n.reason} IN ('mention', 'question', 'invitation') AND ${n.createdAt} >= ${options.since}
          AND (${n.readAt} IS NULL OR ${n.reason} = 'question' OR ${kept})) OR (${n.reason} = 'assigned' AND (${n.readAt} IS NULL OR ${kept})))`))
        .orderBy(desc(n.createdAt), desc(n.id)).limit(options.limit);
      const given = await givenTasks(db, rows.map((row) => row.notification));
      const open = rows.filter((row) => !row.notification.readAt && given.has(row.notification.id));
      if (open.length) {
        const tasks = [...new Set(open.map((row) => given.get(row.notification.id)!))];
        const oldest = open.reduce((least, row) => (row.notification.createdAt < least ? row.notification.createdAt : least), open[0]!.notification.createdAt);
        const listed = rows.map((row) => row.notification.id);
        const e = schema.events;
        const later = await db.select({ notification: n, workId: sql<string>`lower(${e.data}->>'workId')` }).from(n).innerJoin(e, eq(e.id, n.eventId))
          .where(and(wanted, eq(n.reason, 'assigned'), sql`${n.readAt} IS NOT NULL`, sql`${n.createdAt} > ${oldest}`,
            sql`NOT (${n.id} = ANY(${sql.param(listed)}::uuid[]))`, sql`lower(${e.data}->>'workId') = ANY(${sql.param(tasks)}::text[])`,
            sql`${e.data}->>'assignedTo' = ${userId}`))
          .orderBy(desc(n.createdAt), desc(n.id)).limit(options.limit);
        for (const row of later) given.set(row.notification.id, row.workId);
        rows.push(...later.map((row) => ({ notification: row.notification })));
        rows.sort((a, b) => b.notification.createdAt.getTime() - a.notification.createdAt.getTime() || b.notification.id.localeCompare(a.notification.id));
      }
      const records = await withHistories(rows);
      const senders = await sendersOf(db, rows.map((row) => row.notification));
      return records.map((record, at) => {
        const id = rows[at]!.notification.id;
        const from = senders.get(id);
        const task = given.get(id);
        return { ...record, ...(from ? { from } : {}), ...(task ? { given: task } : {}) };
      });
    },
    /** Of the recipient's newest `limit` notifications in their Inbox, the unread ones: why each exists and its link (#1243 `notifying`). */
    async unreadAmongNewest(userId: string, audience: SQL, limit: number) {
      const rows = await db.select({ reason: n.reason, url: n.url, readAt: n.readAt }).from(n)
        .where(and(eq(n.userId, userId), eq(n.inInbox, true), audience, sql`NOT ${hiddenNotice(n)}`))
        .orderBy(desc(n.createdAt), desc(n.id)).limit(limit);
      return rows.filter((row) => !row.readAt).map((row) => ({ reason: row.reason, url: row.url }));
    },
    async countUnread(userId: string, audience: SQL) {
      const [row] = await db.select({ unread: count() }).from(n).where(and(eq(n.userId, userId), eq(n.inInbox, true), isNull(n.readAt), audience,
        sql`NOT ${hiddenNotice(n)}`));
      return row?.unread ?? 0;
    },
    async markRead(userId: string, id: string) {
      const [row] = await db.update(n).set({ readAt: sql`coalesce(${n.readAt}, now())` })
        .where(and(eq(n.id, id), eq(n.userId, userId), sql`NOT ${hiddenNotice(n)}`)).returning({ readAt: n.readAt });
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
      if (!row || !(await assignmentNotificationActive(db, row.notification))) return null;
      // F-029: an AI-origin notification of a workspace whose AI is off is not pushed, even one created before.
      if (await notificationHiddenWhileAiOff(db, row.notification.id)) return null;
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
