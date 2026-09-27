import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PgBoss } from 'pg-boss';
import { createDatabase } from '@flux/db';
import {
  PUSH_SEND_JOB,
  createNotification,
  isSafeAppPath,
  loadPushSenderConfig,
  loadPushServerConfig,
  pushEndpointViolation,
  type PushSendJob,
} from '@flux/core';
import type { InboxResponse, PushPayload, PushSubscriptionSummary } from '@flux/contracts';
import { deliverPush, RetryableDeliveryError } from '../../apps/worker/src/push/index.js';
import { vapidAuthorization } from '../../apps/worker/src/push/deliver.js';
import { Browser, register, uniqueEmail } from './support/http.js';
import { decryptPush, recordedPushes, subscriptionBody, testSubscription, waitFor } from './support/push.js';

// Web Push and inbox checks (issue #41) against the running API and worker containers, a local
// push service mock over https, and in-process delivery for the recheck paths.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
const boss = new PgBoss({ connectionString, migrate: false });
before(() => boss.start());
after(async () => { await boss.stop(); await pool.end(); });

const password = 'correct horse battery staple';
const sender = loadPushSenderConfig();

async function person(label: string) {
  const { browser } = await register(uniqueEmail(label), password);
  const me = await browser.request('GET', '/api/v1/me');
  return { browser, userId: (me.json as { user: { id: string } }).user.id };
}

async function subscribe(browser: Browser, kind: Parameters<typeof testSubscription>[0] = 'push') {
  const subscription = testSubscription(kind);
  const response = await browser.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(subscription, 'Test phone'), headers: { 'user-agent': 'FluxTest/1.0 (Android)' } });
  assert.equal(response.status, 201, response.text);
  return { subscription, id: (response.json as PushSubscriptionSummary).id };
}

async function subscriptionExists(id: string) {
  return (await pool.query('SELECT 1 FROM push_subscriptions WHERE id = $1', [id])).rowCount === 1;
}

