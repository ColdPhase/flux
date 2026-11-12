import type { FastifyInstance } from 'fastify';
import { READ_ALL_PATH, READ_ALL_UNDO_PATH, SPACE_ORDER_LIMIT, SPACE_ORDER_PATH, type ReadAllUndo, type SetSpaceOrderCommand } from '@flux/contracts';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { sidebarUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

const uuid = { type: 'string', maxLength: 64 } as const;
const stamp = { type: 'string', maxLength: 64 } as const;

/**
 * `/api/v1/me/...`: the sidebar's own state of the signed-in person (#1250). Each handler resolves the live session and calls one core
 * use case. The order is replaced whole, so saving it twice saves the same order; Mark all as read and its Undo only move what is
 * behind, so neither needs an Idempotency-Key.
 */
export async function sidebarRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const use = sidebarUseCases(db);
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  app.get(SPACE_ORDER_PATH, async (request, reply) => reply.header('cache-control', 'no-store').send(await use.order(await principal(request))));

  app.put<{ Body: SetSpaceOrderCommand }>(SPACE_ORDER_PATH, { schema: { body: {
    type: 'object', required: ['order'], additionalProperties: false, properties: { order: { type: 'array', maxItems: SPACE_ORDER_LIMIT, items: uuid } },
  } } }, async (request) => use.setOrder(await principal(request), request.body));

  app.post(READ_ALL_PATH, async (request, reply) => reply.header('cache-control', 'no-store').send(await use.readAll(await principal(request))));

  app.post<{ Body: ReadAllUndo }>(READ_ALL_UNDO_PATH, { schema: { body: {
    type: 'object', required: ['mark', 'spaces', 'chats'], additionalProperties: false, properties: {
      mark: { type: ['string', 'null'], maxLength: 64 },
      spaces: { type: 'array', maxItems: SPACE_ORDER_LIMIT, items: uuid },
      chats: { type: 'array', maxItems: 100, items: { type: 'object', required: ['agentId', 'before', 'now'], additionalProperties: false,
        properties: { agentId: uuid, before: { type: ['string', 'null'], maxLength: 64 }, now: stamp } } },
    },
  } } }, async (request, reply) => {
    await use.undoReadAll(await principal(request), request.body);
    return reply.code(204).send();
  });
}
