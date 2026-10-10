import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { PushSubscriptionSummary } from '@flux/contracts';
import { expectStatus, person, addMember, workspace, password, type Person } from '../support/people.js';
import { recordedPushes, testSubscription, waitFor, type TestSubscription } from '../support/push.js';

/**
 * Browser Web Push flows in Chromium (issue #20, MOB-4): turning notifications on for this device
 * stores the subscription on the server; a muted place sends nothing; turning notifications off
 * removes the subscription. The page, its Settings controls, the permission, the service worker
 * and the API and worker are real. The browser's own push service (FCM here) is outside this
 * network, so the browser's PushManager is replaced by one fixed subscription whose endpoint is
 * the local push mock; delivery attempts are read from that mock, the worker's real sender.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});

/**
 * The browser side of PushManager, fixed to one subscription; the app's own code runs unchanged.
 * Sent as plain script text so no transpiler helper has to exist in the page.
 */
function pushManagerStub(subscription: TestSubscription) {
  const script = `(() => {
    // A browser keeps its push subscription across page loads; mirror that in localStorage.
    const KEY = 'flux-test-push-subscription';
    const endpoint = ${JSON.stringify(subscription.endpoint)};
    const keys = ${JSON.stringify(subscription.keys)};
    const load = () => { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (error) { return null; } };
    const save = (value) => { try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch (error) { /* private windows */ } };
    const make = (applicationServerKey) => ({
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey },
      toJSON: () => ({ endpoint, expirationTime: null, keys }),
      unsubscribe: async () => { save(null); return true; },
    });
    const restore = () => { const saved = load(); return saved ? make(new Uint8Array(saved.key).buffer) : null; };
    const proto = PushManager.prototype;
    proto.subscribe = async function (options) {
      const existing = restore();
      if (existing) return existing;
      const key = options.applicationServerKey;
      const bytes = ArrayBuffer.isView(key) ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength) : new Uint8Array(key);
      save({ key: Array.from(bytes) });
      return make(bytes.slice().buffer);
    };
    proto.getSubscription = async function () { return restore(); };
    proto.permissionState = async function () { return 'granted'; };
    // The notification permission is granted by the test; this stands in for the browser's own
    // answer, which headless Chromium reported as "denied" even after the grant (observed 2026-10-10).
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
  })();`;
  return script;
}

async function sendDirectMessage(owner: Person, dmId: string, text: string) {
  expectStatus(await owner.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body: text, clientMessageId: randomUUID() } }), 201, 'send a direct message');
}

/** What the page shows and what the browser reports about push, for a failure message. */
async function explainPage(page: Page): Promise<string> {
  const text = await page.locator('body').innerText().catch(() => '(no body text)');
  const browserState = await page.evaluate(`(async () => {
    const publicKey = await fetch('/api/v1/push/public-key', { credentials: 'same-origin' })
      .then(async (response) => response.status + ' ' + (await response.text()).slice(0, 200)).catch((error) => String(error));
    return JSON.stringify({
      url: location.href,
      secureContext: isSecureContext,
      permission: 'Notification' in window ? Notification.permission : 'no Notification',
      pushManager: 'PushManager' in window,
      publicKey,
    });
  })()`);
  const root = await page.evaluate(`(document.querySelector('#root') || document.body).innerHTML.slice(0, 600)`);
  return `browser: ${browserState}\npage text: ${text.slice(0, 1200)}\nroot html: ${root}`;
}

async function signIn(page: Page, email: string) {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

test('turn on, mute and turn off notifications on this device; the server stores, skips and removes the subscription', async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let context: BrowserContext | undefined;
  try {
    const owner = await person('Push owner');
    const reader = await person('Push reader');
    const ws = await workspace(owner, 'Push studio');
    await addMember(owner, ws.id, reader, 'member');
    // A 1:1 direct message from the owner; the reader sees it as a place they can mute.
    const dm = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [reader.id] } }), 201, 'open a direct message') as { id: string };

    const subscription = testSubscription('push');
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB', serviceWorkers: 'allow' });
    await context.grantPermissions(['notifications'], { origin });
    await context.addInitScript(pushManagerStub(subscription));
    const page = await context.newPage();
    const pageProblems: string[] = [];
    page.on('pageerror', (error) => pageProblems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') pageProblems.push(`${message.type()}: ${message.text()}`); });
    await signIn(page, reader.email);
    pageProblems.length = 0;

    // Turn on notifications on this device: the subscription is stored on the server for this session.
    await page.goto(`${origin}/settings/notifications`);
    const turnOn = page.getByRole('button', { name: 'Turn on notifications' });
    await turnOn.waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
      throw new Error(`The device control offers no "Turn on notifications" button.\n${await explainPage(page)}\nproblems: ${pageProblems.slice(0, 12).join(' | ')}\n${String(error)}`);
    });
    await turnOn.click();
    await page.getByText('Notifications are on for this device.').waitFor({ timeout: 20_000 });
    const stored = expectStatus(await reader.browser.request('GET', '/api/v1/push/subscriptions'), 200) as PushSubscriptionSummary[];
    assert.equal(stored.length, 1, 'one subscription stored for the reader');
    assert.equal(stored[0]!.endpointOrigin, new URL(subscription.endpoint).origin);

    // Control: with notifications on, a direct message is delivered to this device.
    await sendDirectMessage(owner, dm.id, 'First message, before mute');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).filter((push) => push.status === 201 && push.vapid.ok).length === 1, 'the first push to reach the push service');

    // Mute the direct message in Settings: the next message creates no push and no delivery attempt.
    await page.goto(`${origin}/settings/notifications`);
    await page.getByLabel('Place to mute').selectOption(`dm:${dm.id}`);
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    await page.getByRole('button', { name: 'Unmute' }).waitFor({ timeout: 20_000 });
    await sendDirectMessage(owner, dm.id, 'Second message, while muted');
    await page.waitForTimeout(5_000);
    assert.equal((await recordedPushes(subscription.mockId)).length, 1, 'no delivery attempt while the place is muted');

    // Unmute: the next message is delivered again, so the earlier silence was the mute.
    await page.getByRole('button', { name: 'Unmute' }).click();
    await page.getByRole('button', { name: 'Mute', exact: true }).waitFor({ timeout: 20_000 });
    await sendDirectMessage(owner, dm.id, 'Third message, after unmute');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).length === 2, 'the push after unmuting');

    // Turn off on this device: the browser subscription and the server row are both removed.
    await page.goto(`${origin}/settings/notifications`);
    await page.getByRole('button', { name: 'Turn off on this device' }).click();
    await page.getByRole('button', { name: 'Turn on notifications' }).waitFor({ timeout: 20_000 });
    assert.deepEqual(expectStatus(await reader.browser.request('GET', '/api/v1/push/subscriptions'), 200), [], 'the server no longer holds this device');
    await sendDirectMessage(owner, dm.id, 'Fourth message, after turning off');
    await page.waitForTimeout(5_000);
    assert.equal((await recordedPushes(subscription.mockId)).length, 2, 'no delivery attempt after turning off');
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});
