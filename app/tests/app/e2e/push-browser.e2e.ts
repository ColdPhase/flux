import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { PushSubscriptionSummary } from '@flux/contracts';
import { expectStatus, person, addMember, removeMember, workspace, password, type Person } from '../support/people.js';
import { decryptPush, recordedPushes, testSubscription, waitFor, type TestSubscription } from '../support/push.js';
import { chooseOption } from '../support/app-select.js';

/**
 * Browser Web Push flows in Chromium (issue #20, MOB-4): turning notifications on for this device
 * stores the subscription on the server; a muted place sends nothing; turning notifications off
 * removes the subscription. The page, its Settings controls, the permission, the service worker
 * and the API and worker are real. The browser's own push service (FCM here) is outside this
 * network, so the browser's PushManager is replaced by one fixed subscription whose endpoint is
 * the local push mock; delivery attempts are read from that mock, the worker's real sender.
 * Further tests: a push to a closed app and its tap, and a refused notification permission.
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

before(async () => { await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve)); });
after(async () => {
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
});

test('turn on, mute and turn off notifications on this device; the server stores, skips and removes the subscription', async () => {
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
    await chooseOption(page.getByLabel('Place to mute'), `dm:${dm.id}`);
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
  }
});

/**
 * MOB-4: delivery to an app that is not open, and the tap. The worker's real encrypted push reaches the push mock; the
 * test decrypts it with this subscription's keys (as the browser would) and hands those exact bytes to the service worker
 * through Chromium's DevTools `ServiceWorker.deliverPushMessage`, with no Flux window open. The service worker's own
 * `push` handler shows the notification. Chromium cannot click a notification from a test, so the tap is the worker's
 * own `notificationTarget()` (the function its `notificationclick` handler awaits), then that address in a new window.
 */
test('a push reaches the closed app as a notification, and its tap opens the authorized item or, after access is removed, the start page', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let context: BrowserContext | undefined;
  try {
    const owner = await person('Closed-app owner');
    const reader = await person('Closed-app reader');
    const ws = await workspace(owner, 'Closed app studio');
    await addMember(owner, ws.id, reader, 'member');
    const dm = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [reader.id] } }), 201, 'open a direct message') as { id: string };

    const subscription = testSubscription('push');
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-GB', serviceWorkers: 'allow' });
    await context.grantPermissions(['notifications'], { origin });
    await context.addInitScript(pushManagerStub(subscription));
    const page = await context.newPage();
    await signIn(page, reader.email);
    await page.goto(`${origin}/settings/notifications`);
    await page.getByRole('button', { name: 'Turn on notifications' }).click();
    await page.getByText('Notifications are on for this device.').waitFor({ timeout: 20_000 });

    // A blank page holds the DevTools session; the Flux window itself is closed before anything is sent.
    const holder = await context.newPage();
    const cdp = await context.newCDPSession(holder);
    const registrations = new Map<string, string>();
    cdp.on('ServiceWorker.workerRegistrationUpdated', (event: { registrations: Array<{ registrationId: string; scopeURL: string; isDeleted: boolean }> }) => {
      for (const registration of event.registrations) if (!registration.isDeleted) registrations.set(registration.scopeURL, registration.registrationId);
    });
    await cdp.send('ServiceWorker.enable');
    await waitFor(async () => registrations.has(`${origin}/`), 'the Flux service worker registration');
    await page.close();
    assert.equal(context.pages().some((open) => open.url().startsWith(origin)), false, 'no Flux window is open');

    const text = `Field notes are ready ${randomUUID().slice(0, 8)}`;
    await sendDirectMessage(owner, dm.id, text);
    await waitFor(async () => (await recordedPushes(subscription.mockId)).some((push) => push.status === 201 && push.vapid.ok), 'the worker to deliver to the push service');
    const [delivered] = (await recordedPushes(subscription.mockId)).filter((push) => push.status === 201);
    const payload = decryptPush(Buffer.from(delivered!.bodyBase64, 'base64'), subscription);
    const parsed = JSON.parse(payload) as { notificationId: string; preview: string; title?: string; body?: string };
    assert.equal(parsed.preview, 'full', 'the reader can read the direct message, so the server sends its text');

    const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith(origin)) ?? await context.waitForEvent('serviceworker');
    // Record what the worker's push handler asks the system to show, then let the real call proceed. Headless
    // Chromium has no notification centre, so the call is the observable output here; its result is recorded too.
    await worker.evaluate(`(() => {
      self.__shown = [];
      const original = ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
        const entry = { title, body: options && options.body, tag: options && options.tag, notificationId: options && options.data && options.data.notificationId, result: 'pending' };
        self.__shown.push(entry);
        return original.call(this, title, options).then((value) => { entry.result = 'shown'; return value; }, (error) => { entry.result = String(error); throw error; });
      };
    })()`);
    await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registrations.get(`${origin}/`)!, data: payload });
    type Shown = { title: string; body: string; tag: string; notificationId?: string; result: string };
    let shown: Shown[] = [];
    await waitFor(async () => {
      shown = await worker.evaluate('self.__shown || []') as Shown[];
      return shown.length > 0 && shown.every((entry) => entry.result !== 'pending');
    }, 'the push handler to show the notification');
    assert.equal(shown.length, 1, `one notification: ${JSON.stringify(shown)}`);
    assert.equal(shown[0]!.title, parsed.title);
    assert.equal(shown[0]!.body, parsed.body);
    assert.equal(shown[0]!.notificationId, parsed.notificationId);
    assert.equal(shown[0]!.tag, parsed.notificationId, 'the tag collapses a repeated delivery of the same notification');
    const displayed = await worker.evaluate('self.registration.getNotifications().then((list) => list.length)') as number;
    console.log(`showNotification result in headless Chromium: ${shown[0]!.result}; getNotifications(): ${displayed}`);
    if (shown[0]!.result === 'shown') {
      // The same push delivered twice (a push service retry) still leaves one notification.
      await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registrations.get(`${origin}/`)!, data: payload });
      await waitFor(async () => (await worker.evaluate('self.__shown.length') as number) === 2, 'the repeated push');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(await worker.evaluate('self.registration.getNotifications().then((list) => list.length)'), 1, 'a repeated delivery replaces the notification instead of adding one');
    }

    // The tap: the worker rechecks the notification with the server, then the app opens there.
    const item = expectStatus(await reader.browser.request('GET', `/api/v1/inbox/${parsed.notificationId}`), 200, 'the reader can open the inbox item') as { url: string };
    const target = await worker.evaluate(`notificationTarget(${JSON.stringify(parsed.notificationId)})`) as string;
    assert.equal(target, new URL(item.url, origin).href, 'the tap leads to the item the server authorizes now');
    const opened = await context.newPage();
    await opened.goto(target);
    await opened.getByText(text).first().waitFor({ timeout: 20_000 });
    // MOB-3: continue the linked work from there on the phone: reply, and the reply is stored for the other person.
    const reply = `On it, sending the notes tonight ${randomUUID().slice(0, 8)}`;
    await opened.locator('#dm-composer').tap();
    await opened.locator('#dm-composer').fill(reply);
    await opened.getByRole('button', { name: 'Send message' }).tap();
    await waitFor(async () => {
      const messages = await owner.browser.request('GET', `/api/v1/dms/${dm.id}`);
      return messages.status === 200 && JSON.stringify(messages.json).includes(reply);
    }, 'the reply sent from the opened notification to reach the other person');

    // Access removed: the same tap now opens the start page, and the payload's text is not trusted.
    await removeMember(owner, ws.id, reader);
    const afterRemoval = await worker.evaluate(`notificationTarget(${JSON.stringify(parsed.notificationId)})`) as string;
    assert.equal(afterRemoval, `${origin}/`, 'without access the tap opens the start page');
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close();
  }
});

