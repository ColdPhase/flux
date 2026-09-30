import type { FastifyInstance } from 'fastify';
import type { LiveContextRef, LivePresentationRef, PresentLiveContextCommand, StartLiveSessionCommand } from '@flux/contracts';
import { LIVE_SESSIONS_PATH, liveJoinPath, liveLeavePath, livePresentPath, livePresentationsPath, liveSessionPath } from '@flux/contracts';
import { DomainError, liveUseCases, RateLimitedError, type LivePorts } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import type { LiveLifecycle } from './lifecycle.js';
import type { JoinRateLimiter } from './rate-limit.js';
import type { LiveRevocationCoordinator } from './revocation.js';

interface Options { ports: LivePorts; sessions: SessionResolver; lifecycle?: Pick<LiveLifecycle, 'reconcile'>;
  revocation?: Pick<LiveRevocationCoordinator, 'recoverMissingRoom'>;
  /** Per-user join limit of this API instance, created by the composition root. */
  joinLimiter?: JoinRateLimiter }

const id = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const context = { type: 'object', required: ['type', 'id'], additionalProperties: false,
  properties: { type: { type: 'string', enum: ['conversation', 'work', 'sketch', 'doc'] }, id } } as const;
const presentation = { type: 'object', required: ['type', 'id', 'version'], additionalProperties: false,
  properties: { type: { type: 'string', enum: ['message', 'material', 'work', 'result', 'sketch'] }, id,
    version: { type: 'integer', minimum: 1 }, selectedThoughtIds: { type: 'array', maxItems: 100, uniqueItems: true, items: id } } } as const;

/** API policy runs before transport grants; the browser starts with all devices off. */
export async function liveRoutes(app: FastifyInstance, { ports, sessions, lifecycle, revocation, joinLimiter }: Options) {
  useDomainErrors(app);
  // A limited join says when to try again (HTTP 429 + Retry-After).
  app.addHook('onError', async (_request, reply, error) => {
    if (error instanceof RateLimitedError) reply.header('retry-after', String(error.retryAfterSeconds));
  });
  const live = liveUseCases(ports);
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  app.post<{ Body: StartLiveSessionCommand }>(LIVE_SESSIONS_PATH, {
    schema: { body: { type: 'object', required: ['context', 'clientSessionId'], additionalProperties: false,
      properties: { context, clientSessionId: id } } },
  }, async (request, reply) => reply.code(201).send(await live.start(await principal(request), request.body.context as LiveContextRef, request.body.clientSessionId)));

  app.get<{ Params: { sessionId: string } }>(liveSessionPath(':sessionId'),
    async (request) => live.get(await principal(request), request.params.sessionId));

  app.post<{ Params: { sessionId: string } }>(liveJoinPath(':sessionId'), async (request) => {
    const caller = await principal(request);
    // Counted before any database or SFU work, so a runaway client stays cheap.
    joinLimiter?.take(caller.id);
    try { return await live.join(caller, request.params.sessionId); }
    catch (error) {
      if (!revocation || !(error instanceof DomainError) ||
        !['LIVE_ROOM_GONE', 'LIVE_SESSION_ROTATING'].includes(error.code)) throw error;
      await revocation.recoverMissingRoom(request.params.sessionId);
      // This is a new admission, including current project and anchor checks.
      return live.join(caller, request.params.sessionId);
    }
  });

  app.post<{ Params: { sessionId: string } }>(liveLeavePath(':sessionId'), async (request, reply) => {
    await live.leave(await principal(request), request.params.sessionId);
    await lifecycle?.reconcile(request.params.sessionId);
    return reply.code(204).send();
  });

  app.post<{ Params: { sessionId: string }; Body: PresentLiveContextCommand }>(livePresentPath(':sessionId'), {
    schema: { body: { type: 'object', required: ['ref', 'clientEventId'], additionalProperties: false,
      properties: { ref: presentation, clientEventId: id } } },
  }, async (request, reply) => {
    await live.present(await principal(request), request.params.sessionId, request.body.ref as LivePresentationRef, request.body.clientEventId);
    return reply.code(204).send();
  });

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string; limit?: number } }>(
    livePresentationsPath(':sessionId'), {
      schema: { params: { type: 'object', required: ['sessionId'], properties: { sessionId: id } },
        querystring: { type: 'object', additionalProperties: false,
          properties: { after: id, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
    }, async (request) => live.presentations(await principal(request), request.params.sessionId,
      request.query.after ?? null, request.query.limit ?? 50));
}