describe('push configuration', () => {
  test('the sender needs all three VAPID values, a matching pair and an operator contact', () => {
    assert.equal(loadPushSenderConfig({}).status, 'unavailable');
    assert.equal(loadPushServerConfig({}).status, 'unavailable');
    assert.equal(sender.status, 'available', 'the test run configures generated VAPID keys');
    if (sender.status !== 'available') return;
    const { publicKey, privateKey, subject } = sender;
    assert.throws(() => loadPushSenderConfig({ FLUX_VAPID_PUBLIC_KEY: publicKey }), /must be set together/);
    assert.throws(() => loadPushSenderConfig({ FLUX_VAPID_PUBLIC_KEY: publicKey, FLUX_VAPID_PRIVATE_KEY: privateKey, FLUX_VAPID_SUBJECT: 'ops@example.test' }), /mailto: address or an https: URL/);
    const other = testSubscription().keys.p256dh;
    assert.throws(() => loadPushSenderConfig({ FLUX_VAPID_PUBLIC_KEY: other, FLUX_VAPID_PRIVATE_KEY: privateKey, FLUX_VAPID_SUBJECT: subject }), /does not belong/);
    assert.throws(() => loadPushServerConfig({ FLUX_VAPID_PUBLIC_KEY: 'not-a-key' }), /P-256 public key/);
    assert.deepEqual(loadPushServerConfig({ FLUX_VAPID_PUBLIC_KEY: publicKey }), { status: 'available', publicKey });
  });

  test('the VAPID JWT is reused per push service for hours, not signed per request', () => {
    assert.equal(sender.status, 'available');
    if (sender.status !== 'available') return;
    const start = Date.now();
    const first = vapidAuthorization(sender, 'https://web.push.apple.com/abc', start);
    assert.match(first, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(vapidAuthorization(sender, 'https://web.push.apple.com/other-device', start + 3600_000), first, 'same origin within the hour');
    assert.notEqual(vapidAuthorization(sender, 'https://fcm.googleapis.com/fcm/send/x', start), first, 'audience is per push service');
    assert.notEqual(vapidAuthorization(sender, 'https://web.push.apple.com/abc', start + 11.5 * 3600_000), first, 'renewed before the 12 h expiry');
  });

  test('endpoints must be public https push service URLs and links must stay in Flux', () => {
    assert.equal(pushEndpointViolation('https://fcm.googleapis.com/fcm/send/abc'), null);
    assert.equal(pushEndpointViolation('https://web.push.apple.com/QGx'), null);
    assert.match(pushEndpointViolation('http://fcm.googleapis.com/x') ?? '', /https/);
    assert.match(pushEndpointViolation('https://169.254.169.254/latest') ?? '', /DNS name/);
    assert.match(pushEndpointViolation('https://[::1]/x') ?? '', /DNS name/);
    assert.match(pushEndpointViolation('https://localhost/x') ?? '', /local/);
    assert.match(pushEndpointViolation('https://user:pass@push.example/x') ?? '', /credentials/);
    assert.equal(isSafeAppPath('/projects/p1?tab=tasks'), true);
    for (const unsafe of ['//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '/\\evil.example', '/a\nb']) assert.equal(isSafeAppPath(unsafe), false, unsafe);
  });
});

describe('push subscriptions API', () => {
  test('requires a signed-in user', async () => {
    const anonymous = new Browser();
    assert.equal((await anonymous.request('GET', '/api/v1/push/public-key')).status, 401);
    assert.equal((await anonymous.request('GET', '/api/v1/push/subscriptions')).status, 401);
    assert.equal((await anonymous.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(testSubscription()) })).status, 401);
    assert.equal((await anonymous.request('DELETE', `/api/v1/push/subscriptions/${randomUUID()}`)).status, 401);
    assert.equal((await anonymous.request('GET', '/api/v1/inbox')).status, 401);
    assert.equal((await anonymous.request('POST', `/api/v1/inbox/${randomUUID()}/read`)).status, 401);
  });

  test('publishes the configured VAPID public key', async () => {
    const { browser } = await person('key');
    const response = await browser.request('GET', '/api/v1/push/public-key');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { status: 'available', publicKey: sender.status === 'available' ? sender.publicKey : null });
  });

  test('subscribe is idempotent per endpoint, stores user and device, and never echoes keys', async () => {
    const { browser, userId } = await person('subscribe');
    const { subscription, id } = await subscribe(browser);
    const again = await browser.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(subscription, 'Renamed phone'), headers: { 'user-agent': 'FluxTest/1.0 (Android)' } });
    assert.equal(again.status, 200, 'the same endpoint updates the existing row');
    assert.equal((again.json as PushSubscriptionSummary).id, id);
    const listed = await browser.request('GET', '/api/v1/push/subscriptions');
    const rows = listed.json as PushSubscriptionSummary[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.deviceLabel, 'Renamed phone');
    assert.equal(rows[0]!.endpointOrigin, 'https://pushmock:8443');
    assert.doesNotMatch(listed.text, new RegExp(subscription.keys.auth), 'keys are not returned');
    assert.doesNotMatch(listed.text, new RegExp(subscription.mockId), 'the endpoint path is not returned');
    const stored = await pool.query('SELECT user_id, endpoint, p256dh, auth, user_agent FROM push_subscriptions WHERE id = $1', [id]);
    assert.deepEqual(stored.rows[0], { user_id: userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, user_agent: 'FluxTest/1.0 (Android)' });
  });

  test('rejects unsafe endpoints, invalid keys and cross-origin requests', async () => {
    const { browser } = await person('reject');
    const valid = testSubscription();
    for (const endpoint of ['http://pushmock:8443/push/x', 'https://10.0.0.8/push', 'https://localhost/push', 'not a url']) {
      const response = await browser.request('POST', '/api/v1/push/subscriptions', { body: { ...subscriptionBody(valid), endpoint } });
      assert.equal(response.status, 400, endpoint);
    }
    const badKeys = await browser.request('POST', '/api/v1/push/subscriptions', { body: { ...subscriptionBody(valid), keys: { p256dh: 'AAAA', auth: valid.keys.auth } } });
    assert.equal(badKeys.status, 400);
    assert.equal((badKeys.json as { code: string }).code, 'PUSH_KEYS_INVALID');
    const foreign = await browser.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(valid), origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    assert.deepEqual((await browser.request('GET', '/api/v1/push/subscriptions')).json, [], 'nothing was stored');
  });

  test('another user cannot delete my subscription; I can', async () => {
    const me = await person('owner');
    const other = await person('intruder');
    const { id } = await subscribe(me.browser);
    assert.equal((await other.browser.request('DELETE', `/api/v1/push/subscriptions/${id}`)).status, 404);
    assert.equal((await other.browser.request('DELETE', '/api/v1/push/subscriptions/not-a-uuid')).status, 404);
    assert.equal(await subscriptionExists(id), true, 'the other user changed nothing');
    const foreign = await me.browser.request('DELETE', `/api/v1/push/subscriptions/${id}`, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal((await me.browser.request('DELETE', `/api/v1/push/subscriptions/${id}`)).status, 204);
    assert.equal(await subscriptionExists(id), false);
    assert.equal((await me.browser.request('DELETE', `/api/v1/push/subscriptions/${id}`)).status, 404);
  });

  test('a browser that signs in to another account moves its subscription to that account', async () => {
    const first = await person('first');
    const second = await person('second');
    const { subscription, id } = await subscribe(first.browser);
    const moved = await second.browser.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(subscription) });
    assert.equal(moved.status, 200);
    assert.equal((moved.json as PushSubscriptionSummary).id, id);
    assert.equal(((await first.browser.request('GET', '/api/v1/push/subscriptions')).json as unknown[]).length, 0);
    assert.equal(((await second.browser.request('GET', '/api/v1/push/subscriptions')).json as unknown[]).length, 1);
  });
});

