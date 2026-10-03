import type { FastifyInstance } from 'fastify';
import { audienceKey } from '@flux/core';
import { STREAM_PATH } from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';
import type { StreamWork } from './delivery.js';
import { UNAUTHENTICATED } from '../http/errors.js';

/**
 * Test only (`exposeWork`, enabled with FLUX_TEST_FAILURE_INJECTION): `GET /api/v1/stream/work`
 * returns the caller's last open→ready work counters, so the suite can show they do not
 * depend on events the caller cannot see.
 */
export function workRoute(app: FastifyInstance, sessions: SessionResolver, lastWork: ReadonlyMap<string, StreamWork>) {
  app.get(`${STREAM_PATH}/work`, async (request, reply) => {
    const context = await sessions.resolveSession(request.headers);
    if (!context) return reply.code(401).send(UNAUTHENTICATED);
    return { work: lastWork.get(audienceKey(context.principal)) ?? null };
  });
}
