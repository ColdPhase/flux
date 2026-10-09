import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type BrowserContext } from 'playwright';

/**
 * Migration to the one provider before cutover (F-024 S5b, #315), in Docker with Keycloak. scripts/check_oidc.sh runs
 * the "prepare" tests on an API started with FLUX_SSO_MODE=prepare, restarts the API between start and finish, then
 * runs the "cutover" tests on an API in SSO-only mode. No account rows are written except the password accounts the
 * tests sign up over the public API; every provider identity comes from Keycloak's verified ID token.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const idpPassword = process.env.FLUX_OIDC_TEST_PASSWORD!;
const keycloak = 'http://keycloak:8080';
const phase = process.env.FLUX_LINK_PHASE ?? 'prepare';
const saved = '/state/oidc-link.json';
const pat = { name: 'Pat Link', email: 'pat.link@example.test', password: `pw-${randomUUID()}` };
const quinn = { name: 'Quinn Link', email: 'quinn.link@example.test', password: `pw-${randomUUID()}` };

const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());

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

async function api<T = unknown>(context: BrowserContext, method: string, path: string, body?: unknown) {
  const response = await context.request.fetch(`${origin}${path}`, { method, data: body, headers: { origin } });
  return { status: response.status(), body: (await response.text()) ? JSON.parse(await response.text()) as T : null };
}

async function signUpAndIn(context: BrowserContext, person: typeof pat) {
  const up = await api(context, 'POST', '/api/auth/sign-up/email', { name: person.name, email: person.email, password: person.password });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const id = (await pool.query('SELECT id FROM auth_users WHERE email = $1', [person.email])).rows[0].id as string;
  return id;
}

/** Starts the provider sign-in from this browser's session and returns the provider page's URL. */
async function providerUrl(context: BrowserContext) {
  const started = await api<{ url: string }>(context, 'POST', '/api/auth/sign-in/social', { provider: process.env.FLUX_OIDC_PROVIDER_ID, callbackURL: '/settings' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return started.body!.url;
}

async function loginAtProvider(page: import('playwright').Page, username: string, url: string) {
  await page.goto(url);
  await page.waitForURL((u) => u.origin === keycloak, { timeout: 20_000 });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(idpPassword);
  await page.locator('#kc-login').click();
  await page.waitForURL((u) => u.origin === origin && u.pathname.startsWith('/settings'), { timeout: 20_000 });
}

if (phase === 'prepare') {
  test('prepare: a password account starts the link, and the browser state is saved for the restart', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const patId = await signUpAndIn(context, pat);
      const started = await api<{ providerId: string; label: string }>(context, 'POST', '/api/v1/identity/link');
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body!.providerId, process.env.FLUX_OIDC_PROVIDER_ID);
      const cookies = await context.cookies(`${origin}/api/auth/callback/${process.env.FLUX_OIDC_PROVIDER_ID}`);
      assert.ok(cookies.some((c) => c.name === 'flux_link'), 'the link intent cookie is set for the provider callback');
      assert.ok(patId);
      await context.storageState({ path: saved });
    });
  });

  test('prepare: after the API restart the same browser completes the link, and no new account is created', async () => {
    assert.ok(existsSync(saved), 'the start ran first');
    await withBrowser(async (browser) => {
      const context = await browser.newContext({ storageState: saved });
      const patId = (await pool.query('SELECT id FROM auth_users WHERE email = $1', [pat.email])).rows[0].id as string;
      const page = await context.newPage();
      const url = await providerUrl(context);
      await loginAtProvider(page, 'frank', url);
      assert.match(page.url(), /\/settings\?link=linked$/, 'the link completed and returned to settings');
      const linked = (await pool.query('SELECT account_id FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [patId, process.env.FLUX_OIDC_PROVIDER_ID])).rows;
      assert.equal(linked.length, 1, 'the provider subject is linked to Pat');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_users WHERE email = $1', ['frank@acme.test'])).rows[0].n, 0,
        'no account was created from the provider identity; the link adds no email match');
      const [pat0] = (await pool.query('SELECT email, email_verified FROM auth_users WHERE id = $1', [patId])).rows;
      assert.deepEqual(pat0, { email: pat.email, email_verified: false }, 'Pat keeps the address and data');
    });
  });

  test('prepare: a subject already held by another account is refused, and the other account keeps it', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const quinnId = await signUpAndIn(context, quinn);
      const started = await api(context, 'POST', '/api/v1/identity/link');
      assert.equal(started.status, 200);
      const page = await context.newPage();
      const url = await providerUrl(context);
      await loginAtProvider(page, 'frank', url);
      assert.match(page.url(), /\/settings\?link=identity_held$/, 'refused with a reason, not linked');
      assert.deepEqual((await pool.query('SELECT account_id FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [quinnId, process.env.FLUX_OIDC_PROVIDER_ID])).rows, [],
        'Quinn gained nothing');
      const patId = (await pool.query('SELECT id FROM auth_users WHERE email = $1', [pat.email])).rows[0].id as string;
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [patId, process.env.FLUX_OIDC_PROVIDER_ID])).rows[0].n, 1,
        'Pat keeps the subject');
    });
  });

  test('prepare: a link cannot be completed from a browser without the starting session', async () => {
    await withBrowser(async (browser) => {
      const owner = await browser.newContext({ storageState: saved });
      const started = await api(owner, 'POST', '/api/v1/identity/link');
      assert.equal(started.status, 200);
      const cookie = (await owner.cookies(`${origin}/api/auth/callback/${process.env.FLUX_OIDC_PROVIDER_ID}`)).find((c) => c.name === 'flux_link');
      assert.ok(cookie, 'the intent cookie');
      const other = await browser.newContext();
      await other.addCookies([{ name: 'flux_link', value: cookie!.value, url: origin }]);
      const page = await other.newPage();
      const url = await providerUrl(other);
      await loginAtProvider(page, 'erin', url);
      assert.match(page.url(), /\/settings\?link=/, 'the callback is answered, not signed in');
      assert.equal((await other.request.get(`${origin}/api/v1/me`)).status(), 401, 'no session was created by the link callback');
    });
  });
}

if (phase === 'cutover') {
  test('cutover: with SSO-only mode, password sign-in of a linked and an unlinked account is refused', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      for (const person of [pat, quinn]) {
        const refused = await api<{ code: string }>(context, 'POST', '/api/auth/sign-in/email', { email: person.email, password: person.password });
        assert.equal(refused.status, 403, `${person.email} cannot sign in with a password`);
        assert.equal(refused.body!.code, 'SSO_ONLY');
      }
    });
  });

  test('cutover: linking is closed, so a session cannot start a new link', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const closed = await api<{ code: string }>(context, 'POST', '/api/v1/identity/link');
      assert.equal(closed.status, 409);
      assert.equal(closed.body!.code, 'LINK_CLOSED');
    });
  });

  test('cutover: the linked person signs in with the provider and lands on the same Flux account', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const patId = (await pool.query('SELECT id FROM auth_users WHERE email = $1', [pat.email])).rows[0].id as string;
      const url = await providerUrl(context);
      await loginAtProvider(page, 'frank', url);
      const me = await api<{ user: { id: string; email: string } }>(context, 'GET', '/api/v1/me');
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body!.user.id, patId, 'the same Flux account, with its data and memberships');
      assert.equal(me.body!.user.email, pat.email, 'the account address stays as it was');
    });
  });
}
