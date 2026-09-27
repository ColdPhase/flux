import type { FastifyError, FastifyInstance } from 'fastify';
import {
  DomainError,
  getInboxItem,
  listInbox,
  markInboxItemRead,
  policySourceReader,
  registerPushSubscription,
  removePushSubscription,
  type Database,
  type NotificationRecord,
  type PushServerConfig,
  type PushSubscriptionRecord,
} from '@flux/core';
import {
  INBOX_PATH,
  PUSH_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTIONS_PATH,
  type ApiError,
  type InboxItem,
  type InboxResponse,
  type PushPublicKeyResponse,
  type PushSubscriptionRequest,
  type PushSubscriptionSummary,
} from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';
import { notificationRepository, subscriptionRepository } from './adapters.js';

export { loadPushServerConfig, type PushServerConfig } from '@flux/core';
export { createNotifier, notificationUnitOfWork, pgBossQueue } from './adapters.js';

export interface PushRoutesOptions {
  db: Database;
  sessions: SessionResolver;
  config: PushServerConfig;
}

const subscriptionBody = {
  type: 'object',
  required: ['endpoint', 'keys'],
  additionalProperties: false,
  properties: {
    endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
    expirationTime: { type: ['number', 'null'] },
    keys: {
      type: 'object',
      required: ['p256dh', 'auth'],
      additionalProperties: false,
      properties: { p256dh: { type: 'string', maxLength: 128 }, auth: { type: 'string', maxLength: 64 } },
    },
    deviceLabel: { type: ['string', 'null'], maxLength: 100 },
  },
} as const;

function unavailable(config: Extract<PushServerConfig, { status: 'unavailable' }>): PushPublicKeyResponse {
  return { status: 'unavailable', code: 'PUSH_UNAVAILABLE', error: config.reason };
}

function summary(row: PushSubscriptionRecord): PushSubscriptionSummary {
  return {
    id: row.id,
    endpointOrigin: new URL(row.endpoint).origin,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastFailureStatus: row.lastFailureStatus,
  };
}

function inboxItem(row: NotificationRecord): InboxItem {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

/**
 * Web Push subscription routes and the in-app inbox. Every route resolves the caller's live
 * session and calls a core use case. Subscriptions are bound to that session; inbox rows are
 * listed and returned only while the caller can read their source (otherwise `404`).
 */
export async function pushRoutes(app: FastifyInstance, { db, sessions, config }: PushRoutesOptions) {
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code } satisfies ApiError);
    throw error;
  });
  const subscriptions = subscriptionRepository(db);
  const inbox = { notifications: notificationRepository(db), authorizer: policySourceReader(db) };

  app.get(PUSH_PUBLIC_KEY_PATH, async (request, reply) => {
    await sessions.requirePrincipal(request);
    if (config.status === 'unavailable') return reply.code(503).send(unavailable(config));
    return { status: 'available', publicKey: config.publicKey } satisfies PushPublicKeyResponse;
  });

  app.get(PUSH_SUBSCRIPTIONS_PATH, async (request): Promise<PushSubscriptionSummary[]> => {
    const { principal } = await sessions.requirePrincipal(request);
    return (await subscriptions.listForUser(principal.id)).map(summary);
  });

  app.post<{ Body: PushSubscriptionRequest }>(PUSH_SUBSCRIPTIONS_PATH, { schema: { body: subscriptionBody } }, async (request, reply) => {
    const { principal, sessionId } = await sessions.requirePrincipal(request);
    if (config.status === 'unavailable') return reply.code(503).send(unavailable(config));
    const { record, created } = await registerPushSubscription(subscriptions, { userId: principal.id, sessionId }, {
      ...request.body,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return reply.code(created ? 201 : 200).send(summary(record));
  });

  app.delete<{ Params: { id: string } }>(`${PUSH_SUBSCRIPTIONS_PATH}/:id`, async (request, reply) => {
    const { principal } = await sessions.requirePrincipal(request);
    await removePushSubscription(subscriptions, principal.id, request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { limit?: number } }>(INBOX_PATH, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  }, async (request): Promise<InboxResponse> => {
    const { principal } = await sessions.requirePrincipal(request);
    const { items, unread } = await listInbox(inbox, principal.id, request.query.limit ?? 50);
    return { items: items.map(inboxItem), unread };
  });

  app.get<{ Params: { id: string } }>(`${INBOX_PATH}/:id`, async (request): Promise<InboxItem> => {
    const { principal } = await sessions.requirePrincipal(request);
    return inboxItem(await getInboxItem(inbox, principal.id, request.params.id));
  });

  app.post<{ Params: { id: string } }>(`${INBOX_PATH}/:id/read`, async (request) => {
    const { principal } = await sessions.requirePrincipal(request);
    const { id, readAt } = await markInboxItemRead(inbox, principal.id, request.params.id);
    return { id, readAt: readAt.toISOString() };
  });
}
