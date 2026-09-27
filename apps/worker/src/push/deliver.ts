import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, type LookupFunction } from 'node:net';
import webpush, { WebPushError } from 'web-push';
import { pushDeliveryRepository } from '@flux/db';
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

/** The web-push adapter: encrypts, signs with the cached VAPID JWT and POSTs to the push service. */
export function webPushSender(config: Extract<PushSenderConfig, { status: 'available' }>, agent = createPushAgent(config)): PushSender {
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
    sender: config.status === 'available' ? webPushSender(config, deps.agent) : unavailable,
    log: deps.log,
  }, job);
}
