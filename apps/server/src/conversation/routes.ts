import type { FastifyError, FastifyInstance } from 'fastify';
import type { CreateMaterialCommand, PageQuery, SendMessageCommand, UpdateMaterialCommand } from '@flux/contracts';
import { conversationUseCases, DomainError, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { conversationStore } from './store.js';

interface Options { db: Database; sessions: SessionResolver }

const page = { type: 'object', additionalProperties: false,
  properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } as const;
const source = { type: 'object', required: ['materialId', 'version'], additionalProperties: false,
  properties: { materialId: { type: 'string' }, version: { type: 'integer' } } } as const;
const send = { type: 'object', required: ['body', 'clientMessageId'], additionalProperties: false,
  properties: { body: { type: 'string', minLength: 1, maxLength: 100_000 }, clientMessageId: { type: 'string' }, source } } as const;
const createMaterialBody = { type: 'object', required: ['clientMutationId', 'title'], additionalProperties: false,
  properties: { clientMutationId: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 100_000 }, url: { type: 'string', maxLength: 2048 },
    sourceDraftId: { type: 'string' }, sourceDraftVersion: { type: 'integer' } } } as const;
const updateMaterialBody = { type: 'object', required: ['expectedVersion'], additionalProperties: false,
  properties: { expectedVersion: { type: 'integer' }, title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 100_000 }, url: { type: ['string', 'null'], maxLength: 2048 } } } as const;

export async function conversationRoutes(app: FastifyInstance, { db, sessions }: Options) {
  const store = conversationUseCases(conversationStore(db));
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if ((error as FastifyError).statusCode === 401)
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/conversations',
    { schema: { querystring: page } }, async (request) => store.listConversations(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: SendMessageCommand }>('/api/v1/projects/:projectId/conversations',
    { schema: { body: send } }, async (request, reply) => reply.code(201).send(
      await store.createConversation(await principal(request), request.params.projectId, request.body)));
  app.get<{ Params: { conversationId: string } }>('/api/v1/conversations/:conversationId',
    async (request) => store.getConversation(await principal(request), request.params.conversationId));
  app.post<{ Params: { conversationId: string }; Body: SendMessageCommand }>('/api/v1/conversations/:conversationId/messages',
    { schema: { body: send } }, async (request, reply) => reply.code(201).send(
      await store.sendMessage(await principal(request), request.params.conversationId, request.body)));

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/materials',
    { schema: { querystring: page } }, async (request) => store.listMaterials(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: CreateMaterialCommand }>('/api/v1/projects/:projectId/materials',
    { schema: { body: createMaterialBody } }, async (request, reply) => reply.code(201).send(
      await store.createMaterial(await principal(request), request.params.projectId, request.body)));
  app.get<{ Params: { materialId: string } }>('/api/v1/materials/:materialId',
    async (request) => store.getMaterial(await principal(request), request.params.materialId));
  app.get<{ Params: { materialId: string; version: string } }>('/api/v1/materials/:materialId/versions/:version',
    async (request) => store.getMaterialVersion(await principal(request), request.params.materialId, Number(request.params.version)));
  app.patch<{ Params: { materialId: string }; Body: UpdateMaterialCommand }>('/api/v1/materials/:materialId',
    { schema: { body: updateMaterialBody } }, async (request) => store.updateMaterial(await principal(request), request.params.materialId, request.body));
}
