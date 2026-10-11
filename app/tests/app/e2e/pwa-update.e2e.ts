import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';

/**
 * When the "A new version of Flux is available" prompt may appear (issue #20, MOB-5). A fresh
 * install and a second tab of the same deployment are not updates and must show nothing; a
 * service worker of a changed deployment must show it. Runs in Chromium by default and in WebKit
 * with FLUX_E2E_BROWSER=webkit, over HTTPS through a small proxy to the API container (the same
 * setup as pwa.e2e.ts, which covers the service worker itself).
 */
const ENGINES: Record<string, BrowserType> = { chromium, webkit };
const engineName = process.env.FLUX_E2E_BROWSER ?? 'chromium';
const engine = ENGINES[engineName];
if (!engine) throw new Error('FLUX_E2E_BROWSER must be chromium or webkit');

const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const state = { nextServiceWorker: false };

const dir = mkdtempSync(join(tmpdir(), 'flux-e2e-update-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });

const proxy = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (request, response) => {
  const rewriting = state.nextServiceWorker && request.url?.split('?')[0] === '/sw.js';
  const forward = http.request({
    host: upstream.hostname, port: upstream.port, method: request.method, path: request.url,
    headers: { ...request.headers, host: upstream.host, ...(rewriting ? { 'accept-encoding': 'identity' } : {}) },
  }, (answer) => {
    if (rewriting) {
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
const contexts: BrowserContext[] = [];

before(async () => {
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  origin = `https://localhost:${(proxy.address() as AddressInfo).port}`;
  browser = await engine.launch({ args: engineName === 'chromium' ? ['--ignore-certificate-errors'] : [] });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
});

/** A fresh browser context, as a person's first visit on a new browser profile would be. */
async function freshContext() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'allow' });
  contexts.push(context);
  return context;
}

/** Service worker state as the page sees it, for the failure message. */
async function workerState(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return {
      controller: navigator.serviceWorker.controller?.state ?? null,
      active: registration?.active?.state ?? null,
      waiting: registration?.waiting?.state ?? null,
      installing: registration?.installing?.state ?? null,
    };
  });
}

/** Opens the app in a page and waits until its service worker controls it and has settled. */
async function openControlled(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });
  return page;
}

describe(`Flux update prompt in ${engineName} over HTTPS`, () => {
  test('a fresh install of the service worker shows no update prompt', async () => {
    const context = await freshContext();
    const page = await openControlled(context);
    // Let the install, activation and any follow-up statechange events run before looking.
    await page.waitForTimeout(3_000);
    const prompts = await page.getByTestId('flux-update-prompt').count();
    assert.equal(prompts, 0, `no prompt after a first install (worker ${JSON.stringify(await workerState(page))})`);
  });

  test('a second tab of the same deployment shows no update prompt', async () => {
    const context = await freshContext();
    const first = await openControlled(context);
    await first.waitForTimeout(1_000);
    const second = await openControlled(context);
    await second.waitForTimeout(3_000);
    for (const [label, page] of [['first tab', first], ['second tab', second]] as const) {
      const prompts = await page.getByTestId('flux-update-prompt').count();
      assert.equal(prompts, 0, `no prompt in the ${label} (worker ${JSON.stringify(await workerState(page))})`);
    }
  });

  test('a fresh profile opened while another profile already runs Flux shows no update prompt', async () => {
    // Another browser context keeps its service worker alive while this one starts (#41, WebKit lane).
    const earlier = await freshContext();
    await openControlled(earlier);
    const context = await freshContext();
    const page = await openControlled(context);
    await page.waitForTimeout(3_000);
    const prompts = await page.getByTestId('flux-update-prompt').count();
    assert.equal(prompts, 0, `no prompt for a fresh profile (worker ${JSON.stringify(await workerState(page))})`);
  });

  test('a changed service worker shows the prompt in every open tab', async () => {
    const context = await freshContext();
    const first = await openControlled(context);
    const second = await openControlled(context);
    await second.waitForTimeout(1_000);
    state.nextServiceWorker = true;
    try {
      await first.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/'))!.update(); });
      for (const [label, page] of [['first tab', first], ['second tab', second]] as const) {
        const prompt = page.getByTestId('flux-update-prompt');
        await prompt.waitFor({ timeout: 20_000 }).catch(() => undefined);
        assert.equal(await prompt.count(), 1, `the ${label} offers the new version (worker ${JSON.stringify(await workerState(page))})`);
      }
    } finally {
      state.nextServiceWorker = false;
    }
  });
});
