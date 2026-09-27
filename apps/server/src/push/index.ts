import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import { isP256PublicKey, pushEndpointViolation, type Database, type PushServerConfig } from '@flux/core';
import {
  INBOX_PATH,
  PUSH_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTIONS_PATH,
  type InboxResponse,
  type PushPublicKeyResponse,
  type PushSubscriptionRequest,
  type PushSubscriptionSummary,
} from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';

export { loadPushServerConfig, type PushServerConfig } from '@flux/core';

/** A browser normally holds one subscription per origin; this bounds rows per account. */
export const MAX_SUBSCRIPTIONS_PER_USER = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function summary(row: typeof schema.pushSubscriptions.$inferSelect): PushSubscriptionSummary {
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

function authSecretIsValid(value: string) {
  return /^[A-Za-z0-9_-]+={0,2}$/.test(value) && Buffer.from(value.replace(/=+$/, ''), 'base64url').length === 16;
}

/**
 * Web Push subscription routes and the in-app inbox. Every route resolves the caller with
 * requirePrincipal and only reads or changes that user's rows; someone else's id is a 404.
 */
export function registerPush(app: FastifyInstance, { db, sessions, config }: PushRoutesOptions) {
  app.get(PUSH_PUBLIC_KEY_PATH, async (request, reply) => {
    await sessions.requirePrincipal(request);
    if (config.status === 'unavailable') return reply.code(503).send(unavailable(config));
    return { status: 'available', publicKey: config.publicKey } satisfies PushPublicKeyResponse;
  });

  app.get(PUSH_SUBSCRIPTIONS_PATH, async (request): Promise<PushSubscriptionSummary[]> => {
    const { principal } = await sessions.requirePrincipal(request);
    const rows = await db.select().from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, principal.id))
      .orderBy(schema.pushSubscriptions.createdAt);
    return rows.map(summary);
  });

  app.post<{ Body: PushSubscriptionRequest }>(PUSH_SUBSCRIPTIONS_PATH, { schema: { body: subscriptionBody } }, async (request, reply) => {
    const { principal } = await sessions.requirePrincipal(request);
    if (config.status === 'unavailable') return reply.code(503).send(unavailable(config));
    const { endpoint, keys, expirationTime } = request.body;
    const violation = pushEndpointViolation(endpoint);
    if (violation) return reply.code(400).send({ error: violation, code: 'PUSH_ENDPOINT_REJECTED' });
    if (!isP256PublicKey(keys.p256dh) || !authSecretIsValid(keys.auth)) {
      return reply.code(400).send({ error: 'Subscription keys are not a valid P-256 key and 16-byte auth secret', code: 'PUSH_KEYS_INVALID' });
    }
    const [existing] = await db.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpoint, endpoint));
    if (!existing) {
      const [{ total }] = await db.select({ total: count() }).from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, principal.id));
      if (total >= MAX_SUBSCRIPTIONS_PER_USER) {
        return reply.code(409).send({ error: `At most ${MAX_SUBSCRIPTIONS_PER_USER} push subscriptions per account`, code: 'PUSH_SUBSCRIPTION_LIMIT' });
      }
    }
    const userAgent = request.headers['user-agent']?.slice(0, 500) ?? null;
    const deviceLabel = request.body.deviceLabel?.trim() || null;
    const values = {
      userId: principal.id,
      p256dh: keys.p256dh.replace(/=+$/, ''),
      auth: keys.auth.replace(/=+$/, ''),
      expirationTime: typeof expirationTime === 'number' ? new Date(expirationTime) : null,
      deviceLabel,
      userAgent,
    };
    // Idempotent on endpoint. The endpoint identifies a browser profile, so when another
    // account signs in on that browser and subscribes, the device moves to that account and
    // the previous account stops receiving pushes there.
    const id = randomUUID();
    const [row] = await db.insert(schema.pushSubscriptions)
      .values({ id, endpoint, ...values })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: { ...values, updatedAt: new Date(), lastFailureAt: null, lastFailureStatus: null },
      })
      .returning();
    return reply.code(row!.id === id ? 201 : 200).send(summary(row!));
  });

  app.delete<{ Params: { id: string } }>(`${PUSH_SUBSCRIPTIONS_PATH}/:id`, async (request, reply) => {
    const { principal } = await sessions.requirePrincipal(request);
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'Subscription not found' });
    const deleted = await db.delete(schema.pushSubscriptions)
      .where(and(eq(schema.pushSubscriptions.id, request.params.id), eq(schema.pushSubscriptions.userId, principal.id)))
      .returning({ id: schema.pushSubscriptions.id });
    if (!deleted.length) return reply.code(404).send({ error: 'Subscription not found' });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { limit?: number } }>(INBOX_PATH, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  }, async (request): Promise<InboxResponse> => {
    const { principal } = await sessions.requirePrincipal(request);
    const rows = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, principal.id))
      .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
      .limit(request.query.limit ?? 50);
    const [{ unread }] = await db.select({ unread: count() }).from(schema.notifications)
      .where(and(eq(schema.notifications.userId, principal.id), isNull(schema.notifications.readAt)));
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        url: row.url,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      })),
      unread,
    };
  });

  app.post<{ Params: { id: string } }>(`${INBOX_PATH}/:id/read`, async (request, reply) => {
    const { principal } = await sessions.requirePrincipal(request);
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'Notification not found' });
    const [row] = await db.update(schema.notifications)
      .set({ readAt: sql`coalesce(${schema.notifications.readAt}, now())` })
      .where(and(eq(schema.notifications.id, request.params.id), eq(schema.notifications.userId, principal.id)))
      .returning({ id: schema.notifications.id, readAt: schema.notifications.readAt });
    if (!row) return reply.code(404).send({ error: 'Notification not found' });
    return { id: row.id, readAt: row.readAt?.toISOString() ?? null };
  });
}
