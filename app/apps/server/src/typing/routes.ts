import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listen, typingNotifications } from '@flux/db';
import { TYPING_CHANNEL, type Database, type TypingActor, type TypingTaskDiscussion } from '@flux/core';
import { TYPING_PATH } from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';
import { typingAccess } from './access.js';
import { TypingConnection } from './connection.js';
import { TypingHub } from './hub.js';

interface TypingOptions { db: Database; sessions: SessionResolver; publicOrigin: string; connectionString: string; tasks?: TypingTaskDiscussion }
/** Same-origin human cookie WS, separate from the durable event cursor. */
export async function typingRoutes(app: FastifyInstance, options: TypingOptions) {
  const hub = new TypingHub(typingAccess(options.db, options.tasks), typingNotifications(options.db));
  const listener = listen(options.connectionString, TYPING_CHANNEL, (payload) => hub.notification(payload),
    () => hub.availability(true), () => hub.availability(false));
  const accepted = new WeakMap<FastifyRequest, { actor: TypingActor; release: () => void; transfer: () => void }>();
  const humans = new Map<string, number>();
  const reservations = new Set<() => void>();
  app.addHook('onClose', async () => {
    await hub.close(); await listener.close();
    for (const release of reservations) release();
  });
  app.get(TYPING_PATH, {
    websocket: true,
    preValidation: async (request, reply) => {
      if (request.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'Forbidden' });
      // Pending authentication consumes the same bounded admission pool.
      if (reservations.size >= 512) return reply.code(503).send({ error: 'Typing unavailable' });
      let actorId: string | null = null; let released = false; let transferred = false; let authenticating = true;
      const finishRelease = () => {
        reservations.delete(release);
        if (actorId) { const count = (humans.get(actorId) ?? 1) - 1; if (count) humans.set(actorId, count); else humans.delete(actorId); actorId = null; }
      };
      const release = () => {
        if (released) return; released = true;
        clearTimeout(timer);
        request.raw.socket.off('close', aborted);
        // Aborted upgrades keep their work permit until identity resolution settles.
        if (!authenticating) finishRelease();
      };
      const aborted = () => { if (!transferred) release(); };
      const timer = setTimeout(() => { if (!transferred) release(); }, 10_000);
      timer.unref(); reservations.add(release); request.raw.socket.once('close', aborted);
      try {
        const session = await options.sessions.resolveSession(request.headers);
        if (released) return reply.code(503).send({ error: 'Typing unavailable' });
        if (!session) { release(); return reply.code(401).send({ error: 'Authentication required' }); }
        if ((humans.get(session.principal.id) ?? 0) >= 8) { release(); return reply.code(503).send({ error: 'Typing unavailable' }); }
        actorId = session.principal.id; humans.set(actorId, (humans.get(actorId) ?? 0) + 1);
        accepted.set(request, { actor: { actorId, sessionId: session.sessionId }, release,
          transfer: () => { transferred = true; clearTimeout(timer); request.raw.socket.off('close', aborted); } });
      } catch { release(); return reply.code(503).send({ error: 'Typing unavailable' }); }
      finally { authenticating = false; if (released) finishRelease(); }
    },
  }, (socket, request) => {
    const state = accepted.get(request); accepted.delete(request);
    if (!state || !reservations.has(state.release)) { socket.close(4401, 'Session ended'); return; }
    state.transfer();
    new TypingConnection(socket, state.actor, hub, state.release);
  });
}
