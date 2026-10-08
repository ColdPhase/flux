import type { FastifyInstance } from 'fastify';
import { NEEDS_YOU_PATH, type ResolveNeedsYouCommand } from '@flux/contracts';
import type { Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { needsYouUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

// One flat shape: core checks which fields an action needs (Ajv's removeAdditional would mutate `oneOf` branches).
const command = { type: 'object', required: ['action'], additionalProperties: false, properties: {
  action: { type: 'string', enum: ['done', 'decline', 'snooze'] }, until: { type: 'string', maxLength: 40 }, untilWorkId: { type: 'string', maxLength: 40 },
} } as const;

/**
 * `/api/v1/needs-you`: the Inbox queue of the signed-in person and what they do with its items (#342).
 * Each handler resolves the live session and calls one core use case; an item the person cannot read
 * now is not listed and answers like one that never existed. Resolving is idempotent by nature (the
 * same choice stores the same state), so no Idempotency-Key is needed.
 */
export async function needsYouRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const use = needsYouUseCases(db);
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  app.get(NEEDS_YOU_PATH, async (request, reply) => reply.header('cache-control', 'no-store').send(await use.list(await principal(request))));

  app.post<{ Params: { key: string }; Body: ResolveNeedsYouCommand }>(`${NEEDS_YOU_PATH}/:key`, { schema: { body: command } },
    async (request) => use.resolve(await principal(request), request.params.key, request.body));

  app.delete<{ Params: { key: string } }>(`${NEEDS_YOU_PATH}/:key`, async (request, reply) => {
    await use.restore(await principal(request), request.params.key);
    return reply.code(204).send();
  });
}
