import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes, randomUUID, type ECDH } from 'node:crypto';
import type { PushSubscriptionSummary } from '@flux/contracts';
import { register, uniqueEmail, type Browser } from './http.js';
import { password } from './people.js';
import type { RecordedPush } from './push-mock.js';

export { waitFor } from './wait.js';

export const pushmockUrl = process.env.FLUX_PUSHMOCK_URL ?? 'http://pushmock:8081';

/** A browser-side subscription key pair, as PushManager.subscribe() would create. */
export interface TestSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ecdh: ECDH;
  authSecret: Buffer;
  mockId: string;
}

export function testSubscription(kind: 'push' | 'gone' | 'missing' | 'busy' | 'bad' = 'push'): TestSubscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const mockId = randomUUID();
  return {
    endpoint: `https://pushmock:8443/${kind}/${mockId}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    ecdh,
    authSecret,
    mockId,
  };
}

export function subscriptionBody(subscription: TestSubscription, deviceLabel?: string) {
  return { endpoint: subscription.endpoint, expirationTime: null, keys: subscription.keys, ...(deviceLabel ? { deviceLabel } : {}) };
}

export async function recordedPushes(mockId: string): Promise<RecordedPush[]> {
  const response = await fetch(`${pushmockUrl}/requests?id=${mockId}`);
  return await response.json() as RecordedPush[];
}

function hmac(key: Buffer, data: Buffer) {
  return createHmac('sha256', key).update(data).digest();
}

/** Decrypts an RFC 8291 aes128gcm Web Push body with the subscription's private key. */
export function decryptPush(body: Buffer, subscription: TestSubscription): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const serverPublicKey = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const shared = subscription.ecdh.computeSecret(serverPublicKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscription.ecdh.getPublicKey(), serverPublicKey, Buffer.from([1])]);
  const ikm = hmac(hmac(subscription.authSecret, shared), keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('Missing final-record padding delimiter');
  return padded.subarray(0, end).toString('utf8');
}

/** A signed-in person with their own workspace and session, as a notification recipient. */
export interface PushRecipient {
  browser: Browser;
  userId: string;
  email: string;
  sessionId: string;
  /** A workspace this person owns, used as the source of their own notifications. */
  workspaceId: string;
}

export async function pushRecipient(label: string): Promise<PushRecipient> {
  const email = uniqueEmail(label);
  const { browser } = await register(email, password);
  const me = (await browser.request('GET', '/api/v1/me')).json as { user: { id: string }; session: { id: string } };
  const workspace = await browser.request('POST', '/api/v1/workspaces', { body: { name: `${label} space` } });
  assert.equal(workspace.status, 201, workspace.text);
  return { browser, email, userId: me.user.id, sessionId: me.session.id, workspaceId: (workspace.json as { id: string }).id };
}

/** A notification about the recipient's own workspace, which they can always read. */
export function own(recipient: PushRecipient, fields: { title: string; body?: string; url?: string | null }) {
  return { userId: recipient.userId, source: { type: 'workspace' as const, id: recipient.workspaceId }, ...fields };
}

/** Subscribes this browser's session to push through the API, as the service worker would. */
export async function subscribe(browser: Browser, kind: Parameters<typeof testSubscription>[0] = 'push') {
  const subscription = testSubscription(kind);
  const response = await browser.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(subscription, 'Test phone'), headers: { 'user-agent': 'FluxTest/1.0 (Android)' } });
  assert.equal(response.status, 201, response.text);
  return { subscription, id: (response.json as PushSubscriptionSummary).id };
}
