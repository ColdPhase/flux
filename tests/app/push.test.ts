import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PgBoss } from 'pg-boss';
import { createDatabase } from '@flux/db';
import {
  PUSH_SEND_JOB,
  createNotification,
  isSafeAppPath,
  NotFoundError,
  loadPushSenderConfig,
  loadPushServerConfig,
  pushEndpointViolation,
  type PushSendJob,
} from '@flux/core';
import type { InboxResponse, PushPayload, PushSubscriptionSummary } from '@flux/contracts';
import { deliverPush, RetryableDeliveryError } from '../../apps/worker/src/push/index.js';
import { vapidAuthorization } from '../../apps/worker/src/push/deliver.js';
import { createNotifier, notificationUnitOfWork } from '../../apps/server/src/push/adapters.js';
import { Browser, publicOrigin, register, signIn, uniqueEmail, waitForMail } from './support/http.js';
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
const notify = createNotifier(db, boss);

/** Creates notifications with real rows and policy, but captures the push jobs instead of queueing them. */
function capturingNotifier() {
  const jobs: PushSendJob[] = [];
  const uow = notificationUnitOfWork(db, () => ({ enqueuePushSend: async (job) => { jobs.push(job); return randomUUID(); } }));
  return { jobs, notify: (input: Parameters<typeof notify>[0]) => createNotification(uow, input) };
}

interface Person {
  browser: Browser;
  userId: string;
  email: string;
  sessionId: string;
  /** A workspace this person owns, used as the source of their own notifications. */
  workspaceId: string;
}

async function person(label: string): Promise<Person> {
  const email = uniqueEmail(label);
  const { browser } = await register(email, password);
  const me = (await browser.request('GET', '/api/v1/me')).json as { user: { id: string }; session: { id: string } };
  const workspace = await browser.request('POST', '/api/v1/workspaces', { body: { name: `${label} space` } });
  assert.equal(workspace.status, 201, workspace.text);
  return { browser, email, userId: me.user.id, sessionId: me.session.id, workspaceId: (workspace.json as { id: string }).id };
}

