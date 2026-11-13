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

const NOT_CONFIGURED = 'Web Push is not configured: set FLUX_VAPID_PUBLIC_KEY and FLUX_VAPID_PRIVATE_KEY';

/**
 * The contact a push service gets when none is set and the address is not https (#1471): such an address cannot receive push on iPhone or iPad
 * anyway, and desktop push services accept it. It is also what ./flux up of v0.2.0 wrote into docker/.env; Apple refuses it, so a file that still
 * holds it counts as not set and takes the https address once there is one.
 */
export const LOCAL_VAPID_SUBJECT = 'mailto:admin@localhost.localdomain';

/** The public address when it is https: the contact Apple can reach without anyone naming a mailbox. */
function httpsOrigin(env: NodeJS.ProcessEnv): string | null {
  try {
    const url = new URL(env.FLUX_PUBLIC_ORIGIN?.trim() ?? '');
    return url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

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
 * The worker signs with the private key. The two keys are required together, and the public key must match the private key so the API
 * never advertises a key the worker cannot use. The contact (FLUX_VAPID_SUBJECT) is optional: empty, it is the public https address
 * (FLUX_PUBLIC_ORIGIN), which Apple's push service accepts (#1471); without an https address it is a local placeholder.
 */
export function loadPushSenderConfig(env: NodeJS.ProcessEnv = process.env): PushSenderConfig {
  const publicKey = env.FLUX_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.FLUX_VAPID_PRIVATE_KEY?.trim() ?? '';
  const given = env.FLUX_VAPID_SUBJECT?.trim() ?? '';
  const configured = given === LOCAL_VAPID_SUBJECT ? '' : given;
  const allowPrivateNetwork = flag(env, 'FLUX_PUSH_ALLOW_PRIVATE_NETWORK');
  if (!publicKey && !privateKey && !given) return { status: 'unavailable', reason: NOT_CONFIGURED };
  if (!publicKey || !privateKey) throw new Error('FLUX_VAPID_PUBLIC_KEY and FLUX_VAPID_PRIVATE_KEY must be set together (FLUX_VAPID_SUBJECT is optional)');
  if (!isP256PublicKey(publicKey)) throw new Error('FLUX_VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key (65 bytes)');
  if (publicKeyFromPrivate(privateKey) !== publicKey.replace(/=+$/, '')) throw new Error('FLUX_VAPID_PUBLIC_KEY does not belong to FLUX_VAPID_PRIVATE_KEY');
  const subject = configured || httpsOrigin(env) || LOCAL_VAPID_SUBJECT;
  if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\/[^\s/]+/.test(subject)) {
    throw new Error('FLUX_VAPID_SUBJECT must be a mailto: address or an https: URL for the operator');
  }
  return { status: 'available', publicKey: publicKey.replace(/=+$/, ''), privateKey: privateKey.replace(/=+$/, ''), subject, allowPrivateNetwork };
}

/** What to do about a contact Apple refuses (#1471); the same words at startup and when a push service refuses a send. */
export const PUSH_CONTACT_FIX = 'Set FLUX_PUBLIC_ORIGIN to your public https address and leave FLUX_VAPID_SUBJECT empty (Flux then uses that address), or set FLUX_VAPID_SUBJECT to a mailto: address at your own domain; then start Flux again so the worker reads it.';

/** Host suffixes that cannot receive mail or serve a public site: localhost, mDNS and the RFC 2606/6761 reserved names. */
const UNREACHABLE_CONTACT_HOST = /(^|\.)(localhost|localdomain|local|test|example|invalid|internal|home\.arpa)$/;

/**
 * Apple's push service refuses a VAPID contact it cannot reach with 403 BadJwtToken, so iPhone and iPad
 * notifications fail while other push services accept the same token (#20, observed 2026-10-05 for
 * `example.test`). Returns a warning for such a contact, or null. The configuration still loads: desktop
 * and Android delivery and local development keep working.
 */
export function vapidSubjectWarning(subject: string): string | null {
  const host = (subject.startsWith('mailto:') ? subject.slice(subject.lastIndexOf('@') + 1) : hostOf(subject)).toLowerCase().replace(/\.$/, '');
  if (host && host.includes('.') && !UNREACHABLE_CONTACT_HOST.test(host) && !/^[\d.]+$|^\[|:/.test(host)) return null;
  return `The push contact ${subject} is not reachable; Apple's push service refuses it, so iPhone and iPad notifications fail. ${PUSH_CONTACT_FIX}`;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
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
