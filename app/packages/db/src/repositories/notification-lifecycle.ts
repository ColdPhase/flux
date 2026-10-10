import { eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { taskGraphRows } from './task-graph.js';
import type { createDatabase } from '../index.js';

async function assignmentWork(db: DbExecutor, notification: { reason: string | null; eventId: string | null }) {
  if (notification.reason !== 'assigned' || !notification.eventId) return null;
  const [event] = await db.select({ data: schema.events.data }).from(schema.events).where(eq(schema.events.id, notification.eventId));
  const workId = (event?.data as { workId?: unknown } | undefined)?.workId;
  if (typeof workId !== 'string') return null;
  const [work] = await db.select({ reverted: schema.projectWorkItems.creationRevertedAt }).from(schema.projectWorkItems)
    .where(eq(schema.projectWorkItems.id, workId));
  return work ?? null;
}

/** Assignment deliveries recheck the typed event target; sent history is retained. */
export async function assignmentNotificationActive(db: DbExecutor, notification: { reason: string | null; eventId: string | null }) {
  if (notification.reason !== 'assigned') return true;
  const work = await assignmentWork(db, notification);
  return !!work && work.reverted === null;
}

/** A missing/unknown target is never presented as a known creation reversion. */
export async function assignmentNotificationReverted(db: DbExecutor, notification: { reason: string | null; eventId: string | null }) {
  const work = await assignmentWork(db, notification);
  return !!work?.reverted;
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
