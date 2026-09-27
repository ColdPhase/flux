import { createECDH } from 'node:crypto';
import { isIP } from 'node:net';

// Push configuration and input rules (issue #41). Pure: no database, queue or HTTP imports
// (see tests/app/architecture.test.ts).

/** One job per (notification, subscription) so one slow device never delays or duplicates another. */
export const PUSH_SEND_JOB = 'push.send';

/** The retry policy of a queue, in the shape the job-queue adapter (pg-boss) accepts. */
export interface JobRetryPolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax: number;
  expireInSeconds: number;
  deleteAfterSeconds: number;
}

/** Bounded retries with exponential backoff for 429/5xx/network failures (about 10 s … 10 min). */
export const PUSH_SEND_QUEUE: JobRetryPolicy = {
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 60,
  deleteAfterSeconds: 7 * 24 * 3600,
};

export type PushServerConfig =
  | { status: 'available'; publicKey: string }
  | { status: 'unavailable'; reason: string };

export type PushSenderConfig =
  | { status: 'available'; publicKey: string; privateKey: string; subject: string; allowPrivateNetwork: boolean }
  | { status: 'unavailable'; reason: string };

const NOT_CONFIGURED = 'Web Push is not configured: set FLUX_VAPID_PUBLIC_KEY, FLUX_VAPID_PRIVATE_KEY and FLUX_VAPID_SUBJECT';

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ''), 'base64url');
}

/** An uncompressed P-256 public point (65 bytes, 0x04 prefix), as browsers and VAPID use. */
export function isP256PublicKey(value: string) {
  const bytes = decodeBase64Url(value);
  return !!bytes && bytes.length === 65 && bytes[0] === 0x04;
}

function publicKeyFromPrivate(privateKey: string) {
  const bytes = decodeBase64Url(privateKey);
  if (!bytes || bytes.length !== 32) throw new Error('FLUX_VAPID_PRIVATE_KEY must be a base64url P-256 private key (32 bytes)');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(bytes);
  return ecdh.getPublicKey().toString('base64url');
}

function flag(env: NodeJS.ProcessEnv, name: string) {
  const value = (env[name] ?? 'false').trim().toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

/** The API only needs the public key. A malformed key stops startup instead of failing silently. */
export function loadPushServerConfig(env: NodeJS.ProcessEnv = process.env): PushServerConfig {
  const publicKey = env.FLUX_VAPID_PUBLIC_KEY?.trim();
  if (!publicKey) return { status: 'unavailable', reason: NOT_CONFIGURED };
  if (!isP256PublicKey(publicKey)) throw new Error('FLUX_VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key (65 bytes)');
  return { status: 'available', publicKey: publicKey.replace(/=+$/, '') };
}

/**
 * The worker signs with the private key. All three values are required together, and the
 * public key must match the private key so the API never advertises a key the worker cannot use.
 */
export function loadPushSenderConfig(env: NodeJS.ProcessEnv = process.env): PushSenderConfig {
  const publicKey = env.FLUX_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.FLUX_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.FLUX_VAPID_SUBJECT?.trim() ?? '';
  const allowPrivateNetwork = flag(env, 'FLUX_PUSH_ALLOW_PRIVATE_NETWORK');
  const given = [publicKey, privateKey, subject].filter(Boolean).length;
  if (given === 0) return { status: 'unavailable', reason: NOT_CONFIGURED };
  if (given < 3) throw new Error('FLUX_VAPID_PUBLIC_KEY, FLUX_VAPID_PRIVATE_KEY and FLUX_VAPID_SUBJECT must be set together');
  if (!isP256PublicKey(publicKey)) throw new Error('FLUX_VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key (65 bytes)');
  if (publicKeyFromPrivate(privateKey) !== publicKey.replace(/=+$/, '')) throw new Error('FLUX_VAPID_PUBLIC_KEY does not belong to FLUX_VAPID_PRIVATE_KEY');
  if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\/[^\s/]+/.test(subject)) {
    throw new Error('FLUX_VAPID_SUBJECT must be a mailto: address or an https: URL for the operator');
  }
  return { status: 'available', publicKey: publicKey.replace(/=+$/, ''), privateKey: privateKey.replace(/=+$/, ''), subject, allowPrivateNetwork };
}

/**
 * Push endpoints are user-supplied URLs the worker will POST to. Only public https hosts
 * named by DNS are accepted; the worker additionally refuses private addresses at connect time.
 * Returns the reason for rejection, or null.
 */
export function pushEndpointViolation(endpoint: string): string | null {
  if (endpoint.length > 2048) return 'Endpoint is too long';
  let url: URL;
  try { url = new URL(endpoint); } catch { return 'Endpoint must be an absolute URL'; }
  if (url.protocol !== 'https:') return 'Endpoint must use https';
  if (url.username || url.password) return 'Endpoint must not contain credentials';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return 'Endpoint host must be a DNS name';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'Endpoint host must not be local';
  return null;
}

/** An in-app link must stay on the Flux origin: a path, never a scheme or protocol-relative URL. */
export function isSafeAppPath(value: string) {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && value.length <= 2048 && ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}

/** The browser's `auth` secret: 16 bytes, base64url. */
export function isPushAuthSecret(value: string) {
  return /^[A-Za-z0-9_-]+={0,2}$/.test(value) && Buffer.from(value.replace(/=+$/, ''), 'base64url').length === 16;
}
