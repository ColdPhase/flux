import type { FastifyInstance } from 'fastify';
import {
  RETURN_POINTS_PATH,
  RETURN_POINTS_RESTORE_PATH,
  RETURN_SUMMARY_PATH,
  type RestoreReturnPointCommand,
  type ReturnSummaryQuery,
  type SaveReturnPointCommand,
} from '@flux/contracts';
import type { Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, useDomainErrors } from '../http/commands.js';
import { returnUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

const place = { type: 'object', required: ['type'], additionalProperties: false, properties: {
  type: { type: 'string', enum: ['home', 'project', 'conversation'] }, id: { type: 'string', maxLength: 64 },
} } as const;

/**
 * `/api/v1` return view routes (#106). Each handler resolves the current session and calls one
 * core use case, which authorizes the place and every event. Saving is forward-only and
 * idempotent by nature (the same mark saves the same point), so no Idempotency-Key is needed.
 */
export async function returnRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const { principal } = commandRunner(db, sessions);
  const returns = returnUseCases(db);
  app.get<{ Querystring: ReturnSummaryQuery }>(RETURN_SUMMARY_PATH, { schema: { querystring: {
    type: 'object', required: ['place'], additionalProperties: false,
    properties: {
      place: { type: 'string', enum: ['home', 'project', 'conversation'] }, id: { type: 'string', maxLength: 64 },
      scope: { type: 'string', enum: ['all', 'mine'] }, from: { type: 'string', enum: ['last-visit', '24h', '7d'] },
      until: { type: 'string', maxLength: 64 }, digest: { type: 'string', enum: ['0', '1'] },
    },
  } } }, async (request, reply) => {
    const summary = await returns.summary(await principal(request), request.query);
    return reply.header('cache-control', 'no-store').send(summary);
  });
  app.put<{ Body: SaveReturnPointCommand }>(RETURN_POINTS_PATH, { schema: { body: {
    type: 'object', required: ['place', 'mark'], additionalProperties: false,
    properties: { place, mark: { type: ['string', 'null'], maxLength: 64 } },
  } } }, async (request) => returns.save(await principal(request), request.body));
  app.post<{ Body: RestoreReturnPointCommand }>(RETURN_POINTS_RESTORE_PATH, { schema: { body: {
    type: 'object', required: ['place'], additionalProperties: false, properties: { place },
  } } }, async (request) => returns.restore(await principal(request), request.body));
}
