import { eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** Assignment deliveries recheck the typed event target; sent history is retained. */
export async function assignmentNotificationActive(db: DbExecutor, notification: { reason: string | null; eventId: string | null }) {
  if (notification.reason !== 'assigned' || !notification.eventId) return true;
  const [event] = await db.select({ data: schema.events.data }).from(schema.events).where(eq(schema.events.id, notification.eventId));
  const workId = (event?.data as { workId?: unknown } | undefined)?.workId;
  if (typeof workId !== 'string') return false;
  const [work] = await db.select({ reverted: schema.projectWorkItems.creationRevertedAt }).from(schema.projectWorkItems)
    .where(eq(schema.projectWorkItems.id, workId));
  return !!work && work.reverted === null;
}
