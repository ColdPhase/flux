import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { chromium, devices, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import type { PushSubscriptionSummary } from '@flux/contracts';
import { addMember, expectStatus, password, person, workspace, type Person } from '../support/people.js';
import { recordedPushes, testSubscription, waitFor, type TestSubscription } from '../support/push.js';

/**
 * Asking for notifications at the right moment (#1243; docs/product/mobile-pwa.md "While Flux is open", the final design's "Asking for
 * notifications"), in Chromium. After the first direct message, Home offers once to turn notifications on; Turn on asks the browser
 * from the tap and subscribes this device, and the next message reaches the push mock while the tab is in the background. Not now is
 * remembered for 14 days, Block shows the way back, and an iPhone in Safari gets the Add to Home Screen steps first, while Android gets
 * the offer itself. The browser's permission and PushManager are stubbed (headless Chromium reports "denied" even after a grant,
 * observed 2026-10-10, and its push service is outside this network); the page, the API, the worker and the push mock are real.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
/** FLUX_E2E_BROWSER=webkit runs the iPhone lane in WebKit (the engine of Safari); the push and Android cases are Chromium's. */
const inWebKit = process.env.FLUX_E2E_BROWSER === 'webkit';
const chromiumOnly = inWebKit ? 'Chromium only: the push stub, the push mock and Android' : false;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});
// The notice that makes the offer due rides on the live stream: WebSocket upgrades are forwarded too (as access-stream.e2e.ts does).
proxy.on('upgrade', (request, socket, head) => {
  const target = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  const end = () => { target.destroy(); socket.destroy(); };
  target.on('error', end);
  socket.on('error', end);
});
before(async () => { await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve)); });
after(async () => { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); });

/** The browser's permission starts unasked; `answer` is what the person answers when asked. PushManager is fixed to `subscription`. */
function browserStub(subscription: TestSubscription, answer: 'granted' | 'denied', options: { noPush?: boolean } = {}) {
  return `(() => {
    window.__asked = 0;
    if (${options.noPush ? 'true' : 'false'}) { delete window.PushManager; delete window.Notification; return; }
    const endpoint = ${JSON.stringify(subscription.endpoint)};
    const keys = ${JSON.stringify(subscription.keys)};
    let saved = null;
    const make = (applicationServerKey) => ({ endpoint, expirationTime: null, options: { userVisibleOnly: true, applicationServerKey },
      toJSON: () => ({ endpoint, expirationTime: null, keys }), unsubscribe: async () => { saved = null; return true; } });
    const proto = PushManager.prototype;
    proto.subscribe = async function (options) {
      const key = options.applicationServerKey;
      const bytes = ArrayBuffer.isView(key) ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength) : new Uint8Array(key);
      saved = make(bytes.slice().buffer);
      return saved;
    };
    proto.getSubscription = async function () { return saved; };
    proto.permissionState = async function () { return permission === 'granted' ? 'granted' : 'prompt'; };
    // A browser keeps the answer across page loads, as this does.
    let permission = localStorage.getItem('flux-test-permission') || 'default';
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
    Notification.requestPermission = async () => {
      window.__asked += 1; permission = ${JSON.stringify(answer)};
      try { localStorage.setItem('flux-test-permission', permission); } catch (error) { /* private window */ }
      return permission;
    };
  })();`;
}

async function signIn(page: Page, email: string) {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

async function pair(label: string) {
  const ada = await person(`${label} Ada`);
  const jonas = await person(`${label} Jonas`);
  const ws = await workspace(jonas, `${label} studio`);
  await addMember(jonas, ws.id, ada, 'member');
  const dm = expectStatus(await jonas.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [ada.id] } }), 201) as { id: string };
  const write = async (text: string) => expectStatus(await jonas.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: text, clientMessageId: randomUUID() } }), 201);
  return { ada, jonas, dm, write };
}

async function withBrowser(work: (browser: Browser) => Promise<void>) {
  const browser = inWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try { await work(browser); } finally { await browser.close(); }
}

async function home(context: BrowserContext, someone: Person) {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await signIn(page, someone.email);
  await page.waitForTimeout(1500); // the live stream is open
  return { page, problems };
}

const offer = (page: Page) => page.locator('section.push-offer');

test('after the first direct message Home offers once; Turn on asks from the tap and a push reaches this device in the background', { skip: chromiumOnly }, async () => {
  await withBrowser(async (browser) => {
    const { ada, write } = await pair('Offer');
    const subscription = testSubscription('push');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', serviceWorkers: 'allow' });
    await context.grantPermissions(['notifications'], { origin });
    await context.addInitScript(browserStub(subscription, 'granted'));
    const { page, problems } = await home(context, ada);
    assert.equal(await offer(page).count(), 0, 'no offer before anyone wrote');
    assert.equal(await page.evaluate('window.__asked'), 0, 'nothing asks on load');

    await write('Can you bring the soldering iron tomorrow?');
    await offer(page).getByRole('heading', { name: 'Get notified when someone writes to you or calls' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate('window.__asked'), 0, 'the offer itself asks nothing');
    await offer(page).getByRole('button', { name: 'Turn on' }).click();
    await page.getByText('Notifications are on for this device').waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate('window.__asked'), 1, 'one question to the browser, from the tap');
    await offer(page).waitFor({ state: 'detached' });
    const stored = expectStatus(await ada.browser.request('GET', '/api/v1/push/subscriptions'), 200) as PushSubscriptionSummary[];
    assert.equal(stored.length, 1, 'this device is subscribed');

    // The tab goes to the background (another tab in front); the next message is pushed to this device.
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await write('The connectors arrived.');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).some((push) => push.status === 201 && push.vapid.ok), 'the push to reach the push mock');

    // Asked once: a reload shows no offer again.
    await page.bringToFront();
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await offer(page).count(), 0);
    assert.deepEqual(problems, []);
    await context.close();
  });
});

