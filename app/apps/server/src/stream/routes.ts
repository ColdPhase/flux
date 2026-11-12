import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS_CHANNEL, listen, RUN_TEXT_CHANNEL, streamAudienceRepository, type Database } from '@flux/db';
import { audienceKey, isUuid } from '@flux/core';
import { RUN_TEXT_PIECE_CHARS, STREAM_CLOSE_UNAUTHENTICATED, STREAM_PATH, type ApiError, type StreamRunText } from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';
import { StreamConnection } from './connection.js';
import { CursorCodec } from './cursor.js';
import { resolveCursor, type DeliverySources, type StreamWork, type Subscription } from './delivery.js';
import { workRoute } from './work-route.js';
import { forbidden, UNAUTHENTICATED } from '../http/errors.js';

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

const STEP = /^[a-z][a-z0-9_]{0,63}$/;

/** A worker's notice of `RUN_TEXT_CHANNEL`, exactly in its shape, as the message its owner's connections get; null for anything else. */
function runTextPiece(payload: string): { ownerUserId: string; message: StreamRunText } | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(payload) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.ownerUserId !== 'string' || !isUuid(value.ownerUserId) || typeof value.runId !== 'string' || !isUuid(value.runId)) return null;
  if (typeof value.step === 'string') return STEP.test(value.step) ? { ownerUserId: value.ownerUserId, message: { type: 'run_text', runId: value.runId, step: value.step } } : null;
  const { turn, at, text } = value;
  if (!Number.isSafeInteger(turn) || (turn as number) < 1 || !Number.isSafeInteger(at) || (at as number) < 0 || typeof text !== 'string' || text.length > RUN_TEXT_PIECE_CHARS) return null;
  return { ownerUserId: value.ownerUserId, message: { type: 'run_text', runId: value.runId, turn: turn as number, at: at as number, text } };
}

/**
 * `GET /api/v1/stream`: authenticated, policy-filtered event delivery over WebSocket.
 * Register `@fastify/websocket` on the root instance before this plugin.
 */
export async function streamRoutes(app: FastifyInstance, options: StreamOptions) {
  const { db, sessions, publicOrigin } = options;
  const sources: DeliverySources = { audience: streamAudienceRepository(db), db };
  const cursors = new CursorCodec(options.cursorSecret);
  const accepted = new WeakMap<FastifyRequest, Subscription>();
  const connections = new Set<StreamConnection>();
  const lastWork = new Map<string, StreamWork>();
  const wakeAll = () => { for (const connection of connections) void connection.pump(); };
  // Audience rows commit with their event, so the event NOTIFY is the wake-up.
  const listener = listen(options.connectionString, EVENTS_CHANNEL, wakeAll, wakeAll, (error) => app.log.warn({ error }, 'Event listener interrupted'));
  // The asker's live view of their own run (#1248): each piece goes to that person's open connections and nobody else's. It is not an
  // event: no row, no cursor, no replay; a connection that is not open misses it and reads the run's answer when it is done.
  const liveText = listen(options.connectionString, RUN_TEXT_CHANNEL, (payload) => {
    const piece = runTextPiece(payload);
    if (!piece) return;
    for (const connection of connections) if (connection.isPerson(piece.ownerUserId)) connection.sendLive(piece.message);
  }, () => undefined, (error) => app.log.warn({ error }, 'Run text listener interrupted'));
  app.addHook('onClose', async () => {
    await listener.close();
    await liveText.close();
    for (const connection of connections) connection.close(1001, 'Server shutting down');
  });

  app.get<{ Querystring: { cursor?: string } }>(STREAM_PATH, {
    websocket: true,
    preValidation: async (request, reply) => {
      // Browsers always send Origin on a WebSocket upgrade; only the public origin may use the cookie.
      if (request.headers.origin !== publicOrigin) {
        request.log.warn({ origin: request.headers.origin }, 'Rejected stream upgrade origin');
        return reply.code(403).send(forbidden('ORIGIN_REJECTED'));
      }
      const context = await sessions.resolveSession(request.headers);
      if (!context) return reply.code(401).send(UNAUTHENTICATED);
      const cursor = await resolveCursor(sources, cursors, context.principal, typeof request.query.cursor === 'string' ? request.query.cursor : undefined);
      if ('status' in cursor) return reply.code(cursor.status).send({ error: cursor.error, code: cursor.code } satisfies ApiError);
      accepted.set(request, { headers: { cookie: request.headers.cookie }, principal: context.principal, sessionId: context.sessionId, ...cursor });
    },
  }, (socket, request) => {
    const state = accepted.get(request);
    if (!state) {
      socket.close(STREAM_CLOSE_UNAUTHENTICATED, 'Session ended');
      return;
    }
    const connection = new StreamConnection(socket, state, { sources, sessions, cursors, heartbeatMs: options.heartbeatMs, log: request.log });
    connections.add(connection);
    socket.on('close', () => {
      connection.stop();
      connections.delete(connection);
    });
    socket.on('error', (error) => request.log.warn({ error }, 'Stream socket error'));
    void connection.start((work) => { if (options.exposeWork) lastWork.set(audienceKey(state.principal), work); });
  });

  if (options.exposeWork) workRoute(app, sessions, lastWork);
}
