import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * Service worker behaviour in Chromium over HTTPS (issue #41). A small TLS proxy in front of the
 * API container gives the browser a secure origin (https://localhost:<port>), and lets the test
 * simulate going offline and deploying a changed service worker.
 */
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const state = { offline: false, nextServiceWorker: false };

const dir = mkdtempSync(join(tmpdir(), 'flux-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });

const proxy = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (request, response) => {
  if (state.offline) {
    request.socket.destroy();
    return;
  }
  // The rewrite below edits the worker as text, so that request asks for the uncompressed file;
  // every other request keeps the browser's encodings (the build ships .br/.gz copies, #266).
  const rewriting = state.nextServiceWorker && request.url?.split('?')[0] === '/sw.js';
  const forward = http.request({
    host: upstream.hostname, port: upstream.port, method: request.method, path: request.url,
    headers: { ...request.headers, host: upstream.host, ...(rewriting ? { 'accept-encoding': 'identity' } : {}) },
  }, (answer) => {
    if (state.nextServiceWorker && request.url?.split('?')[0] === '/sw.js') {
      // A new deployment: same rules, different version, so the browser installs a new worker.
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        const code = Buffer.from(Buffer.concat(chunks).toString('utf8').replace(/const VERSION = "([0-9a-f]+)";/, 'const VERSION = "$1-next";'));
        const headers = { ...answer.headers, 'content-length': String(code.length) };
        delete headers.etag;
        delete headers['last-modified'];
        response.writeHead(answer.statusCode ?? 502, headers).end(code);
      });
      return;
    }
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});

let origin = '';
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  origin = `https://localhost:${(proxy.address() as AddressInfo).port}`;
  browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'allow' });
  // Count permission prompts: loading Flux must never ask for notification permission.
  await context.addInitScript(() => {
    const w = window as unknown as { __permissionRequests: number };
    w.__permissionRequests = 0;
    if ('Notification' in window) {
      const original = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = ((...args: Parameters<typeof Notification.requestPermission>) => { w.__permissionRequests++; return original(...args); }) as typeof Notification.requestPermission;
    }
  });
  page = await context.newPage();
});

after(async () => {
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
});

async function swVersion(target: Page) {
  return target.evaluate(() => new Promise<string>((resolve, reject) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return reject(new Error('no controller'));
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve((event.data as { version: string }).version);
    controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
  }));
}

describe('Flux PWA in Chromium over HTTPS', () => {
  test('the service worker registers for scope "/" and controls the page', async () => {
    await page.goto(`${origin}/`);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    assert.equal(scope, `${origin}/`);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
    assert.match(await swVersion(page), /^[0-9a-f]{16}$/);
    const manifestHref = await page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href);
    assert.equal(manifestHref, `${origin}/manifest.webmanifest`);
    const manifest = await page.evaluate(async (href) => (await fetch(href!)).json(), manifestHref) as { start_url: string; display: string };
    assert.equal(manifest.display, 'standalone');

    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) urls.push(`${key} ${new URL(request.url).pathname}`);
      return urls;
    });
    assert.ok(cached.some((entry) => /^flux-shell-[0-9a-f]{16} \/offline\.html$/.test(entry)), cached.join('\n'));
    assert.ok(cached.some((entry) => / \/assets\/.+\.js$/.test(entry)), 'the app bundle is precached');
    const precache = await page.evaluate(async () => {
      const worker = await (await fetch('/sw.js')).text();
      const match = /const PRECACHE = (\[[^;]+\]);/.exec(worker);
      if (!match) throw new Error('The emitted precache inventory is missing');
      return JSON.parse(match[1]!) as string[];
    });
    const cachedPaths = new Set(cached.map((entry) => entry.slice(entry.indexOf(' ') + 1)));
    for (const asset of precache) assert.ok(cachedPaths.has(asset), `Every emitted asset stays precached: ${asset}`);
    const settingsChunk = precache.find((asset) => /\/SettingsHome-[^/]+\.js$/.test(asset));
    assert.ok(settingsChunk, 'the unopened secondary route has a separate emitted chunk');
    state.offline = true;
    try {
      const route = await page.evaluate(async (asset) => {
        const response = await fetch(asset);
        return { status: response.status, text: await response.text() };
      }, settingsChunk);
      assert.equal(route.status, 200, 'unopened route code is available from the service worker offline');
      assert.ok(route.text.length > 100, 'actual compiled route bytes are returned');
    } finally { state.offline = false; }
    // Make API calls through the controlled page, then confirm none of them was cached.
    assert.equal(await page.evaluate(async () => (await fetch('/api/v1/health')).status), 200);
    assert.equal(await page.evaluate(async () => (await fetch('/api/v1/me')).status), 401);
    const afterApi = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname);
      return urls;
    });
    assert.equal(afterApi.some((path) => path.startsWith('/api/')), false, 'API responses are never cached');
    assert.equal(await page.evaluate(() => (window as unknown as { __permissionRequests: number }).__permissionRequests), 0, 'no permission prompt without a user gesture');
  });

  test('offline navigation shows the fallback page and API calls fail instead of using a cache', async () => {
    state.offline = true;
    try {
      await page.goto(`${origin}/projects/launch-plan?thread=42`);
      await page.getByRole('heading', { name: 'You are offline' }).waitFor({ timeout: 10_000 });
      assert.equal(await page.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true, 'the precached icon renders offline');
      const api = await page.evaluate(async () => {
        try { return (await fetch('/api/v1/health')).status; } catch { return 'network error'; }
      });
      assert.equal(api, 'network error');
    } finally {
      state.offline = false;
    }
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.waitForURL(`${origin}/projects/launch-plan?thread=42`);
    await page.waitForFunction(() => !document.body.textContent?.includes('You are offline'), undefined, { timeout: 10_000 });
  });

  test('a changed service worker waits, the app offers a reload, and confirming activates it', async () => {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const oldVersion = await swVersion(page);
    const oldCaches = await page.evaluate(() => caches.keys());
    state.nextServiceWorker = true;
    try {
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/'))!.update(); });
      const prompt = page.getByTestId('flux-update-prompt');
      await prompt.waitFor({ timeout: 15_000 });
      assert.match(await prompt.innerText(), /A new version of Flux is available/);
      await new Promise((resolve) => setTimeout(resolve, 750));
      assert.equal(await swVersion(page), oldVersion, 'the new version waits; the page keeps the old worker');
      assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))!.waiting), true);

      const reloaded = page.waitForEvent('load');
      await prompt.getByRole('button', { name: 'Reload' }).click();
      await reloaded;
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      assert.equal(await swVersion(page), `${oldVersion}-next`);
      assert.equal(await page.getByTestId('flux-update-prompt').count(), 0, 'the prompt is gone after reloading');
      await page.waitForFunction((previous) => caches.keys().then((keys) => !keys.some((key) => previous.includes(key))), oldCaches);
      const keys = await page.evaluate(() => caches.keys());
      assert.deepEqual(keys, [`flux-shell-${oldVersion}-next`], 'the old shell cache is removed on activation');
    } finally {
      state.nextServiceWorker = false;
    }
  });
});
