import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { AUTH_BASE_PATH } from '@flux/contracts';
import type { Executor } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import type { LiveMediaAdapter } from './media.js';

/** Rooms looked at per sign-out; more concurrent available rooms per person are not expected. */
export const SIGN_OUT_ROOM_LIMIT = 50;
/** The whole disconnect gives up after this; each SFU call has its own 5-second timeout. */
export const SIGN_OUT_DISCONNECT_TIMEOUT_MS = 15_000;
const CONCURRENCY = 5;
const SIGN_OUT_PATH = `${AUTH_BASE_PATH}/sign-out`;

export interface SignOutDisconnectOptions {
  db: Executor;
  sessions: Pick<SessionResolver, 'resolveSession'>;
  media: Pick<LiveMediaAdapter, 'participants' | 'removeParticipant'>;
  timeoutMs?: number;
}

export interface SignOutDisconnect {
  /** Resolves when every disconnect started so far has finished (tests and shutdown). */
  settled(): Promise<void>;
}

/**
 * Available rooms in the person's workspaces, newest activity first. This only narrows where
 * to look for their media connection; it grants nothing, and removing a connection is always
 * safe, so it is not an access decision.
 */
async function candidateRooms(db: Executor, userId: string): Promise<{ sessionId: string; roomId: string }[]> {
  const ls = schema.liveSessions;
  return db.select({ sessionId: ls.id, roomId: ls.roomId }).from(ls)
    .innerJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, ls.workspaceId),
      eq(schema.workspaceMembers.userId, userId)))
    .where(eq(ls.state, 'available'))
    .orderBy(desc(ls.updatedAt), desc(ls.id)).limit(SIGN_OUT_ROOM_LIMIT);
}

/**
 * Removes a person from every available live room they are connected to. The SFU knows a
 * person, not a device: signing out one device also disconnects their other devices from
 * rooms, which then rejoin with a fresh grant if still signed in. Failures are reported, not
 * thrown; a later sweep or room retirement is the backstop.
 */
export async function disconnectEverywhere(options: SignOutDisconnectOptions, userId: string,
  log: (message: string, details: Record<string, unknown>) => void): Promise<number> {
  const rooms = await candidateRooms(options.db, userId);
  let removed = 0;
  let next = 0;
  const worker = async () => {
    while (next < rooms.length) {
      const room = rooms[next++]!;
      try {
        const people = await options.media.participants(room.roomId);
        if (!people.some((person) => person.userId === userId)) continue;
        await options.media.removeParticipant(room.roomId, userId);
        removed++;
      } catch (error) {
        log('Sign-out could not disconnect a live room; room retirement or expiry remains the backstop',
          { sessionId: room.sessionId, error: (error as Error)?.message ?? String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rooms.length) }, worker));
  return removed;
}

/**
 * After a successful `POST /api/auth/sign-out`, ends that person's live media connections.
 * The person is resolved before Better Auth deletes the session; the work starts only after
 * the response is sent and is bounded, so sign-out never waits for or fails on the SFU.
 * Register on the root instance (like identity) and only when live media is configured.
 */
export function disconnectOnSignOut(app: FastifyInstance, options: SignOutDisconnectOptions): SignOutDisconnect {
  const signingOut = new WeakMap<FastifyRequest, string>();
  const running = new Set<Promise<void>>();
  const timeoutMs = options.timeoutMs ?? SIGN_OUT_DISCONNECT_TIMEOUT_MS;
  const isSignOut = (request: FastifyRequest) =>
    request.method === 'POST' && request.url.split('?', 1)[0] === SIGN_OUT_PATH;

  app.addHook('onRequest', async (request) => {
    if (!isSignOut(request)) return;
    try {
      const context = await options.sessions.resolveSession(request.headers);
      if (context) signingOut.set(request, context.principal.id);
    } catch (error) {
      request.log.warn({ error }, 'Sign-out could not resolve the session for live disconnect');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const userId = signingOut.get(request);
    if (!userId || reply.statusCode < 200 || reply.statusCode >= 300) return;
    signingOut.delete(request);
    const log = (message: string, details: Record<string, unknown>) => request.log.warn(details, message);
    let timer: NodeJS.Timeout | undefined;
    const bounded: Promise<void> = Promise.race([
      disconnectEverywhere(options, userId, log).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { log('Sign-out live disconnect timed out', { timeoutMs }); resolve(); }, timeoutMs);
        timer.unref();
      }),
    ]).catch((error: unknown) => log('Sign-out live disconnect failed', { error: (error as Error)?.message ?? String(error) }));
    running.add(bounded);
    void bounded.finally(() => { clearTimeout(timer); running.delete(bounded); });
  });

  const settled = async () => { await Promise.all([...running]); };
  app.addHook('onClose', settled);
  return { settled };
}
