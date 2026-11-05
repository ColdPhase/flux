import type { PgBoss } from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import { ASSISTANT_LIMITS, assistantSettingsPath, assistantOperatorRequestPath, type UpdateAssistantSettings } from '@flux/contracts';
import { assistantSettingsUseCases } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { expectedVersion, useDomainErrors, versionEtag } from '../http/commands.js';
import { assistantRows } from './adapters.js';
import { registerAssistantChangeRoutes } from './changes.js';
import { assistantOperatorUseCases } from './operator.js';

interface Options { db: Database; sessions: SessionResolver; boss: Pick<PgBoss, 'send'> }
const limit = (range: { min: number; max: number }) => ({ type: 'integer', minimum: range.min, maximum: range.max });
const body = { type: 'object', additionalProperties: false, required: ['backgroundRunsPerDay'], properties: {
  backgroundRunsPerDay: limit(ASSISTANT_LIMITS.backgroundRunsPerDay),
  expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_646 },
} } as const;

/** Owner-only configuration. "What it may do" is the assistant connection's own row (`PATCH /api/v1/agent-connections/:id`, F-036). */
export async function assistantRoutes(app: FastifyInstance, { db, sessions, boss }: Options) {
  useDomainErrors(app);
  const settings = assistantSettingsUseCases({
    get: (ownerUserId, workspaceId) => db.transaction((tx) => assistantRows(tx).get(ownerUserId, workspaceId)),
    save: (ownerUserId, workspaceId, expected, input) => db.transaction((tx) => assistantRows(tx).save(ownerUserId, workspaceId, expected, input)),
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
  const operator = assistantOperatorUseCases(db, boss);
  app.post<{ Params: { workspaceId: string }; Body: { client?: 'claude_code' | 'codex' } | undefined }>(assistantOperatorRequestPath(':workspaceId'),
    { schema: { body: { type: 'object', additionalProperties: false, properties: { client: { type: 'string', enum: ['claude_code', 'codex'] } } } } }, async (request, reply) =>
      reply.code(201).send(await operator.request((await sessions.requirePrincipal(request)).principal, request.params.workspaceId, request.body?.client === 'codex' ? 'ChatGPT' : 'Claude')));
  // The change line, Undo and waiting changes (F-036 AG-3).
  registerAssistantChangeRoutes(app, db, sessions);

}
