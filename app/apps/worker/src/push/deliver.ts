import https from 'node:https';
import webpush, { WebPushError } from 'web-push';
import { pushDeliveryRepository } from '@flux/db';
import { pushPreferenceCheck, pushQuietCheck } from '../notifications/adapters.js';
import { createPublicOnlyLookup, type PublicLookupResolver } from './public-lookup.js';
import {
  deliverPushJob,
  policySourceReader,
  type Database,
  type DeliveryOutcome,
  type PushSender,
  type PushSenderConfig,
  type PushSendJob,
} from '@flux/core';

// Worker adapters for the core delivery use case (issue #46): Drizzle rows, the access policy
// and a web-push sender. The rules (rechecks, payload privacy, retry classes) live in core.

export function createPushAgent(config: Extract<PushSenderConfig, { status: 'available' }>, resolve?: PublicLookupResolver) {
  return new https.Agent({ keepAlive: true, maxSockets: 16, ...(config.allowPrivateNetwork ? {} : { lookup: createPublicOnlyLookup(resolve) }) });
}

const JWT_LIFETIME_SECONDS = 12 * 3600;
const JWT_RENEW_BEFORE_SECONDS = 3600;

/** The VAPID Authorization header for a push endpoint at a time (default now). */
export type VapidAuthorizer = (config: Extract<PushSenderConfig, { status: 'available' }>, endpoint: string, now?: number) => string;

/**
 * VAPID Authorization per push service origin, reused until an hour before it expires. Apple's
 * push service asks senders not to refresh the JWT more than once per hour; web-push's default
 * would sign a new one for every request. The cache lives in the authorizer, which the worker's
 * composition root creates once (#82).
 */
export function createVapidAuthorizer(): VapidAuthorizer {
  const headers = new Map<string, { authorization: string; expiresAt: number }>();
  return (config, endpoint, now = Date.now()) => {
    const audience = new URL(endpoint).origin;
    const key = `${config.publicKey}|${audience}`;
    const cached = headers.get(key);
    const nowSeconds = Math.floor(now / 1000);
    if (cached && cached.expiresAt - JWT_RENEW_BEFORE_SECONDS > nowSeconds) return cached.authorization;
    const expiresAt = nowSeconds + JWT_LIFETIME_SECONDS;
    const { Authorization } = webpush.getVapidHeaders(audience, config.subject, config.publicKey, config.privateKey, 'aes128gcm', expiresAt);
    headers.set(key, { authorization: Authorization, expiresAt });
    return Authorization;
  };
}

/** The web-push adapter: encrypts, signs with the authorizer's cached VAPID JWT and POSTs to the push service. */
export function webPushSender(
  config: Extract<PushSenderConfig, { status: 'available' }>,
  agent = createPushAgent(config),
  vapidAuthorization: VapidAuthorizer = createVapidAuthorizer(),
): PushSender {
  return {
    async send(subscription, payload) {
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
            agent,
          },
        );
        return { kind: 'accepted', status: result.statusCode };
      } catch (error) {
        if (error instanceof WebPushError) return { kind: 'http-error', status: error.statusCode };
        if ((error as { code?: string }).code === 'EPUSHPRIVATE') return { kind: 'refused', reason: (error as Error).message };
        return { kind: 'network', message: (error as Error).message };
      }
    },
  };
}

export interface DeliveryDependencies {
  db: Database;
  config: PushSenderConfig;
  agent?: https.Agent;
  /** The worker's VAPID authorizer; without one, each delivery signs its own JWT. */
  vapid?: VapidAuthorizer;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/** Composes the core delivery use case with this worker's adapters for one job. */
export async function deliverPush(deps: DeliveryDependencies, job: PushSendJob): Promise<DeliveryOutcome> {
  const { db, config } = deps;
  const unavailable: PushSender = { send: async () => ({ kind: 'refused', reason: 'push unavailable' }) };
  return deliverPushJob({
    available: config.status === 'available',
    targets: pushDeliveryRepository(db),
    authorizer: policySourceReader(db),
    sender: config.status === 'available' ? webPushSender(config, deps.agent, deps.vapid) : unavailable,
    stillWanted: pushPreferenceCheck(db),
    quietUntil: pushQuietCheck(db),
    log: deps.log,
  }, job);
}
