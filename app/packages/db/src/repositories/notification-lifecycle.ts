import { eq, inArray } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { taskGraphRows } from './task-graph.js';
import type { createDatabase } from '../index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The task each assignment notification points at, by event id: two reads for any number of notifications (a page of the Inbox, #828),
 * one for their events and one for the tasks those name. A notification that is not an assignment, has no event, or whose event names
 * no task that exists is absent.
 */
async function assignmentWorks(db: DbExecutor, notifications: readonly { reason: string | null; eventId: string | null }[]) {
  const works = new Map<string, { reverted: Date | null }>();
  const eventIds = [...new Set(notifications.flatMap((item) => item.reason === 'assigned' && item.eventId ? [item.eventId] : []))];
  if (!eventIds.length) return works;
  const events = await db.select({ id: schema.events.id, data: schema.events.data }).from(schema.events).where(inArray(schema.events.id, eventIds));
  const workOf = new Map<string, string>();
  for (const event of events) {
    const workId = (event.data as { workId?: unknown } | undefined)?.workId;
    if (typeof workId === 'string' && UUID.test(workId)) workOf.set(event.id, workId);
  }
  if (!workOf.size) return works;
  const rows = await db.select({ id: schema.projectWorkItems.id, reverted: schema.projectWorkItems.creationRevertedAt }).from(schema.projectWorkItems)
    .where(inArray(schema.projectWorkItems.id, [...new Set(workOf.values())]));
  const reverted = new Map(rows.map((row) => [row.id, row.reverted]));
  for (const [eventId, workId] of workOf) if (reverted.has(workId)) works.set(eventId, { reverted: reverted.get(workId) ?? null });
  return works;
}

/** Assignment deliveries recheck the typed event target; sent history is retained. */
export async function assignmentNotificationActive(db: DbExecutor, notification: { reason: string | null; eventId: string | null }) {
  if (notification.reason !== 'assigned') return true;
  const work = notification.eventId ? (await assignmentWorks(db, [notification])).get(notification.eventId) : undefined;
  return !!work && work.reverted === null;
}

/** The event ids, among these notifications', whose assignment target had its creation undone; two reads for the whole set (#828). */
export async function assignmentNotificationsReverted(db: DbExecutor, notifications: readonly { reason: string | null; eventId: string | null }[]) {
  const works = await assignmentWorks(db, notifications);
  return new Set([...works].flatMap(([eventId, work]) => work.reverted ? [eventId] : []));
}

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
/** The callback must synchronously initiate the concrete provider operation, with no preflight await. */
export async function assignmentDeliveryAdmission<T>(db: Database, notificationId: string, send: () => Promise<T>): Promise<
  { status: 'suppressed' } | { status: 'started'; response: T } | { status: 'unknown' }> {
  let initiated = false;
  let admitted: { response: Promise<T> } | null;
  try {
    admitted = await db.transaction(async (tx) => {
      const [notification] = await tx.select({ reason: schema.notifications.reason, eventId: schema.notifications.eventId })
        .from(schema.notifications).where(eq(schema.notifications.id, notificationId));
      if (!notification) return null;
      if (notification.reason === 'assigned') {
        if (!notification.eventId) return null;
        const [event] = await tx.select({ data: schema.events.data }).from(schema.events).where(eq(schema.events.id, notification.eventId));
        const workId = (event?.data as { workId?: unknown } | undefined)?.workId;
        if (typeof workId !== 'string') return null;
        const [located] = await tx.select({ projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems)
          .where(eq(schema.projectWorkItems.id, workId));
        if (!located) return null;
        await taskGraphRows(tx).lockTaskGraphs([located.projectId]);
        const [work] = await tx.select({ revertedAt: schema.projectWorkItems.creationRevertedAt }).from(schema.projectWorkItems)
          .where(eq(schema.projectWorkItems.id, workId)).for('share');
        if (!work || work.revertedAt) return null;
      }
      initiated = true;
      const response = send();
      // Observe immediately: response rejection can precede the SQL commit. Await only after release.
      void response.catch(() => undefined);
      return { response };
    });
  } catch (error) {
    if (initiated) return { status: 'unknown' };
    throw error;
  }
  if (!admitted) return { status: 'suppressed' };
  // A confirmed SQL transaction must not erase the concrete provider's exception. Only an
  // uncertain transaction after handoff is the typed unknown outcome; the caller owns transport failures.
  return { status: 'started', response: await admitted.response };
}
