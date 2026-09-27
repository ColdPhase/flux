import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, type LookupFunction } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import webpush, { WebPushError } from 'web-push';
import { schema } from '@flux/db';
import { pushEndpointViolation, type Database, type PushSenderConfig, type PushSendJob } from '@flux/core';
import type { PushPayload } from '@flux/contracts';

export type DeliveryOutcome =
  | { outcome: 'sent'; status: number }
  | { outcome: 'removed'; status: number | null; reason: string }
  | { outcome: 'rejected'; status: number | null; reason: string }
  | { outcome: 'skipped'; reason: string };

/** Thrown for 429, 5xx and network failures so pg-boss retries with bounded backoff. */
export class RetryableDeliveryError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

const PRIVATE_RANGES: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
];
const privateAddresses = new BlockList();
for (const [address, prefix, family] of PRIVATE_RANGES) privateAddresses.addSubnet(address, prefix, family);

/**
 * Resolves the push service host and refuses private, loopback and link-local addresses at
 * connect time, so a user-supplied endpoint cannot make the worker reach internal services
 * (including through DNS rebinding between validation and connection).
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const list = addresses as unknown as LookupAddress[];
    const blocked = list.find((entry) => privateAddresses.check(entry.address, entry.family === 6 ? 'ipv6' : 'ipv4'));
    if (!list.length || blocked) {
      const refused = Object.assign(new Error(`Push endpoint ${hostname} resolves to a non-public address`), { code: 'EPUSHPRIVATE' });
      return callback(refused, '', 0);
    }
    if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

export function createPushAgent(config: Extract<PushSenderConfig, { status: 'available' }>) {
  return new https.Agent({ keepAlive: true, maxSockets: 16, ...(config.allowPrivateNetwork ? {} : { lookup: publicOnlyLookup }) });
}

const JWT_LIFETIME_SECONDS = 12 * 3600;
const JWT_RENEW_BEFORE_SECONDS = 3600;
const vapidHeaders = new Map<string, { authorization: string; expiresAt: number }>();

/**
 * VAPID Authorization per push service origin, reused until an hour before it expires. Apple's
 * push service asks senders not to refresh the JWT more than once per hour; web-push's default
 * would sign a new one for every request.
 */
export function vapidAuthorization(config: Extract<PushSenderConfig, { status: 'available' }>, endpoint: string, now = Date.now()) {
  const audience = new URL(endpoint).origin;
  const key = `${config.publicKey}|${audience}`;
  const cached = vapidHeaders.get(key);
  const nowSeconds = Math.floor(now / 1000);
  if (cached && cached.expiresAt - JWT_RENEW_BEFORE_SECONDS > nowSeconds) return cached.authorization;
  const expiresAt = nowSeconds + JWT_LIFETIME_SECONDS;
  const { Authorization } = webpush.getVapidHeaders(audience, config.subject, config.publicKey, config.privateKey, 'aes128gcm', expiresAt);
  vapidHeaders.set(key, { authorization: Authorization, expiresAt });
  return Authorization;
}

export interface DeliveryDependencies {
  db: Database;
  config: PushSenderConfig;
  agent?: https.Agent;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

async function recordFailure(db: Database, subscriptionId: string, status: number | null) {
  await db.update(schema.pushSubscriptions)
    .set({ lastFailureAt: new Date(), lastFailureStatus: status })
    .where(eq(schema.pushSubscriptions.id, subscriptionId));
}

/**
 * Sends one notification to one subscription. Before sending it rechecks, in one query, that
 * the recipient account still exists and that both the subscription and the notification still
 * belong to it; a device that moved to another account or a removed user receives nothing.
 */
export async function deliverPush(deps: DeliveryDependencies, job: PushSendJob): Promise<DeliveryOutcome> {
  const { db, config } = deps;
  if (config.status === 'unavailable') return { outcome: 'skipped', reason: 'push unavailable' };
  const [target] = await db.select({
    subscription: schema.pushSubscriptions,
    notification: { id: schema.notifications.id, title: schema.notifications.title, body: schema.notifications.body, url: schema.notifications.url },
  }).from(schema.pushSubscriptions)
    .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.pushSubscriptions.userId))
    .innerJoin(schema.notifications, and(eq(schema.notifications.id, job.notificationId), eq(schema.notifications.userId, schema.pushSubscriptions.userId)))
    .where(and(eq(schema.pushSubscriptions.id, job.subscriptionId), eq(schema.pushSubscriptions.userId, job.userId)));
  if (!target) return { outcome: 'skipped', reason: 'recipient, subscription or notification no longer matches' };
  const { subscription, notification } = target;

  if (subscription.expirationTime && subscription.expirationTime.getTime() <= Date.now()) {
    await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, subscription.id));
    return { outcome: 'removed', status: null, reason: 'subscription expired' };
  }
  const violation = pushEndpointViolation(subscription.endpoint);
  if (violation) {
    await recordFailure(db, subscription.id, null);
    return { outcome: 'rejected', status: null, reason: violation };
  }

  const payload: PushPayload = { notificationId: notification.id, title: notification.title, body: notification.body, url: notification.url ?? '/' };
  try {
    const result = await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      {
        headers: { Authorization: vapidAuthorization(config, subscription.endpoint) },
        TTL: 24 * 3600,
        urgency: 'normal',
        contentEncoding: 'aes128gcm',
        timeout: 10_000,
        agent: deps.agent ?? createPushAgent(config),
      },
    );
    await db.update(schema.pushSubscriptions)
      .set({ lastSuccessAt: sql`now()`, lastFailureAt: null, lastFailureStatus: null })
      .where(eq(schema.pushSubscriptions.id, subscription.id));
    return { outcome: 'sent', status: result.statusCode };
  } catch (error) {
    if (error instanceof WebPushError) {
      const status = error.statusCode;
      if (status === 404 || status === 410) {
        // The push service says this subscription is gone for good.
        await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, subscription.id));
        return { outcome: 'removed', status, reason: 'push service reports the subscription is gone' };
      }
      await recordFailure(db, subscription.id, status);
      if (status === 429 || status >= 500) throw new RetryableDeliveryError(`Push service answered ${status}`, status);
      // 400/401/403/413: retrying cannot help. 403 usually means the VAPID key changed since
      // this browser subscribed; the client re-subscribes with the current key on next start.
      deps.log?.('Push rejected by push service', { status, subscriptionId: subscription.id });
      return { outcome: 'rejected', status, reason: `push service answered ${status}` };
    }
    const code = (error as { code?: string }).code;
    await recordFailure(db, subscription.id, null);
    if (code === 'EPUSHPRIVATE') return { outcome: 'rejected', status: null, reason: (error as Error).message };
    throw new RetryableDeliveryError(`Push delivery failed: ${(error as Error).message}`, null);
  }
}
