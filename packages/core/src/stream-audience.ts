import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import { principalKey } from './events.js';
import type { Executor, Principal } from './types.js';

/**
 * Per-recipient stream index (issue #29).
 *
 * `recordEvent` stores, in the writing transaction, one `event_audience` row for every
 * principal the access policy lets read the event at that moment (see `eventAudience`). Stream
 * connections then read only their own rows by primary key, so opening a stream,
 * finding its `ready` cursor and replaying after a cursor never touch, count or
 * authorize events the recipient could not see. Delivery still calls `authorizeEvent`
 * for each row as the final check, so a later revocation is honoured.
 */

/** The recipient key stored in `event_audience`. */
export function audienceKey(principal: Principal) {
  return principalKey(principal);
}

/** Query: the recipient's last audience position (one primary-key lookup), or 0. */
export function lastAudienceSeqQuery(db: Executor, principal: Principal) {
  return db.select({ seq: sql<number>`coalesce(max(${schema.eventAudience.seq}), 0)`.mapWith(Number) })
    .from(schema.eventAudience).where(eq(schema.eventAudience.recipient, audienceKey(principal)));
}

/** Query: the recipient's next `limit` audience rows after `after`, joined to their events, in seq order. */
export function audiencePageQuery(db: Executor, principal: Principal, after: number, limit: number) {
  return db.select({
    id: schema.events.id, seq: schema.eventAudience.seq, kind: schema.events.kind,
    workspaceId: schema.events.workspaceId, objectId: schema.events.objectId, createdAt: schema.events.createdAt,
  }).from(schema.eventAudience)
    .innerJoin(schema.events, eq(schema.events.id, schema.eventAudience.eventId))
    .where(and(eq(schema.eventAudience.recipient, audienceKey(principal)), gt(schema.eventAudience.seq, after)))
    .orderBy(asc(schema.eventAudience.seq)).limit(limit);
}
