import type { PgBoss } from 'pg-boss';
import { assistantJoinUseCases } from './joins.js';
import type { FastifyInstance } from 'fastify';
import { ASSISTANT_AREAS, ASSISTANT_LIMITS, assistantSettingsPath, assistantJoinRequestPath, type UpdateAssistantSettings } from '@flux/contracts';
import { assistantSettingsUseCases, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { expectedVersion, useDomainErrors, versionEtag } from '../http/commands.js';
import { transactionEventSession } from '../work/transaction-events.js';
import { assistantRows } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver; boss: Pick<PgBoss, 'send'> }
const modes = { type: 'string', enum: ['off', 'read', 'edit'] } as const;
const areas = { type: 'object', additionalProperties: false,
  properties: Object.fromEntries(ASSISTANT_AREAS.map((area) => [area.id, modes])) } as const;
const limit = (range: { min: number; max: number }) => ({ type: 'integer', minimum: range.min, maximum: range.max });
const body = { type: 'object', additionalProperties: false, properties: {
  approvalMode: { type: 'string', enum: ['act', 'ask'] }, changesPerRun: limit(ASSISTANT_LIMITS.changesPerRun),
  backgroundRunsPerDay: limit(ASSISTANT_LIMITS.backgroundRunsPerDay), areas,
  projectMode: { type: 'string', enum: ['all', 'chosen'] },
  selectedProjectIds: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
  expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_646 },
} } as const;

/** Owner-only configuration; there is one S6 store, not a second assistant permission implementation. */
export async function assistantRoutes(app: FastifyInstance, { db, sessions, boss }: Options) {
  useDomainErrors(app);
  const settings = assistantSettingsUseCases({
    get: (ownerUserId, workspaceId) => db.transaction((tx) => assistantRows(tx, transactionEventSession(tx)).get(ownerUserId, workspaceId)),
    save: (ownerUserId, workspaceId, expected, input) => db.transaction(async (tx) => {
      const events = transactionEventSession(tx);
      const result = await events.run(() => assistantRows(tx, events).save(ownerUserId, workspaceId, expected, input));
      await events.flushEvents();
      return result;
    }),
  });
  const endpoint = assistantSettingsPath(':workspaceId', ':ownerUserId');
  app.get<{ Params: { workspaceId: string; ownerUserId: string } }>(endpoint, async (request, reply) => {
    const result = await settings.get((await sessions.requirePrincipal(request)).principal, request.params.workspaceId, request.params.ownerUserId);
    reply.header('cache-control', 'no-store').header('etag', versionEtag(result));
    return result;
  });
  app.patch<{ Params: { workspaceId: string; ownerUserId: string }; Body: UpdateAssistantSettings }>(endpoint, { schema: { body } }, async (request, reply) => {
    const result = await settings.save((await sessions.requirePrincipal(request)).principal, request.params.workspaceId,
      request.params.ownerUserId, expectedVersion(request), request.body);
    reply.header('cache-control', 'no-store').header('etag', versionEtag(result));
    return result;
  });
  const joins = assistantJoinUseCases(db, boss);
  app.post<{ Params: { projectId: string } }>(assistantJoinRequestPath(':projectId'), async (request, reply) => {
    const result = await joins.request((await sessions.requirePrincipal(request)).principal, request.params.projectId);
    return reply.code(201).send(result);
  });
  for (const action of ['allow', 'decline'] as const) {
    app.post<{ Params: { projectId: string; requestId: string } }>(`${assistantJoinRequestPath(':projectId')}/:requestId/${action}`, async (request) =>
      joins.respond((await sessions.requirePrincipal(request)).principal, request.params.projectId, request.params.requestId, action === 'allow'));
  }

}
