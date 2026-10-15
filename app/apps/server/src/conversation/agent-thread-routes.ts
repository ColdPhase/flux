import type { FastifyInstance } from 'fastify';
import type { ConversationWindowQuery } from '@flux/contracts';
import { taskAgentThreadUseCases, type Database, type FileStorage, type TaskAgentThreadCommand } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { withTaskUseErrors } from '../work/task-use-errors.js';
import { conversationStore } from './store.js';

/** Internal application API. No public MCP registration or people-reply transition in this increment. */
export async function agentThreadRoutes(app: FastifyInstance, { db, sessions, storage }: {
  db: Database; sessions: SessionResolver; storage: FileStorage;
}) {
  const threads = taskAgentThreadUseCases(conversationStore(db, { storage }));
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) =>
    (await sessions.requirePrincipal(request)).principal;
  app.get<{ Params: { workId: string }; Querystring: ConversationWindowQuery }>('/api/v1/work/:workId/agent-thread', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50 }, beforeSequence: { type: 'integer', minimum: 1 },
    } } },
  }, async (request) => threads.get(await principal(request), request.params.workId, request.query));
  app.post<{ Params: { workId: string }; Body: TaskAgentThreadCommand }>('/api/v1/work/:workId/agent-thread', {
    schema: { body: { type: 'object', required: ['body', 'clientMessageId'], additionalProperties: false, properties: {
      body: { type: 'string', minLength: 0, maxLength: 100_000 }, clientMessageId: { type: 'string', format: 'uuid' },
      projectId: { type: 'string', format: 'uuid' },
      source: { type: 'object', required: ['materialId', 'version'], additionalProperties: false, properties: {
        materialId: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 },
      } },
      attachmentIds: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uuid' } },
    } } },
  }, async (request, reply) => reply.code(201).send(await withTaskUseErrors(async () =>
    threads.post(await principal(request), request.params.workId, request.body))));
}
