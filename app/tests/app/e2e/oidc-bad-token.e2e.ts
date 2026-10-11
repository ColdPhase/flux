import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { MockIdentity, MockIssued, MockMode } from '../support/oidc-mock.js';

/**
 * ID tokens that must not sign anyone in (#113), on the genuine authorization-code callback.
 * scripts/check_oidc.sh runs this against a second API replica (api-mock, same database) whose
 * operator provider is the deterministic mock of tests/app/support/oidc-mock.ts. Each sign-in is
 * the real browser flow: the sign-in button, the provider's /authorize with PKCE, state and
 * nonce, the redirect to /api/auth/callback/<provider id>, and the API's own code exchange at the
 * provider's token endpoint. Only the ID token the provider returns differs between the cases.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api-mock:8080');
const providerId = process.env.FLUX_OIDC_MOCK_PROVIDER_ID!;
const mock = 'http://oidc-mock:9400';
const mailpit = process.env.FLUX_MAILPIT_URL ?? 'http://mailpit:8025';
const BAD_MODES: MockMode[] = ['bad-nonce', 'bad-signature', 'bad-issuer', 'bad-audience'];

const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});
const { pool } = createDatabase(process.env.DATABASE_URL!);
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  assert.ok(providerId, 'check_oidc.sh supplies the mock provider id');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  proxy.close();
  await pool.end();
});

async function fresh() {
  const context = await browser.newContext();
  contexts.push(context);
  return context;
}

async function issued() {
  return await (await fetch(`${mock}/__issued`)).json() as MockIssued[];
}

/** The visible "Sign in with Mock IdP" flow; the mock answers with `identity` in its chosen mode. */
async function sso(context: BrowserContext, identity: MockIdentity): Promise<{ page: Page; issued: MockIssued }> {
  const chosen = await fetch(`${mock}/__next`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity) });
  assert.equal(chosen.status, 204);
  const count = (await issued()).length;
  const page = await context.newPage();
  let callback = '';
  page.on('request', (request) => { if (request.url().startsWith(`${origin}/api/auth/callback/${providerId}?`)) callback = request.url(); });
  await page.goto(`${origin}/sign-in`);
  await page.getByRole('button', { name: 'Sign in with Mock IdP', exact: true }).click();
  await page.waitForURL((url) => url.origin === origin && (url.pathname !== '/sign-in' || url.searchParams.has('sso')), { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  assert.ok(callback.includes('code=') && callback.includes('state='), 'the browser went through the real callback');
  const all = await issued();
  assert.equal(all.length, count + 1, 'Flux exchanged the code at the provider\'s token endpoint');
  const last = all.at(-1)!;
  assert.equal(last.mode, identity.mode);
  assert.ok(last.nonceSent, 'Flux sent a nonce with the authorization request');
  return { page, issued: last };
}

async function me(context: BrowserContext) {
  const response = await context.request.get(`${origin}/api/v1/me`);
  return { status: response.status(), body: response.ok() ? await response.json() as { user: { id: string; email: string; name: string } } : null };
}

async function api<T>(context: BrowserContext, method: string, path: string, body?: unknown): Promise<T> {
  const response = await context.request.fetch(`${origin}${path}`, { method, data: body, headers: { origin, 'idempotency-key': randomUUID() } });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return (response.status() === 204 ? null : await response.json()) as T;
}

async function waitFor<T>(check: () => Promise<T | null | false>, what: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Every row a sign-in could create or change: people, provider accounts, sessions, grants, extra addresses. */
async function snapshot() {
  const query = async (sql: string) => (await pool.query(sql)).rows;
  return {
    users: await query('SELECT id, email, name, email_verified FROM auth_users ORDER BY id'),
    accounts: await query('SELECT id, user_id, provider_id, account_id FROM auth_accounts ORDER BY id'),
    sessions: await query('SELECT id, user_id, expires_at FROM auth_sessions ORDER BY id'),
    members: await query('SELECT workspace_id, user_id, role FROM workspace_members ORDER BY workspace_id, user_id'),
    grants: await query('SELECT to_jsonb(g) AS grant FROM project_grants g ORDER BY to_jsonb(g)::text'),
    addresses: await query('SELECT id, user_id, email, verified_at FROM notification_addresses ORDER BY id'),
  };
}

const erin: MockIdentity = { mode: 'valid', sub: `mock-erin-${randomUUID()}`, email: `erin.${randomUUID().slice(0, 8)}@mock.test`, name: 'Erin Mock' };
const state: { erinId?: string; workspace?: string; extra?: string } = {};

test('a valid ID token from the mock provider signs in through the same callback (control)', async () => {
  const context = await fresh();
  const capabilities = await api<{ sso: { providerId: string; label: string; reachable: boolean } | null }>(context, 'GET', '/api/v1/auth/capabilities');
  assert.deepEqual(capabilities.sso, { providerId, label: 'Mock IdP', reachable: true }, 'the replica read the mock provider\'s discovery');
  const { page } = await sso(context, erin);
  assert.equal(new URL(page.url()).pathname, '/', 'a valid token lands on Home');
  const signedIn = await me(context);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body!.user.email, erin.email);
  state.erinId = signedIn.body!.user.id;
  const accounts = (await pool.query('SELECT provider_id, account_id FROM auth_accounts WHERE user_id = $1', [state.erinId])).rows;
  assert.deepEqual(accounts, [{ provider_id: providerId, account_id: erin.sub }], 'keyed by the mock issuer and the subject');
  // Erin gets something worth stealing: a grant and a verified private notification address.
  state.workspace = (await api<{ id: string }>(context, 'POST', '/api/v1/workspaces', { name: 'Erin garden' })).id;
  state.extra = `erin.private-${randomUUID()}@gmail.test`;
  await api(context, 'POST', '/api/v1/notification-address', { email: state.extra });
  const mail = await waitFor(async () => {
    const search = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${state.extra}"`)}`)).json() as { messages: { ID: string }[] };
    return search.messages[0] ?? null;
  }, 'the verification email');
  const text = (await (await fetch(`${mailpit}/api/v1/message/${mail.ID}`)).json() as { Text: string }).Text;
  const token = new URL(/(http\S+verify\?token=\S+)/.exec(text)![1]!).searchParams.get('token')!;
  await api(context, 'POST', '/api/v1/notification-address/verify', { token });
  await api(context, 'POST', '/api/auth/sign-out', {});
  assert.equal((await me(context)).status, 401);
});

for (const mode of BAD_MODES) {
  test(`an ID token with a ${mode.replace('bad-', 'bad ')} is refused on the callback: no session, no linking, no grants, no address`, async () => {
    assert.ok(state.erinId, 'the control sign-in ran first');
    const before = await snapshot();
    const attempts: [string, MockIdentity][] = [
      // A forged token for Erin's existing subject, also trying to move her to another email.
      ['Erin\'s subject', { mode, sub: erin.sub, email: `takeover-${mode}@mock.test`, name: 'Mallory Takeover' }],
      // A forged token for a new subject that claims Erin's verified private address as its email.
      ['a new subject', { mode, sub: `mock-mallory-${randomUUID()}`, email: state.extra!, name: 'Mallory New' }],
    ];
    for (const [label, identity] of attempts) {
      const context = await fresh();
      const { page, issued: token } = await sso(context, identity);
      // Exactly the one property is wrong; everything else about the token is genuine.
      assert.equal(token.claims.iss === mock, mode !== 'bad-issuer', `${label}: issuer`);
      assert.equal(token.claims.aud === 'flux', mode !== 'bad-audience', `${label}: audience`);
      assert.equal(String(token.claims.nonce).endsWith('-replayed'), mode === 'bad-nonce', `${label}: nonce`);
      assert.deepEqual({ sub: token.claims.sub, email: token.claims.email, verified: token.claims.email_verified }, { sub: identity.sub, email: identity.email, verified: true });
      assert.equal(new URL(page.url()).pathname, '/sign-in', `${label}: back on sign-in`);
      assert.equal(new URL(page.url()).searchParams.get('sso'), 'failed', `${label}: the failure is shown`);
      await page.getByText('Single sign-on didn’t complete').waitFor();
      assert.equal((await me(context)).status, 401, `${label}: no Flux session`);
      assert.equal((await context.request.get(`${origin}/api/v1/workspaces`)).status(), 401, `${label}: no access to anything`);
    }
    // Nothing changed: no person, provider account or session was created, Erin's email, name,
    // grants and verified address are as they were, and nobody acquired that address.
    assert.deepEqual(await snapshot(), before);
  });
}

test('after the refused tokens a valid one still signs in the same person with her grants and address', async () => {
  const context = await fresh();
  await sso(context, erin);
  const again = await me(context);
  assert.equal(again.status, 200);
  assert.deepEqual({ id: again.body!.user.id, email: again.body!.user.email, name: again.body!.user.name }, { id: state.erinId, email: erin.email, name: erin.name });
  const workspaces = await api<{ id: string }[]>(context, 'GET', '/api/v1/workspaces');
  assert.deepEqual(workspaces.map((item) => item.id), [state.workspace]);
  const preferences = await api<{ email: { extra: { email: string; verified: boolean } | null } }>(context, 'GET', '/api/v1/notification-preferences');
  assert.deepEqual({ email: preferences.email.extra?.email, verified: preferences.email.extra?.verified }, { email: state.extra, verified: true });
  // Every token the provider issued in this file: the valid ones plus two refused ones per mode.
  const modes = (await issued()).map((entry) => entry.mode);
  assert.deepEqual(modes, ['valid', ...BAD_MODES.flatMap((mode) => [mode, mode]), 'valid']);
});