test('Not now is remembered for 14 days, and Block shows how to allow notifications again', { skip: chromiumOnly }, async () => {
  await withBrowser(async (browser) => {
    const { ada, write } = await pair('Later');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', serviceWorkers: 'allow' });
    await context.addInitScript(browserStub(testSubscription('push'), 'denied'));
    const { page } = await home(context, ada);
    await write('First message');
    await offer(page).waitFor({ timeout: 10_000 });
    await offer(page).getByRole('button', { name: 'Not now' }).click();
    await offer(page).waitFor({ state: 'detached' });
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await offer(page).count(), 0, 'not offered again within 14 days');

    // Fifteen days later it is offered once more; this time the person answers Block.
    await page.evaluate(`(() => { const key = 'flux:push-offer:${ada.id}'; const value = JSON.parse(localStorage.getItem(key)); value.notNowAt = Date.now() - 15 * 24 * 3600 * 1000; localStorage.setItem(key, JSON.stringify(value)); })()`);
    await page.reload();
    await offer(page).getByRole('button', { name: 'Turn on' }).click();
    await offer(page).getByRole('heading', { name: 'Notifications are blocked for Flux' }).waitFor({ timeout: 10_000 });
    assert.match(await offer(page).innerText(), /click the icon left of the address, open Notifications and choose Allow/);
    assert.match(await offer(page).innerText(), /Your Inbox always has everything/);
    await offer(page).getByRole('button', { name: 'Got it' }).click();
    await offer(page).waitFor({ state: 'detached' });
    await context.close();
  });
});

test('an iPhone in Safari is shown the Add to Home Screen steps first; Android gets the offer', async () => {
  await withBrowser(async (browser) => {
    const { ada, write } = await pair('Phones');
    const iphone = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-GB', serviceWorkers: 'allow' });
    // Safari outside the Home Screen app has no Web Push.
    await iphone.addInitScript(browserStub(testSubscription('push'), 'granted', { noPush: true }));
    const { page: phone } = await home(iphone, ada);
    await write('Hello from the shed');
    const card = offer(phone);
    await card.getByRole('heading', { name: 'Get notified on this iPhone' }).waitFor({ timeout: 10_000 });
    const steps = await card.locator('ol li').allInnerTexts();
    assert.deepEqual(steps, ['Tap Share, then Add to Home Screen.', 'Open Flux from your Home Screen.', 'Turn notifications on there.']);
    assert.equal(await card.getByRole('button', { name: 'Turn on' }).count(), 0, 'nothing to turn on in a Safari tab');
    await card.getByRole('button', { name: 'Not now' }).scrollIntoViewIfNeeded();
    if (process.env.FLUX_E2E_EVIDENCE_DIR) await card.screenshot({ path: `${process.env.FLUX_E2E_EVIDENCE_DIR}/push-offer-iphone-390-${inWebKit ? 'webkit' : 'chromium'}.png` });
    await iphone.close();

    // A server that cannot push: no steps, since the installed app could not be notified either (#763 SG-3).
    // The service worker is blocked here so the routed answer reaches the page (WebKit sends a worker's requests past routes).
    const unpushable = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-GB', serviceWorkers: 'block' });
    await unpushable.addInitScript(browserStub(testSubscription('push'), 'granted', { noPush: true }));
    await unpushable.route('**/api/v1/push/public-key', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'unavailable' }) }));
    const { page: plain } = await home(unpushable, ada);
    await write('Without push on the server');
    await plain.locator('.ui-notices .ui-notice').waitFor({ timeout: 10_000 });
    await plain.waitForTimeout(1500);
    assert.equal(await offer(plain).count(), 0, 'no Add to Home Screen steps when the server cannot push');
    await unpushable.close();
    if (inWebKit) return;

    const android = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-GB', serviceWorkers: 'allow' });
    await android.addInitScript(browserStub(testSubscription('push'), 'granted'));
    const { page: pixel } = await home(android, ada);
    await write('And on the Pixel?');
    await offer(pixel).getByRole('button', { name: 'Turn on' }).waitFor({ timeout: 10_000 });
    if (process.env.FLUX_E2E_EVIDENCE_DIR) await pixel.screenshot({ path: `${process.env.FLUX_E2E_EVIDENCE_DIR}/push-offer-android.png`, fullPage: true });
    await android.close();
  });
});
