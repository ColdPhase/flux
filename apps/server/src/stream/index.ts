import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { EVENTS_CHANNEL, listen, schema } from '@flux/db';
import { audiencePageQuery, authorizeEvent, eventResource, isUuid, lastAudienceSeqQuery, type Database, type Principal } from '@flux/core';
import {
  STREAM_CLOSE_SLOW_CONSUMER,
  STREAM_CLOSE_UNAUTHENTICATED,
  STREAM_PATH,
  type ApiError,
  type StreamEvent,
  type StreamMessage,
} from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';
import { CursorCodec } from './cursor.js';

export interface StreamOptions {
  db: Database;
  sessions: SessionResolver;
  publicOrigin: string;
  connectionString: string;
  /** Ping, session revalidation and polling interval. */
  heartbeatMs: number;
  /** Server secret the opaque per-recipient cursors are derived from. */
  cursorSecret: string;
  /** Test only: serve `GET /api/v1/stream/work` with the caller's last open→ready work counters. */
  exposeWork?: boolean;
}

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

const BATCH = 200;
/** Close a client whose unsent data exceeds this, or whose send does not finish in time. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const SEND_TIMEOUT_MS = 30_000;

interface Accepted {
  headers: IncomingHttpHeaders;
  principal: Principal;
  sessionId: string;
  /** Position in this recipient's audience rows (an event seq); never sent to the client. */
  position: number;
  /** Position of the last event this recipient was sent or may see; the only position its cursors encode. */
  visible: number;
  work: StreamWork;
}

type EventRow = { id: string; seq: number; kind: string; workspaceId: string | null; objectId: string; createdAt: Date };

const eventColumns = {
  id: schema.events.id,
  seq: schema.events.seq,
  kind: schema.events.kind,
  workspaceId: schema.events.workspaceId,
  objectId: schema.events.objectId,
  createdAt: schema.events.createdAt,
};

function rejection(status: number, code: string, error: string): ApiError & { status: number } {
  return { status, code, error };
}

function recipientKey(principal: Principal) {
  return `${principal.kind}:${principal.id}`;
}

/**
 * One subscriber. Delivery is pull-based from this recipient's `event_audience` rows: a
 * wake-up (NOTIFY flux_events, a heartbeat tick or the initial replay) reads the rows
 * after the cursor in seq order by primary key, revalidates the session, re-authorizes
 * each event for this principal as the final check, and awaits each write, so a slow
 * reader slows only its own cursor. Events the recipient could not see have no rows here.
 */
class StreamConnection {
  private running = false;
  private dirty = false;
  private closed = false;
  private alive = true;
  private timer: NodeJS.Timeout | null = null;
  /** Work is counted for the initial replay only; later wake-ups come from unrelated NOTIFYs. */
  private counting = true;

  constructor(
    private readonly socket: WebSocket,
    private readonly accepted: Accepted,
    private readonly options: StreamOptions,
    private readonly log: FastifyInstance['log'],
    private readonly cursors: CursorCodec,
  ) {}

  private cursor() {
    return this.cursors.encode(recipientKey(this.accepted.principal), this.accepted.visible);
  }

  async start(onReady: (work: StreamWork) => void) {
    this.socket.on('pong', () => { this.alive = true; });
    this.socket.on('message', () => undefined);
    this.timer = setInterval(() => void this.tick(), this.options.heartbeatMs);
    await this.pump();
    if (this.closed) return;
    onReady({ ...this.accepted.work });
    await this.send({ type: 'ready', cursor: this.cursor() }).catch(() => this.close(1011, 'Send failed'));
  }

  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.socket.close(code, reason);
  }

  stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.closed) return;
    if (!this.alive) {
      this.stop();
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
    try {
      if (await this.revalidate()) await this.pump();
    } catch (error) {
      this.log.warn({ error }, 'Stream revalidation failed');
    }
  }

  /** The session must still exist and belong to the same person; otherwise close 4401. */
  private async revalidate() {
    const context = await this.options.sessions.resolveSession(this.accepted.headers);
    if (context && context.sessionId === this.accepted.sessionId && context.principal.id === this.accepted.principal.id) return true;
    this.close(STREAM_CLOSE_UNAUTHENTICATED, 'Session ended');
    return false;
  }

  async pump() {
    if (this.closed) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.dirty = false;
        await this.drain();
      } while (this.dirty && !this.closed);
    } catch (error) {
      this.log.error({ error }, 'Stream delivery failed');
      this.close(1011, 'Delivery failed');
    } finally {
      this.running = false;
    }
  }

  private async drain() {
    const { db } = this.options;
    const { work } = this.accepted;
    const count = this.counting;
    this.counting = false;
    for (;;) {
      const rows: EventRow[] = await audiencePageQuery(db, this.accepted.principal, this.accepted.position, BATCH);
      if (count) { work.queries += 1; work.rows += rows.length; }
      if (!rows.length || this.closed) return;
      if (!(await this.revalidate())) return;
      for (const row of rows) {
        if (this.closed) return;
        const resource = eventResource(row);
        if (count) work.authorizations += 1;
        // Final check: the row says the recipient could read the event when it was fanned
        // out; membership, grants and visibility are read again now.
        if (resource && await authorizeEvent(this.accepted.principal, row, db)) {
          // Revalidate right before each delivery: a revoked session gets nothing more.
          if (!(await this.revalidate())) return;
          this.accepted.visible = row.seq;
          const message: StreamEvent = {
            type: 'event', cursor: this.cursor(), id: row.id, kind: row.kind, workspaceId: row.workspaceId!,
            objectType: resource.type, objectId: row.objectId, createdAt: row.createdAt.toISOString(),
          };
          await this.send(message);
        }
        this.accepted.position = row.seq;
      }
      if (rows.length < BATCH) return;
    }
  }

  private send(message: StreamMessage) {
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(STREAM_CLOSE_SLOW_CONSUMER, 'Client too slow');
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close(STREAM_CLOSE_SLOW_CONSUMER, 'Client too slow');
        resolve();
      }, SEND_TIMEOUT_MS);
      this.socket.send(JSON.stringify(message), (error) => {
        clearTimeout(timeout);
        if (error && !this.closed) reject(error);
        else resolve();
      });
    });
  }
}

