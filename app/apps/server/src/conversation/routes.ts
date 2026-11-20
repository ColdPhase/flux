import type { FastifyError, FastifyInstance } from 'fastify';
import { SPACE_PREVIEWS_LIMIT, SPACE_PREVIEWS_PATH, type ConversationRootQuery, type ConversationWindowQuery, type EditMessageCommand, type PageQuery, type SendMessageCommand, type SpacePreviewsResponse } from '@flux/contracts';
import { conversationUseCases, DomainError, InvalidInputError, type FileStorage } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { taskUseDomainError } from '../work/task-use-errors.js';
import { conversationStore } from './store.js';
import { projectReceipts } from './receipts.js';

interface Options { db: Database; sessions: SessionResolver; storage: FileStorage }

const page = { type: 'object', additionalProperties: false,
  properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } as const;
const conversationWindow = { type: 'object', additionalProperties: false,
  properties: { limit: { type: 'integer' }, beforeSequence: { type: 'integer' } } } as const;
const rootWindow = { type: 'object', additionalProperties: false,
  properties: { limit: { type: 'integer' }, before: { type: 'string' } } } as const;
const source = { type: 'object', required: ['materialId', 'version'], additionalProperties: false,
  properties: { materialId: { type: 'string' }, version: { type: 'integer' } } } as const;
const send = { type: 'object', required: ['body', 'clientMessageId'], additionalProperties: false,
  properties: { body: { type: 'string', minLength: 0, maxLength: 100_000 }, attachmentIds: { type: 'array', maxItems: 10, items: { type: 'string' } }, clientMessageId: { type: 'string' }, source,
    // The items are checked by the one normalizer (kind, UUID, distinct), which names what is wrong.
    references: { type: 'array', maxItems: 4, items: { type: 'object' } } } } as const;
/**
 * A generic message is ordinary text. Reject a contribution kind rather than let the schema silently
 * strip it: blocker, result and handoff contributions come only from their own commands (#154).
 */
