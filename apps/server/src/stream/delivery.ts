import type { IncomingHttpHeaders } from 'node:http';
import { audienceKey, authorizeEvent, eventResource, isUuid, type Executor, type Principal, type StreamAudienceRepository } from '@flux/core';
import type { ApiError, StreamEvent, StreamMessage } from '@flux/contracts';
import type { CursorCodec } from './cursor.js';

/**
 * Database work one connection did from the upgrade until `ready`. Counted so tests can
 * show that it does not depend on events the recipient cannot see.
 */
export interface StreamWork {
  /** Stream queries against events / event_audience. */
  queries: number;
  /** Rows those queries returned to the stream. */
  rows: number;
  /** authorizeEvent calls. */
  authorizations: number;
}

/** An accepted upgrade: who is subscribed and where their delivery stands. */
export interface Subscription {
  headers: IncomingHttpHeaders;
  principal: Principal;
  sessionId: string;
  /** Position in this recipient's audience rows (an event seq); never sent to the client. */
  position: number;
  /** Position of the last event this recipient was sent or may see; the only position its cursors encode. */
  visible: number;
  work: StreamWork;
}

/** What delivery reads: the recipient's audience rows, and the policy's current rows for `authorizeEvent`. */
export interface DeliverySources {
  audience: StreamAudienceRepository;
  db: Executor;
}

/** The connection a drain writes to. */
export interface DeliveryTarget {
  readonly isClosed: boolean;
  /** False (and the connection closed) when the session ended. */
  revalidate(): Promise<boolean>;
  send(message: StreamMessage): Promise<void>;
  cursor(): string;
}

const BATCH = 200;

/**
 * Resolves `?cursor=`: absent starts after the recipient's last audience row, an opaque cursor issued to this
 * recipient resumes after its position, and an event id resumes after that event if the
 * caller may receive it. Raw sequence numbers are not accepted, so the log's size and
 * activity cannot be probed. The returned `visible` position depends only on events the
 * recipient may see, so cursors look the same whether or not invisible events happened.
 */
export async function resolveCursor(sources: DeliverySources, cursors: CursorCodec, principal: Principal, value: string | undefined): Promise<Pick<Subscription, 'position' | 'visible' | 'work'> | ApiError & { status: number }> {
  const work: StreamWork = { queries: 0, rows: 0, authorizations: 0 };
  if (value === undefined || value === '') {
    // One primary-key lookup on this recipient's own rows: independent of anyone else's activity.
    const position = await sources.audience.lastSeq(audienceKey(principal));
    work.queries += 1;
    work.rows += 1;
    return { position, visible: position, work };
  }
  const decoded = cursors.decode(audienceKey(principal), value);
  if (decoded !== null) return { position: decoded, visible: decoded, work };
  if (isUuid(value)) {
    const event = await sources.audience.eventById(value);
    work.queries += 1;
    work.authorizations += 1;
    if (event && await authorizeEvent(principal, event, sources.db)) return { position: event.seq, visible: event.seq, work: { ...work, rows: 1 } };
  }
  return { status: 400, code: 'CURSOR_INVALID', error: 'Cursor must be a cursor issued to you or an event id you can see' };
}

/**
 * Delivers the recipient's audience rows after `subscription.position` in seq order, a batch
 * at a time. Each event is re-authorized for this principal as the final check and the
 * session is revalidated before each send; `count` adds this drain's work to the subscription.
 */
export async function drain(sources: DeliverySources, subscription: Subscription, target: DeliveryTarget, count: boolean) {
  const { work } = subscription;
  for (;;) {
    const rows = await sources.audience.page(audienceKey(subscription.principal), subscription.position, BATCH);
    if (count) { work.queries += 1; work.rows += rows.length; }
    if (!rows.length || target.isClosed) return;
    if (!(await target.revalidate())) return;
    for (const row of rows) {
      if (target.isClosed) return;
      const resource = eventResource(row);
      if (count) work.authorizations += 1;
      // Final check: the row says the recipient could read the event when it was fanned
      // out; membership, grants and visibility are read again now.
      if (resource && await authorizeEvent(subscription.principal, row, sources.db)) {
        // Revalidate right before each delivery: a revoked session gets nothing more.
        if (!(await target.revalidate())) return;
        subscription.visible = row.seq;
        const message: StreamEvent = {
          type: 'event', cursor: target.cursor(), id: row.id, kind: row.kind, workspaceId: row.workspaceId!,
          objectType: resource.type, objectId: row.objectId, createdAt: row.createdAt.toISOString(),
        };
        await target.send(message);
      }
      subscription.position = row.seq;
    }
    if (rows.length < BATCH) return;
  }
}