/** A notification about the recipient's own workspace, which they can always read. */
function own(recipient: Person, fields: { title: string; body?: string; url?: string | null }) {
  return { userId: recipient.userId, source: { type: 'workspace' as const, id: recipient.workspaceId }, ...fields };
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

  test('subscribe is idempotent per endpoint, stores user, session and device, and never echoes keys', async () => {
    const { browser, userId, sessionId } = await person('subscribe');
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
    const stored = await pool.query('SELECT user_id, session_id, endpoint, p256dh, auth, user_agent FROM push_subscriptions WHERE id = $1', [id]);
    assert.deepEqual(stored.rows[0], { user_id: userId, session_id: sessionId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, user_agent: 'FluxTest/1.0 (Android)' });
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
    const recipient = await person('delivery');
    const { subscription, id } = await subscribe(recipient.browser);
    const created = await notify(own(recipient, { title: 'Ana replied in Launch plan', body: 'Sounds good, shipping Friday.', url: '/projects/launch?thread=1' }));
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
    assert.deepEqual(payload, { preview: 'full', notificationId: created.id, title: 'Ana replied in Launch plan', body: 'Sounds good, shipping Friday.', url: '/projects/launch?thread=1' });
    await waitFor(async () => (await pool.query('SELECT 1 FROM push_subscriptions WHERE id = $1 AND last_success_at IS NOT NULL', [id])).rowCount, 'last_success_at');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await recordedPushes(subscription.mockId)).length, 1, 'delivered exactly once');
  });

  test('deletes a subscription whose push service answers 410 Gone', async () => {
    const recipient = await person('gone');
    const { subscription, id } = await subscribe(recipient.browser, 'gone');
    await notify(own(recipient, { title: 'Gone device', url: '/' }));
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
    await pool.query("INSERT INTO notifications(id, user_id, workspace_id, source_type, source_id, title, body) VALUES ($1, $2, $3, 'workspace', $3, $4, $5)",
      [notificationId, owner.userId, owner.workspaceId, 'Private project text', 'Do not leak']);
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

  test('account deletion deletes the subscriptions; a queued send is not delivered', async () => {
    // The recipient is a member of someone else's workspace (a workspace creator cannot be deleted).
    const host = await person('recheck-host');
    const recipient = await register(uniqueEmail('recheck-deleted'), password);
    const me = (await recipient.browser.request('GET', '/api/v1/me')).json as { user: { id: string; email: string } };
    assert.equal((await host.browser.request('POST', `/api/v1/workspaces/${host.workspaceId}/members`, { body: { email: me.user.email, role: 'member' } })).status, 201);
    const { subscription, id } = await subscribe(recipient.browser);
    const captured = capturingNotifier();
    await captured.notify({ userId: me.user.id, source: { type: 'workspace', id: host.workspaceId }, title: 'Private text' });
    assert.equal(captured.jobs.length, 1);
    await pool.query('DELETE FROM auth_users WHERE id = $1', [me.user.id]);
    assert.equal(await subscriptionExists(id), false, 'the account\'s subscriptions are gone');
    assert.equal((await deliverPush({ db, config: sender }, captured.jobs[0]!)).outcome, 'skipped');
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);
  });

  test('an expired session stops delivery and removes the subscription', async () => {
    const { subscription, sessionId, id, job } = await prepared();
    await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sessionId]);
    assert.deepEqual(await deliverPush({ db, config: sender }, job), { outcome: 'removed', status: null, reason: 'the subscribing session has ended' });
    assert.equal(await subscriptionExists(id), false);
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
    const older = await notify(own(me, { title: 'Older', body: 'first' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await notify(own(me, { title: 'Newer', body: 'second', url: '/projects/p' }));
    await notify(own(other, { title: 'Not mine' }));
    await assert.rejects(notify(own(me, { title: 'x', url: '//evil.example' })), /same-origin path/);

    const inbox = (await me.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(inbox.items.map((item) => item.title), ['Newer', 'Older']);
    assert.equal(inbox.unread, 2);
    assert.equal(inbox.items[0]!.url, '/projects/p');

    assert.equal((await other.browser.request('POST', `/api/v1/inbox/${newer.id}/read`)).status, 404, 'cannot mark someone else\'s notification');
    assert.equal((await other.browser.request('GET', `/api/v1/inbox/${newer.id}`)).status, 404, 'cannot read someone else\'s notification');
    const direct = await me.browser.request('GET', `/api/v1/inbox/${newer.id}`);
    assert.equal(direct.status, 200);
    assert.deepEqual((direct.json as { source: unknown }).source, { workspaceId: me.workspaceId, type: 'workspace', id: me.workspaceId });
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

describe('notification audience follows the source (access policy)', () => {
  async function restrictedProjectWithViewer() {
    const owner = await person('audience-owner');
    const viewer = await person('audience-viewer');
    const outsider = await person('audience-outsider');
    const added = await owner.browser.request('POST', `/api/v1/workspaces/${owner.workspaceId}/members`, { body: { email: viewer.email, role: 'member' } });
    assert.equal(added.status, 201, added.text);
    const project = await owner.browser.request('POST', `/api/v1/workspaces/${owner.workspaceId}/projects`, { body: { name: 'Board pack', visibility: 'restricted' } });
    assert.equal(project.status, 201, project.text);
    const projectId = (project.json as { id: string }).id;
    const grant = await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: viewer.userId }, role: 'viewer' } });
    assert.equal(grant.status, 201, grant.text);
    return { owner, viewer, outsider, projectId, grantId: (grant.json as { id: string }).id };
  }

  test('a notification needs a source the recipient can read now', async () => {
    const { outsider, projectId, owner } = await restrictedProjectWithViewer();
    await assert.rejects(notify({ userId: outsider.userId, source: { type: 'project', id: projectId }, title: 'Board pack updated' }),
      (error: unknown) => error instanceof NotFoundError && error.code === 'SOURCE_NOT_FOUND');
    await assert.rejects(notify({ userId: outsider.userId, source: { type: 'workspace', id: owner.workspaceId }, title: 'x' }), NotFoundError);
    await assert.rejects(notify({ userId: outsider.userId, source: { type: 'nope' as 'project', id: projectId }, title: 'x' }), /source must name/);
    const stored = await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [outsider.userId]);
    assert.equal(stored.rowCount, 0, 'nothing is stored for an unreadable source');
  });

  test('grant revoked after the push was queued: no push is sent and the inbox hides it (404 by id)', async () => {
    const { owner, viewer, outsider, projectId, grantId } = await restrictedProjectWithViewer();
    const { subscription } = await subscribe(viewer.browser);
    const captured = capturingNotifier();
    const created = await captured.notify({ userId: viewer.userId, source: { type: 'project', id: projectId }, title: 'Q3 numbers are in', body: 'Revenue 4.2M', url: `/projects/${projectId}` });
    assert.equal(captured.jobs.length, 1, 'one job queued for the viewer\'s device');
    const before = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(before.items.map((item) => item.id), [created.id]);
    assert.equal(before.unread, 1);
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 200);

    const revoked = await owner.browser.request('DELETE', `/api/v1/projects/${projectId}/grants/${grantId}`);
    assert.equal(revoked.status, 204, revoked.text);

    assert.deepEqual(await deliverPush({ db, config: sender }, captured.jobs[0]!), { outcome: 'skipped', reason: 'recipient can no longer see the notification source' });
    assert.equal((await recordedPushes(subscription.mockId)).length, 0, 'nothing reached the device');
    const after = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(after, { items: [], unread: 0 }, 'not listed and not counted');
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404);
    assert.equal((await viewer.browser.request('POST', `/api/v1/inbox/${created.id}/read`)).status, 404);
    assert.equal((await outsider.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404, 'another user still gets 404');
    assert.equal((await owner.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404, 'even a manager cannot read someone else\'s inbox');

    // Access restored: the row is visible again (it was never shown to anyone else).
    const regrant = await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: viewer.userId }, role: 'viewer' } });
    assert.equal(regrant.status, 201);
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 200);
  });

  test('a draft source follows draft visibility; a denied grant hides project notifications', async () => {
    const { owner, viewer, projectId } = await restrictedProjectWithViewer();
    const draft = await owner.browser.request('POST', `/api/v1/workspaces/${owner.workspaceId}/drafts`, { body: { title: 'Minutes', projectId } });
    assert.equal(draft.status, 201, draft.text);
    const { id: draftId, version } = draft.json as { id: string; version: number };
    await assert.rejects(notify({ userId: viewer.userId, source: { type: 'draft', id: draftId }, title: 'Minutes drafted' }), NotFoundError, 'a private draft is not readable by the viewer');
    assert.equal((await owner.browser.request('POST', `/api/v1/drafts/${draftId}/share`, { body: { scope: 'project', projectId }, headers: { 'if-match': `"${version}"` } })).status, 200);
    const aboutDraft = await notify({ userId: viewer.userId, source: { type: 'draft', id: draftId }, title: 'Minutes shared' });
    const aboutProject = await notify({ userId: viewer.userId, source: { type: 'project', id: projectId }, title: 'Board pack' });
    const ownWorkspace = await notify(own(viewer, { title: 'Own space' }));
    const listed = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(new Set(listed.items.map((item) => item.id)), new Set([aboutDraft.id, aboutProject.id, ownWorkspace.id]));

    const denied = await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: viewer.userId }, role: 'denied' } });
    assert.equal(denied.status, 201, denied.text);
    const after = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(after.items.map((item) => item.id), [ownWorkspace.id], 'explicit deny hides both project and draft notifications');
    assert.equal(after.unread, 1);
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${aboutDraft.id}`)).status, 404);
  });

  test('removal from the workspace hides every notification from that workspace', async () => {
    const { owner, viewer, projectId } = await restrictedProjectWithViewer();
    const created = await notify({ userId: viewer.userId, source: { type: 'workspace', id: owner.workspaceId }, title: 'Welcome to the space' });
    await notify({ userId: viewer.userId, source: { type: 'project', id: projectId }, title: 'Board pack' });
    const removed = await owner.browser.request('DELETE', `/api/v1/workspaces/${owner.workspaceId}/members/${viewer.userId}`);
    assert.equal(removed.status, 204, removed.text);
    assert.deepEqual((await viewer.browser.request('GET', '/api/v1/inbox')).json, { items: [], unread: 0 });
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404);
  });
});

describe('subscriptions are bound to the signed-in session', () => {
  async function queuedFor(recipient: Person) {
    const captured = capturingNotifier();
    await captured.notify(own(recipient, { title: 'Private text for this account' }));
    return captured.jobs;
  }

  async function assertNotDelivered(jobs: PushSendJob[], mockId: string) {
    for (const job of jobs) assert.equal((await deliverPush({ db, config: sender }, job)).outcome, 'skipped');
    assert.equal((await recordedPushes(mockId)).length, 0, 'nothing reached the device');
  }

  test('sign-out deletes this session\'s subscription and a queued send is not delivered', async () => {
    const recipient = await person('signout');
    const { subscription, id } = await subscribe(recipient.browser);
    const jobs = await queuedFor(recipient);
    assert.equal(jobs.length, 1);
    assert.equal((await recipient.browser.request('POST', '/api/auth/sign-out', { body: {} })).status, 200);
    assert.equal(await subscriptionExists(id), false);
    await assertNotDelivered(jobs, subscription.mockId);
  });

  test('revoking one session deletes only that session\'s subscription', async () => {
    const recipient = await person('revoke-one');
    const phone = (await signIn(recipient.email, password)).browser;
    const phoneSession = ((await phone.request('GET', '/api/v1/me')).json as { session: { id: string } }).session.id;
    const phoneSubscription = await subscribe(phone);
    const laptopSubscription = await subscribe(recipient.browser);
    const jobs = await queuedFor(recipient);
    assert.equal(jobs.length, 2);
    assert.equal((await recipient.browser.request('DELETE', `/api/v1/sessions/${phoneSession}`)).status, 204);
    assert.equal(await subscriptionExists(phoneSubscription.id), false, 'the revoked phone is unsubscribed');
    assert.equal(await subscriptionExists(laptopSubscription.id), true, 'the current device keeps its subscription');
    const phoneJob = jobs.find((job) => job.subscriptionId === phoneSubscription.id)!;
    await assertNotDelivered([phoneJob], phoneSubscription.subscription.mockId);
    const laptopJob = jobs.find((job) => job.subscriptionId === laptopSubscription.id)!;
    assert.equal((await deliverPush({ db, config: sender }, laptopJob)).outcome, 'sent');
  });

  test('revoke-others deletes the other sessions\' subscriptions', async () => {
    const recipient = await person('revoke-others');
    const phone = (await signIn(recipient.email, password)).browser;
    const phoneSubscription = await subscribe(phone);
    const laptopSubscription = await subscribe(recipient.browser);
    const jobs = await queuedFor(recipient);
    const revoked = await recipient.browser.request('POST', '/api/v1/sessions/revoke-others');
    assert.equal(revoked.status, 200);
    assert.equal(await subscriptionExists(phoneSubscription.id), false);
    assert.equal(await subscriptionExists(laptopSubscription.id), true);
    await assertNotDelivered(jobs.filter((job) => job.subscriptionId === phoneSubscription.id), phoneSubscription.subscription.mockId);
  });

  test('a password reset deletes every session\'s subscriptions', async () => {
    const recipient = await person('push-reset');
    const phone = (await signIn(recipient.email, password)).browser;
    const phoneSubscription = await subscribe(phone);
    const laptopSubscription = await subscribe(recipient.browser);
    const jobs = await queuedFor(recipient);
    const request = await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email: recipient.email, redirectTo: `${publicOrigin}/reset-password` } });
    assert.equal(request.status, 200);
    const token = (await waitForMail(recipient.email)).match(/reset-password\/([^?\s]+)/)?.[1];
    assert.ok(token);
    assert.equal((await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'a brand new long passphrase' } })).status, 200);
    assert.equal(await subscriptionExists(phoneSubscription.id), false);
    assert.equal(await subscriptionExists(laptopSubscription.id), false);
    await assertNotDelivered(jobs.filter((job) => job.subscriptionId === phoneSubscription.id), phoneSubscription.subscription.mockId);
    await assertNotDelivered(jobs.filter((job) => job.subscriptionId === laptopSubscription.id), laptopSubscription.subscription.mockId);
  });

  test('re-subscribing after signing in again binds the device to the new session', async () => {
    const recipient = await person('resubscribe');
    const { subscription } = await subscribe(recipient.browser);
    await recipient.browser.request('POST', '/api/auth/sign-out', { body: {} });
    const again = (await signIn(recipient.email, password)).browser;
    const session = ((await again.request('GET', '/api/v1/me')).json as { session: { id: string } }).session.id;
    const saved = await again.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(subscription) });
    assert.equal(saved.status, 201, 'the old row was deleted with the old session');
    const row = await pool.query('SELECT session_id FROM push_subscriptions WHERE id = $1', [(saved.json as PushSubscriptionSummary).id]);
    assert.equal(row.rows[0]?.session_id, session);
  });
});