/**
 * `GET /api/v1/stream`: authenticated, policy-filtered event delivery over WebSocket.
 * Register `@fastify/websocket` on the root instance before this plugin.
 */
export async function streamRoutes(app: FastifyInstance, options: StreamOptions) {
  const { db, sessions, publicOrigin } = options;
  const cursors = new CursorCodec(options.cursorSecret);
  const accepted = new WeakMap<FastifyRequest, Accepted>();
  const connections = new Set<StreamConnection>();
  const lastWork = new Map<string, StreamWork>();
  const wakeAll = () => { for (const connection of connections) void connection.pump(); };
  // Audience rows commit with their event, so the event NOTIFY is the wake-up.
  const listener = listen(options.connectionString, EVENTS_CHANNEL, wakeAll, wakeAll, (error) => app.log.warn({ error }, 'Event listener interrupted'));
  app.addHook('onClose', async () => {
    await listener.close();
    for (const connection of connections) connection.close(1001, 'Server shutting down');
  });

  /**
   * Resolves `?cursor=`: absent starts after the recipient's last audience row, an opaque cursor issued to this
   * recipient resumes after its position, and an event id resumes after that event if the
   * caller may receive it. Raw sequence numbers are not accepted, so the log's size and
   * activity cannot be probed. The returned `visible` position depends only on events the
   * recipient may see, so cursors look the same whether or not invisible events happened.
   */
  async function resolveCursor(principal: Principal, value: string | undefined): Promise<Pick<Accepted, 'position' | 'visible' | 'work'> | ApiError & { status: number }> {
    const work: StreamWork = { queries: 0, rows: 0, authorizations: 0 };
    if (value === undefined || value === '') {
      // One primary-key lookup on this recipient's own rows: independent of anyone else's activity.
      const [head] = await lastAudienceSeqQuery(db, principal);
      work.queries += 1;
      work.rows += 1;
      const position = head?.seq ?? 0;
      return { position, visible: position, work };
    }
    const decoded = cursors.decode(recipientKey(principal), value);
    if (decoded !== null) return { position: decoded, visible: decoded, work };
    if (isUuid(value)) {
      const [event] = await db.select(eventColumns).from(schema.events).where(eq(schema.events.id, value));
      work.queries += 1;
      work.authorizations += 1;
      if (event && await authorizeEvent(principal, event, db)) return { position: event.seq, visible: event.seq, work: { ...work, rows: 1 } };
    }
    return rejection(400, 'CURSOR_INVALID', 'Cursor must be a cursor issued to you or an event id you can see');
  }

  app.get<{ Querystring: { cursor?: string } }>(STREAM_PATH, {
    websocket: true,
    preValidation: async (request, reply) => {
      // Browsers always send Origin on a WebSocket upgrade; only the public origin may use the cookie.
      if (request.headers.origin !== publicOrigin) {
        request.log.warn({ origin: request.headers.origin }, 'Rejected stream upgrade origin');
        return reply.code(403).send({ error: 'Forbidden', code: 'ORIGIN_REJECTED' } satisfies ApiError);
      }
      const context = await sessions.resolveSession(request.headers);
      if (!context) return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' } satisfies ApiError);
      const cursor = await resolveCursor(context.principal, typeof request.query.cursor === 'string' ? request.query.cursor : undefined);
      if ('status' in cursor) return reply.code(cursor.status).send({ error: cursor.error, code: cursor.code } satisfies ApiError);
      accepted.set(request, { headers: { cookie: request.headers.cookie }, principal: context.principal, sessionId: context.sessionId, ...cursor });
    },
  }, (socket, request) => {
    const state = accepted.get(request);
    if (!state) {
      socket.close(STREAM_CLOSE_UNAUTHENTICATED, 'Session ended');
      return;
    }
    const connection = new StreamConnection(socket, state, options, request.log, cursors);
    connections.add(connection);
    socket.on('close', () => {
      connection.stop();
      connections.delete(connection);
    });
    socket.on('error', (error) => request.log.warn({ error }, 'Stream socket error'));
    void connection.start((work) => { if (options.exposeWork) lastWork.set(recipientKey(state.principal), work); });
  });

  if (options.exposeWork) {
    app.get(`${STREAM_PATH}/work`, async (request, reply) => {
      const context = await sessions.resolveSession(request.headers);
      if (!context) return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' } satisfies ApiError);
      return { work: lastWork.get(recipientKey(context.principal)) ?? null };
    });
  }
}
