import type { PgBoss } from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import { assistantSettingsPath, assistantOperatorRequestPath } from '@flux/contracts';
import { assistantSettingsUseCases } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors, versionEtag } from '../http/commands.js';
import { assistantRows } from './adapters.js';
import { registerAssistantChangeRoutes } from './changes.js';
import { assistantOperatorUseCases } from './operator.js';

interface Options { db: Database; sessions: SessionResolver; boss: Pick<PgBoss, 'send'> }

/** Owner-only and read here. "What it may do" is the assistant connection's own row (`PATCH /api/v1/agent-connections/:id`, F-036). */
export async function assistantRoutes(app: FastifyInstance, { db, sessions, boss }: Options) {
  useDomainErrors(app);
  const settings = assistantSettingsUseCases({
    get: (ownerUserId, workspaceId) => db.transaction((tx) => assistantRows(tx).get(ownerUserId, workspaceId)),
  });
  const endpoint = assistantSettingsPath(':workspaceId', ':ownerUserId');
  app.get<{ Params: { workspaceId: string; ownerUserId: string } }>(endpoint, async (request, reply) => {
    const result = await settings.get((await sessions.requirePrincipal(request)).principal, request.params.workspaceId, request.params.ownerUserId);
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