describe('push delivery through the worker', () => {
  test('sends a VAPID-signed, encrypted notification to the push service and records success', async () => {
    const { browser, userId } = await person('delivery');
    const { subscription, id } = await subscribe(browser);
    const created = await createNotification(db, boss, { userId, title: 'Ana replied in Launch plan', body: 'Sounds good, shipping Friday.', url: '/projects/launch?thread=1' });
    assert.equal(created.jobIds.length, 1, 'one job per subscription');
    const [push] = await waitFor(async () => { const list = await recordedPushes(subscription.mockId); return list.length ? list : null; }, 'the worker to deliver');
    assert.ok(push);
    assert.equal(push.vapid.ok, true, push.vapid.error);
    assert.equal(push.vapid.publicKey, sender.status === 'available' ? sender.publicKey : '', 'signed with the configured key');
    assert.equal(push.vapid.claims?.aud, 'https://pushmock:8443');
    assert.equal(push.headers['content-encoding'], 'aes128gcm');
    assert.equal(push.headers.ttl, '86400');
    assert.equal(push.headers.urgency, 'normal');
    const body = Buffer.from(push.bodyBase64, 'base64');
    assert.ok(body.length > 86, 'an encrypted body is present');
    assert.equal(body.includes(Buffer.from('Launch plan')), false, 'the payload is not plaintext');
    const payload = JSON.parse(decryptPush(body, subscription)) as PushPayload;
    assert.deepEqual(payload, { notificationId: created.id, title: 'Ana replied in Launch plan', body: 'Sounds good, shipping Friday.', url: '/projects/launch?thread=1' });
    await waitFor(async () => (await pool.query('SELECT 1 FROM push_subscriptions WHERE id = $1 AND last_success_at IS NOT NULL', [id])).rowCount, 'last_success_at');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await recordedPushes(subscription.mockId)).length, 1, 'delivered exactly once');
  });

  test('deletes a subscription whose push service answers 410 Gone', async () => {
    const { browser, userId } = await person('gone');
    const { subscription, id } = await subscribe(browser, 'gone');
    await createNotification(db, boss, { userId, title: 'Gone device', url: '/' });
    await waitFor(async () => !(await subscriptionExists(id)), 'the dead subscription to be removed');
    assert.equal((await recordedPushes(subscription.mockId)).length, 1, 'the worker tried once, then removed it');
    const states = await waitFor(async () => {
      const jobs = await pool.query<{ state: string }>("SELECT state FROM pgboss.job WHERE name = $1 AND data->>'subscriptionId' = $2", [PUSH_SEND_JOB, id]);
      return jobs.rows.every((row) => row.state === 'completed') && jobs.rows.map((row) => row.state);
    }, 'the job to complete');
    assert.deepEqual(states, ['completed'], 'no retry for a dead endpoint');
  });

  test('push jobs have bounded retries', async () => {
    const queue = await boss.getQueue(PUSH_SEND_JOB);
    assert.ok(queue);
    assert.equal(queue.retryLimit, 5);
    assert.equal(queue.retryBackoff, true);
    assert.equal(queue.retryDelayMax, 600);
  });
});

