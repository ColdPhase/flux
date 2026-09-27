import { randomUUID } from 'node:crypto';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { isP256PublicKey, isPushAuthSecret, pushEndpointViolation } from './config.js';
import type { PushSubscriptionRepository } from './ports.js';

/** A browser normally holds one subscription per origin; this bounds rows per account. */
export const MAX_SUBSCRIPTIONS_PER_USER = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in device that subscribes: the user and the auth session of this request. */
export interface SubscribingSession {
  userId: string;
  sessionId: string;
}

export interface SubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  deviceLabel?: string | null;
  userAgent?: string | null;
}

/**
 * Registers this device for Web Push, bound to the current session. Idempotent on endpoint:
 * the endpoint identifies a browser profile, so when another account (or a new session)
 * subscribes on that browser the row moves to it and the previous owner stops receiving there.
 */
export async function registerPushSubscription(repo: PushSubscriptionRepository, owner: SubscribingSession, input: SubscriptionInput) {
  const violation = pushEndpointViolation(input.endpoint);
  if (violation) throw new InvalidInputError(violation, 'PUSH_ENDPOINT_REJECTED');
  if (!isP256PublicKey(input.keys.p256dh) || !isPushAuthSecret(input.keys.auth)) {
    throw new InvalidInputError('Subscription keys are not a valid P-256 key and 16-byte auth secret', 'PUSH_KEYS_INVALID');
  }
  if (!await repo.endpointExists(input.endpoint) && await repo.countForUser(owner.userId) >= MAX_SUBSCRIPTIONS_PER_USER) {
    throw new ConflictError(`At most ${MAX_SUBSCRIPTIONS_PER_USER} push subscriptions per account`, 'PUSH_SUBSCRIPTION_LIMIT');
  }
  return repo.upsertByEndpoint(randomUUID(), {
    userId: owner.userId,
    sessionId: owner.sessionId,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh.replace(/=+$/, ''),
    auth: input.keys.auth.replace(/=+$/, ''),
    expirationTime: typeof input.expirationTime === 'number' ? new Date(input.expirationTime) : null,
    deviceLabel: input.deviceLabel?.trim() || null,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
  });
}

export async function removePushSubscription(repo: PushSubscriptionRepository, userId: string, id: string) {
  if (!UUID.test(id) || !await repo.deleteForUser(userId, id)) throw new NotFoundError('Subscription', 'SUBSCRIPTION_NOT_FOUND');
}