/**
 * MOB-4: permission refused. Headless Chromium answers "denied" for notifications that were not granted (observed
 * 2026-10-10, see above); the test asserts that real state instead of stubbing it. Flux says where activity goes, the
 * notification is still stored for the in-app Inbox, and its in-app link opens the new message.
 */
test('with notification permission refused, Settings says so and the in-app notification still opens new activity', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let context: BrowserContext | undefined;
  try {
    const owner = await person('Denied owner');
    const reader = await person('Denied reader');
    const ws = await workspace(owner, 'Denied studio');
    await addMember(owner, ws.id, reader, 'member');
    const dm = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [reader.id] } }), 201, 'open a direct message') as { id: string };

    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-GB', serviceWorkers: 'allow' });
    const page = await context.newPage();
    await signIn(page, reader.email);
    assert.equal(await page.evaluate(() => Notification.permission), 'denied', 'the browser reports the permission as refused');
    await page.goto(`${origin}/settings/notifications`);
    await page.getByText('Notifications are blocked for Flux in your browser or system settings').waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole('button', { name: 'Turn on notifications' }).count(), 0, 'no button that cannot work');

    const text = `Kiln schedule moved ${randomUUID().slice(0, 8)}`;
    await sendDirectMessage(owner, dm.id, text);
    // The notification is stored for the in-app Inbox, and its in-app link opens the message.
    let id = '';
    await waitFor(async () => {
      const inbox = expectStatus(await reader.browser.request('GET', '/api/v1/inbox?limit=20'), 200) as { items: Array<{ id: string; title: string }> };
      id = inbox.items[0]?.id ?? '';
      return id !== '';
    }, 'the notification in the Inbox');
    await page.goto(`${origin}/inbox/${id}`);
    await page.getByText(text).first().waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
      throw new Error(`The Inbox link does not open the new message.\n${await explainPage(page)}\n${String(error)}`);
    });
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close();
  }
});
