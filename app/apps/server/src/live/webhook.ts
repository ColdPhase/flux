import { TextDecoder } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { Pool } from 'pg';

const MAX_BODY_BYTES = 64 * 1024;
// The pinned self-hosted SFU emits EV_ IDs. Older webhook fixtures and some
// SDK examples use UUIDs, so accept both signed, bounded forms.
const EVENT_ID = /^(?:EV_[A-Za-z0-9_-]{8,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ROOM_ID = /^live_[A-Za-z0-9_-]{32}$/;
const PRESENCE_EVENTS = new Set([
  'participant_joined', 'participant_left', 'participant_connection_aborted',
  'room_started', 'room_finished',
]);

export const LIVEKIT_WEBHOOK_PATH = '/api/v1/internal/livekit/webhook';

export interface LiveWebhookOptions {
  pool: Pool;
  apiKey: string;
  apiSecret: string;
  /** A webhook is only a hint. The reconciler must recheck the current generation and SFU. */
  requestReconcile(sessionId: string, generation: number): Promise<void>;
  /**
   * Reconciliation hint for media admissions (#128): a participant joined this room. The
   * signaling gate is the admission boundary; this only catches what a restart missed.
   */
  reconcileAdmissions?(roomId: string): Promise<void>;
}

/** Raw-body signature verification precedes every use of an untrusted event field. */
export const liveWebhookRoutes: FastifyPluginAsync<LiveWebhookOptions> = async (app, options) => {
  const receiver = new WebhookReceiver(options.apiKey, options.apiSecret);
  app.addContentTypeParser('application/webhook+json', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
    (_request, body, done) => done(null, body));

  app.post(LIVEKIT_WEBHOOK_PATH, { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(415).send();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization) return reply.code(401).send();

    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(request.body); }
    catch { return reply.code(400).send(); }

    let event;
    try { event = await receiver.receive(body, authorization); }
    catch { return reply.code(401).send(); }

    if (!PRESENCE_EVENTS.has(event.event)) return reply.code(204).send();
    const roomId = event.room?.name;
    if (!EVENT_ID.test(event.id) || typeof roomId !== 'string' || !ROOM_ID.test(roomId))
      return reply.code(400).send();

    // The insert binds a verified event to the session's CURRENT room generation.
    // Old-room events cannot change a replacement generation after revocation.
    const inserted = await options.pool.query<{ session_id: string; generation: number }>(`
      INSERT INTO live_webhook_events (event_id, session_id, generation, room_id)
      SELECT $1::text, id, generation, room_id FROM live_sessions
      WHERE room_id = $2 AND state = 'available'
      ON CONFLICT (event_id) DO NOTHING
      RETURNING session_id, generation`, [event.id, roomId]);
    const mapped = inserted.rows[0];
    if (!mapped) return reply.code(204).send();
    if (event.event === 'participant_joined' && options.reconcileAdmissions)
      void options.reconcileAdmissions(roomId).catch((error: unknown) =>
        app.log.warn({ error, sessionId: mapped.session_id }, 'Live admission reconciliation pending'));

    try { await options.requestReconcile(mapped.session_id, mapped.generation); }
    catch (error) {
      app.log.warn({ error, sessionId: mapped.session_id }, 'Live webhook reconciliation pending');
      // Let LiveKit retry a transient failure. A crash between the insert and
      // this cleanup is covered by the independent periodic reconciliation pass.
      await options.pool.query('DELETE FROM live_webhook_events WHERE event_id = $1::text', [event.id]);
      return reply.code(503).send();
    }
    return reply.code(204).send();
  });
};