describe('push delivery rechecks (in process)', () => {
  async function prepared(kind: Parameters<typeof testSubscription>[0] = 'push') {
    const owner = await person(`recheck-${kind}`);
    const { subscription, id } = await subscribe(owner.browser, kind);
    const notificationId = randomUUID();
    await pool.query('INSERT INTO notifications(id, user_id, title, body) VALUES ($1, $2, $3, $4)', [notificationId, owner.userId, 'Private project text', 'Do not leak']);
    const job: PushSendJob = { notificationId, subscriptionId: id, userId: owner.userId };
    return { ...owner, subscription, id, job };
  }

  test('does not send when the subscription now belongs to someone else', async () => {
    const { subscription, id, job } = await prepared();
    const other = await person('recheck-new-owner');
    await pool.query('UPDATE push_subscriptions SET user_id = $1 WHERE id = $2', [other.userId, id]);
    assert.deepEqual(await deliverPush({ db, config: sender }, job), { outcome: 'skipped', reason: 'recipient, subscription or notification no longer matches' });
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);
  });

  test('does not send when the recipient account was removed', async () => {
    const { subscription, userId, job } = await prepared();
    await pool.query('DELETE FROM auth_users WHERE id = $1', [userId]);
    assert.equal((await deliverPush({ db, config: sender }, job)).outcome, 'skipped');
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);
  });

  test('404 removes the subscription, 503 is retried, 400 is recorded without retry', async () => {
    const missing = await prepared('missing');
    assert.equal((await deliverPush({ db, config: sender }, missing.job)).outcome, 'removed');
    assert.equal(await subscriptionExists(missing.id), false);

    const busy = await prepared('busy');
    await assert.rejects(deliverPush({ db, config: sender }, busy.job), (error: unknown) => error instanceof RetryableDeliveryError && error.status === 503);
    assert.equal(await subscriptionExists(busy.id), true, 'a temporary failure keeps the subscription');

    const bad = await prepared('bad');
    assert.deepEqual(await deliverPush({ db, config: sender }, bad.job), { outcome: 'rejected', status: 400, reason: 'push service answered 400' });
    const row = await pool.query('SELECT last_failure_status FROM push_subscriptions WHERE id = $1', [bad.id]);
    assert.equal(row.rows[0]?.last_failure_status, 400);
  });

  test('refuses endpoints that resolve to private addresses unless explicitly allowed', async () => {
    const { subscription, job } = await prepared();
    assert.equal(sender.status, 'available');
    if (sender.status !== 'available') return;
    const result = await deliverPush({ db, config: { ...sender, allowPrivateNetwork: false } }, job);
    assert.equal(result.outcome, 'rejected');
    assert.match((result as { reason: string }).reason, /non-public address/);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0, 'nothing reached the private host');
  });

  test('skips quietly when push is unavailable; the inbox row remains', async () => {
    const { job } = await prepared();
    assert.deepEqual(await deliverPush({ db, config: { status: 'unavailable', reason: 'not configured' } }, job), { outcome: 'skipped', reason: 'push unavailable' });
    assert.equal((await pool.query('SELECT 1 FROM notifications WHERE id = $1', [job.notificationId])).rowCount, 1);
  });
});

describe('in-app inbox', () => {
  test('lists my notifications newest first and marks them read; others cannot', async () => {
    const me = await person('inbox');
    const other = await person('inbox-other');
    const older = await createNotification(db, boss, { userId: me.userId, title: 'Older', body: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await createNotification(db, boss, { userId: me.userId, title: 'Newer', body: 'second', url: '/projects/p' });
    await createNotification(db, boss, { userId: other.userId, title: 'Not mine' });
    await assert.rejects(createNotification(db, boss, { userId: me.userId, title: 'x', url: '//evil.example' }), /same-origin path/);

    const inbox = (await me.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(inbox.items.map((item) => item.title), ['Newer', 'Older']);
    assert.equal(inbox.unread, 2);
    assert.equal(inbox.items[0]!.url, '/projects/p');

    assert.equal((await other.browser.request('POST', `/api/v1/inbox/${newer.id}/read`)).status, 404, 'cannot mark someone else\'s notification');
    const read = await me.browser.request('POST', `/api/v1/inbox/${newer.id}/read`);
    assert.equal(read.status, 200);
    const readAt = (read.json as { readAt: string }).readAt;
    assert.ok(readAt);
    const again = await me.browser.request('POST', `/api/v1/inbox/${newer.id}/read`);
    assert.equal((again.json as { readAt: string }).readAt, readAt, 'marking read twice keeps the first time');
    const after = (await me.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.equal(after.unread, 1);
    assert.equal(after.items.find((item) => item.id === older.id)?.readAt, null);
    const limited = (await me.browser.request('GET', '/api/v1/inbox?limit=1')).json as InboxResponse;
    assert.equal(limited.items.length, 1);
  });
});