const plainText = async (request: { body?: unknown }) => {
  if (request.body && typeof request.body === 'object' && Object.hasOwn(request.body, 'kind'))
    throw new InvalidInputError('A conversation message has no contribution kind');
};
export async function conversationRoutes(app: FastifyInstance, { db, sessions, storage }: Options) {
  const stored = conversationStore(db, { storage });
  const store = conversationUseCases(stored);
  const receipts = projectReceipts(db);
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    error = taskUseDomainError(error) as typeof error;
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if ((error as FastifyError).statusCode === 401)
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });

  // The Spaces list's second line and time (#1563): each readable space's newest message, in one read for the spaces asked about.
  app.get<{ Querystring: { projectIds?: string } }>(SPACE_PREVIEWS_PATH, { schema: { querystring: { type: 'object', additionalProperties: false, properties: { projectIds: { type: 'string', maxLength: SPACE_PREVIEWS_LIMIT * 37 } } } } },
    async (request): Promise<SpacePreviewsResponse> => {
      const ids = (request.query.projectIds ?? '').split(',').filter(Boolean);
      if (ids.length > SPACE_PREVIEWS_LIMIT) throw new InvalidInputError(`Ask about at most ${SPACE_PREVIEWS_LIMIT} spaces at a time`);
      return { items: await stored.listSpacePreviews(await principal(request), ids) };
    });
  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/conversations',
    { schema: { querystring: page } }, async (request) => store.listConversations(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: SendMessageCommand }>('/api/v1/projects/:projectId/conversations',
    { preValidation: plainText, schema: { body: send } }, async (request, reply) => reply.code(201).send(
      await store.createConversation(await principal(request), request.params.projectId, request.body)));
  // The project's one conversation (UI116-1): its roots with reply counts, newest window first.
  app.get<{ Params: { projectId: string }; Querystring: ConversationRootQuery }>('/api/v1/projects/:projectId/conversation-roots',
    { schema: { querystring: rootWindow } }, async (request) => store.listRoots(await principal(request), request.params.projectId, request.query));
  app.get<{ Params: { conversationId: string }; Querystring: ConversationWindowQuery }>('/api/v1/conversations/:conversationId',
    { schema: { querystring: conversationWindow } },
    async (request) => store.getConversation(await principal(request), request.params.conversationId, request.query));
  app.post<{ Params: { conversationId: string }; Body: SendMessageCommand }>('/api/v1/conversations/:conversationId/messages',
    { preValidation: plainText, schema: { body: send } }, async (request, reply) => reply.code(201).send(
      await store.sendMessage(await principal(request), request.params.conversationId, request.body)));

  // A decision's one discussion (#1424): the thread on its card, which its panel shows too. The first message starts it.
  app.get<{ Params: { decisionId: string }; Querystring: ConversationWindowQuery }>('/api/v1/decisions/:decisionId/discussion',
    { schema: { querystring: conversationWindow } },
    async (request) => store.decisionDiscussion(await principal(request), request.params.decisionId, request.query));
  app.post<{ Params: { decisionId: string }; Body: SendMessageCommand }>('/api/v1/decisions/:decisionId/discussion',
    { preValidation: plainText, schema: { body: send } }, async (request, reply) => reply.code(201).send(
      await store.discussDecision(await principal(request), request.params.decisionId, request.body)));

  // The author changes or deletes their own message (#1006). No Idempotency-Key: saving the same words and deleting a deleted message
  // answer the current message again, so a retry is safe, and no replayable answer keeps the words.
  const edit = { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string', maxLength: 100_000 } } } as const;
  app.patch<{ Params: { conversationId: string; messageId: string }; Body: EditMessageCommand }>('/api/v1/conversations/:conversationId/messages/:messageId',
    { schema: { body: edit } }, async (request) => store.editMessage(await principal(request), request.params.conversationId, request.params.messageId, request.body));
  app.delete<{ Params: { conversationId: string; messageId: string } }>('/api/v1/conversations/:conversationId/messages/:messageId',
    async (request) => store.removeMessage(await principal(request), request.params.conversationId, request.params.messageId));

  // Viewing receipts (#534). The viewer is the session's person; the body never names one.
  const messageId = { type: 'string', minLength: 1, maxLength: 64 } as const;
  app.post<{ Params: { projectId: string }; Body: { messageIds: string[] } }>('/api/v1/projects/:projectId/observations',
    { schema: { body: { type: 'object', required: ['messageIds'], additionalProperties: false, properties: { messageIds: { type: 'array', minItems: 1, maxItems: 50, items: messageId } } } } },
    async (request) => receipts.observe(await principal(request), request.params.projectId, request.body));
  app.post<{ Params: { projectId: string }; Body: { runs: string[][] } }>('/api/v1/projects/:projectId/receipts',
    { schema: { body: { type: 'object', required: ['runs'], additionalProperties: false, properties: { runs: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'array', minItems: 1, maxItems: 50, items: messageId } } } } } },
    async (request) => receipts.receipts(await principal(request), request.params.projectId, request.body));
  app.post<{ Params: { projectId: string }; Body: { runs: string[][]; run: number; after?: string } }>('/api/v1/projects/:projectId/receipts/readers',
    { schema: { body: { type: 'object', required: ['runs', 'run'], additionalProperties: false, properties: { runs: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'array', minItems: 1, maxItems: 50, items: messageId } }, run: { type: 'integer', minimum: 0, maximum: 19 }, after: { type: 'string', maxLength: 100 } } } } },
    async (request) => receipts.readers(await principal(request), request.params.projectId, request.body));

  // A page by its id and a version of it (#1508: every saved source is a Wiki page): what a message's citation and a task's source read.
  app.get<{ Params: { materialId: string } }>('/api/v1/materials/:materialId',
    async (request) => store.getMaterial(await principal(request), request.params.materialId));
  app.get<{ Params: { materialId: string; version: string } }>('/api/v1/materials/:materialId/versions/:version',
    async (request) => store.getMaterialVersion(await principal(request), request.params.materialId, Number(request.params.version)));
}
