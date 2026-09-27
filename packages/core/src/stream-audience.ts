import { principalKey } from './events.js';
import type { Principal } from './types.js';

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

/** An event as the stream reads it: identifiers and kind, never content. */
export interface StreamEventRow {
  id: string;
  seq: number;
  kind: string;
  workspaceId: string | null;
  objectId: string;
  createdAt: Date;
}

/**
 * Stream reads (issue #46). Core defines the port; `@flux/db` implements it with Drizzle
 * (`streamAudienceRepository`) and the server passes it in. `recipient` is an `audienceKey`.
 */
export interface StreamAudienceRepository {
  /** The recipient's last audience position (one primary-key lookup), or 0. */
  lastSeq(recipient: string): Promise<number>;
  /** The recipient's next `limit` audience rows after `afterSeq`, joined to their events, in seq order. */
  page(recipient: string, afterSeq: number, limit: number): Promise<StreamEventRow[]>;
  /** One event by id, whoever may read it; callers must authorize it. */
  eventById(id: string): Promise<StreamEventRow | null>;
}
