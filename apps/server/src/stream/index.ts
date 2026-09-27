import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { EVENTS_CHANNEL, listen, schema } from '@flux/db';
import { authorizeEvent, eventResource, isUuid, type Database, type Principal } from '@flux/core';
import {
  STREAM_CLOSE_SLOW_CONSUMER,
  STREAM_CLOSE_UNAUTHENTICATED,
  STREAM_PATH,
  type ApiError,
  type StreamEvent,
  type StreamMessage,
} from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';

export interface StreamOptions {
  db: Database;
  sessions: SessionResolver;
  publicOrigin: string;
  connectionString: string;
  /** Ping, session revalidation and polling interval. */
  heartbeatMs: number;
}

const BATCH = 200;
/** Close a client whose unsent data exceeds this, or whose send does not finish in time. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const SEND_TIMEOUT_MS = 30_000;

interface Accepted {
  headers: IncomingHttpHeaders;
  principal: Principal;
  sessionId: string;
  cursor: number;
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

/**
 * One subscriber. Delivery is pull-based from the events table: a wake-up (NOTIFY, a
 * heartbeat tick or the initial replay) reads events after the cursor in seq order,
 * revalidates the session, filters each event through the access policy for this
 * principal, and awaits each write, so a slow reader slows only its own cursor.
 */
class StreamConnection {
  private running = false;
  private dirty = false;
  private closed = false;
  private alive = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly accepted: Accepted,
    private readonly options: StreamOptions,
    private readonly log: FastifyInstance['log'],
  ) {}

  async start() {
    this.socket.on('pong', () => { this.alive = true; });
    this.socket.on('message', () => undefined);
    this.timer = setInterval(() => void this.tick(), this.options.heartbeatMs);
    await this.pump();
    if (!this.closed) await this.send({ type: 'ready', cursor: this.accepted.cursor }).catch(() => this.close(1011, 'Send failed'));
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
    for (;;) {
      const rows: EventRow[] = await db.select(eventColumns).from(schema.events)
        .where(and(gt(schema.events.seq, this.accepted.cursor), isNotNull(schema.events.workspaceId)))
        .orderBy(asc(schema.events.seq)).limit(BATCH);
      if (!rows.length || this.closed) return;
      if (!(await this.revalidate())) return;
      for (const row of rows) {
        if (this.closed) return;
        const resource = eventResource(row);
        if (resource && await authorizeEvent(this.accepted.principal, row, db)) {
          // Revalidate right before each delivery: a revoked session gets nothing more.
          if (!(await this.revalidate())) return;
          const message: StreamEvent = {
            type: 'event', seq: row.seq, id: row.id, kind: row.kind, workspaceId: row.workspaceId!,
            objectType: resource.type, objectId: row.objectId, createdAt: row.createdAt.toISOString(),
          };
          await this.send(message);
        }
        this.accepted.cursor = row.seq;
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
  const accepted = new WeakMap<FastifyRequest, Accepted>();
  const connections = new Set<StreamConnection>();
  const wakeAll = () => { for (const connection of connections) void connection.pump(); };
  const listener = listen(options.connectionString, EVENTS_CHANNEL, wakeAll, wakeAll, (error) => app.log.warn({ error }, 'Event listener interrupted'));
  app.addHook('onClose', async () => {
    await listener.close();
    for (const connection of connections) connection.close(1001, 'Server shutting down');
  });

  async function resolveCursor(principal: Principal, value: string | undefined): Promise<number | ApiError & { status: number }> {
    const [head] = await db.select({ seq: sql<number>`coalesce(max(${schema.events.seq}), 0)`.mapWith(Number) }).from(schema.events);
    const latest = head?.seq ?? 0;
    if (value === undefined || value === '') return latest;
    if (/^[0-9]{1,15}$/.test(value)) {
      const cursor = Number(value);
      return cursor <= latest ? cursor : rejection(400, 'CURSOR_INVALID', 'Cursor is ahead of the event log');
    }
    if (isUuid(value)) {
      // An event id resolves only if the caller may receive that event.
      const [event] = await db.select(eventColumns).from(schema.events).where(eq(schema.events.id, value));
      if (event && await authorizeEvent(principal, event, db)) return event.seq;
    }
    return rejection(400, 'CURSOR_INVALID', 'Cursor must be an event seq or an event id you can see');
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
      if (typeof cursor !== 'number') return reply.code(cursor.status).send({ error: cursor.error, code: cursor.code } satisfies ApiError);
      accepted.set(request, { headers: { cookie: request.headers.cookie }, principal: context.principal, sessionId: context.sessionId, cursor });
    },
  }, (socket, request) => {
    const state = accepted.get(request);
    if (!state) {
      socket.close(STREAM_CLOSE_UNAUTHENTICATED, 'Session ended');
      return;
    }
    const connection = new StreamConnection(socket, state, options, request.log);
    connections.add(connection);
    socket.on('close', () => {
      connection.stop();
      connections.delete(connection);
    });
    socket.on('error', (error) => request.log.warn({ error }, 'Stream socket error'));
    void connection.start();
  });
}
