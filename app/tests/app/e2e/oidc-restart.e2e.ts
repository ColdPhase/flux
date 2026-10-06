import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';

/**
 * A single sign-on session survives an API restart (#113). scripts/check_oidc.sh runs "prepare",
 * restarts the API, then runs "verify" with the browser state saved in the shared /state volume.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const saved = '/state/oidc-session.json';

function proxy() {
  return http.createServer((request, response) => {
    const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
      method: request.method, path: request.url, headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
    });
    forward.on('error', () => response.destroy()); request.pipe(forward);
  });
}

async function withBrowser<T>(run: (browser: Awaited<ReturnType<typeof chromium.launch>>) => Promise<T>) {
  const server = proxy();
  await new Promise<void>((resolve) => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try { return await run(browser); } finally { await browser.close(); server.close(); }
}

test('prepare: bob signs in with single sign-on and the browser state is saved', async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/sign-in`);
    await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
    await page.waitForURL((url) => url.origin === 'http://keycloak:8080');
    await page.locator('#username').fill('bob');
    await page.locator('#password').fill(process.env.FLUX_OIDC_TEST_PASSWORD!);
    await page.locator('#kc-login').click();
    await page.waitForURL((url) => url.origin === origin, { timeout: 20_000 });
    const me = await context.request.get(`${origin}/api/v1/me`);
    assert.equal(me.status(), 200);
    await context.storageState({ path: saved });
  });
});

test('verify: after the API restart the same browser state is still signed in as bob', async () => {
  assert.ok(existsSync(saved), 'prepare ran first');
  await withBrowser(async (browser) => {
    const context = await browser.newContext({ storageState: saved });
    const me = await context.request.get(`${origin}/api/v1/me`);
    assert.equal(me.status(), 200, await me.text());
    assert.equal((await me.json() as { user: { email: string } }).user.email, 'bob@acme.test');
  });
});
