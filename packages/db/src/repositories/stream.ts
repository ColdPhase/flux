import { and, asc, eq, gt, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for the stream's reads (issues #29, #46). It satisfies
 * `StreamAudienceRepository` in `packages/core/src/stream-audience.ts` structurally (this
 * package does not depend on core) and makes no access decisions: the stream still calls
 * `authorizeEvent` for each row it delivers. `recipient` is core's `audienceKey`.
 */

const eventColumns = {
  id: schema.events.id,
  seq: schema.events.seq,
  kind: schema.events.kind,
  workspaceId: schema.events.workspaceId,
  objectId: schema.events.objectId,
  createdAt: schema.events.createdAt,
};

/** Query: the recipient's last audience position (one primary-key lookup), or 0. */
export function lastAudienceSeqQuery(db: DbExecutor, recipient: string) {
  return db.select({ seq: sql<number>`coalesce(max(${schema.eventAudience.seq}), 0)`.mapWith(Number) })
    .from(schema.eventAudience).where(eq(schema.eventAudience.recipient, recipient));
}

/** Query: the recipient's next `limit` audience rows after `after`, joined to their events, in seq order. */
export function audiencePageQuery(db: DbExecutor, recipient: string, after: number, limit: number) {
  return db.select({
    id: schema.events.id, seq: schema.eventAudience.seq, kind: schema.events.kind,
    workspaceId: schema.events.workspaceId, objectId: schema.events.objectId, createdAt: schema.events.createdAt,
  }).from(schema.eventAudience)
    .innerJoin(schema.events, eq(schema.events.id, schema.eventAudience.eventId))
    .where(and(eq(schema.eventAudience.recipient, recipient), gt(schema.eventAudience.seq, after)))
    .orderBy(asc(schema.eventAudience.seq)).limit(limit);
}

export function streamAudienceRepository(db: DbExecutor) {
  return {
    async lastSeq(recipient: string) {
      const [head] = await lastAudienceSeqQuery(db, recipient);
      return head?.seq ?? 0;
    },
    page(recipient: string, afterSeq: number, limit: number) {
      return audiencePageQuery(db, recipient, afterSeq, limit);
    },
    async eventById(id: string) {
      const [event] = await db.select(eventColumns).from(schema.events).where(eq(schema.events.id, id));
      return event ?? null;
    },
  };
}
