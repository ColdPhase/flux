import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mcp, toolValue } from '../support/mcp.js';

/**
 * Provider sign-in on the MCP authorization path (F-024 S1, #310). A scripted client (test code, not a
 * vendor client) starts a real PKCE authorization against the disposable Keycloak of scripts/check_oidc.sh.
 * Chromium takes the person through Flux `/login` -> Keycloak -> Flux, and the test then finishes the
 * connection choice and consent through the public API, redeems the code and calls MCP tools.
 *
 * The last tests are the standing check (F-024 S4, #311): the same person is suspended and restored by
 * disabling and re-enabling the user in Keycloak, and a provider that returns no refresh token is refused.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const providerId = process.env.FLUX_OIDC_PROVIDER_ID!;
const idpPassword = process.env.FLUX_OIDC_TEST_PASSWORD!;
const adminPassword = process.env.FLUX_OIDC_TEST_ADMIN_PASSWORD!;
const keycloak = 'http://keycloak:8080';
const resource = `${origin}/mcp`;

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
  assert.ok(providerId && idpPassword, 'check_oidc.sh supplies the provider id and test secrets');
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

async function api<T>(context: BrowserContext, method: string, path: string, body?: unknown, expected = 200): Promise<T> {
  const response = await context.request.fetch(`${origin}${path}`, { method, data: body, headers: { origin, 'idempotency-key': randomUUID() } });
  const text = await response.text();
  assert.ok(response.status() === expected || (expected === 200 && response.ok()), `${method} ${path}: ${response.status()} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** The pre-registered scripted client (#294's fixture is a database row): loopback redirect, PKCE, one resource. */
async function registerClient(redirectUri: string) {
  const clientId = `flux-mcp-sso-${randomUUID()}`;
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Scripted MCP client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, resource]);
  return clientId;
}

function authorizeUrl(clientId: string, redirectUri: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL('/api/auth/oauth2/authorize', origin);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    state: randomUUID(), scope: 'flux.context.read flux.proposal.write offline_access', resource, ...extra,
  }).toString();
  return url.toString();
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** From the client opening the browser to the provider's own login form (the button on Flux `/login`). */
async function toProvider(page: Page, url: string) {
  await page.goto(url);
  assert.equal(new URL(page.url()).pathname, '/login', 'the authorization step lands on /login with the signed request');
  assert.ok(new URL(page.url()).searchParams.get('sig'), 'and keeps the signed request');
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
  await page.waitForURL((target) => target.origin === keycloak);
}

async function providerLogin(page: Page, username: string) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(idpPassword);
  await page.locator('#kc-login').click();
}

const state: { connectionId?: string; userId?: string; projectId?: string } = {};
const loopback = 'http://127.0.0.1:19737/callback';
const otherPort = 'http://127.0.0.1:19999/callback';
let clientId: string;

/** Redeems the code like the scripted client does and returns the tokens. */
async function redeem(callback: URL, verifier: string, redirectUri: string, id: string) {
  assert.equal(callback.searchParams.get('iss'), `${origin}/api/auth`, 'the callback names the issuer');
  const code = callback.searchParams.get('code');
  assert.ok(code, 'consent returned an authorization code');
  const response = await fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: id, code_verifier: verifier, resource }) });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { access_token: string; refresh_token: string };
}

/** Connection choice and consent, as the pages do it, for a person already signed in to this context. */
async function chooseAndConsent(context: BrowserContext, page: Page, redirectUri: string, connectionId = state.connectionId) {
  await page.waitForURL((target) => target.pathname === '/connect-agent', { timeout: 20_000 });
  const selected = page.url().split('?')[1]!;
  assert.ok(new URLSearchParams(selected).get('sig'), 'the connection choice still carries the signed request');
  await api(context, 'POST', `/api/v1/agent-connections/${connectionId}/select-for-oauth`, { oauth_query: selected }, 204);
  const continued = await api<{ url?: string; redirect_uri?: string }>(context, 'POST', '/api/auth/oauth2/continue', { postLogin: true, oauth_query: selected });
  const consentUrl = new URL(String(continued.url ?? continued.redirect_uri), origin);
  // An earlier consent for this client and connection is remembered: the code comes straight back.
  if (consentUrl.pathname !== '/consent') return consentUrl;
  const display = await api<{ redirect: { kind: string; host: string }; clientIdHost: string | null }>(context, 'GET',
    `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(consentUrl.search.slice(1))}`);
  assert.deepEqual(display.redirect, { kind: 'loopback', host: new URL(redirectUri).host }, 'consent shows where access goes');
  assert.equal(display.clientIdHost, null, 'a pre-registered client has no client_id host');
  const framing = await context.request.get(`${origin}/consent?${consentUrl.search.slice(1)}`);
  assert.equal(framing.headers()['x-frame-options'], 'DENY', 'the consent page cannot be framed');
  assert.match(framing.headers()['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  const consent = await api<{ url?: string; redirect_uri?: string }>(context, 'POST', '/api/auth/oauth2/consent', { accept: true, oauth_query: consentUrl.search.slice(1) });
  return new URL(String(consent.url ?? consent.redirect_uri));
}

test('setup: an identity-provider-only person has a Flux account and one agent connection', async () => {
  const context = await fresh();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`);
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
  await page.waitForURL((target) => target.origin === keycloak);
  await providerLogin(page, 'erin');
  await page.waitForURL((target) => target.origin === origin, { timeout: 20_000 });
  const me = await api<{ user: { id: string } }>(context, 'GET', '/api/v1/me');
  state.userId = me.user.id;
  const workspace = await api<{ id: string }>(context, 'POST', '/api/v1/workspaces', { name: 'Erin lab' }, 201);
  const project = await api<{ id: string }>(context, 'POST', `/api/v1/workspaces/${workspace.id}/projects`, { name: 'Selected project', visibility: 'restricted' }, 201);
  state.projectId = project.id;
  const agent = await api<{ id: string }>(context, 'POST', `/api/v1/workspaces/${workspace.id}/agents`, { name: 'Erin agent', owner: 'self' }, 201);
  await api(context, 'POST', `/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, 201);
  const connection = await api<{ id: string }>(context, 'POST', '/api/v1/agent-connections',
    { agentId: agent.id, selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'] }, 201);
  state.connectionId = connection.id;
  clientId = await registerClient(loopback);
  const password = await pool.query('SELECT password FROM auth_accounts WHERE user_id = $1', [state.userId]);
  assert.ok(password.rows.every((row) => row.password === null), 'the person has no Flux password');
});

test('the 401 from /mcp names the protected-resource metadata the client starts from', async () => {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/);
});

test('a client authorizes through the provider on /login from a fresh browser, with a loopback port the registration did not name', async () => {
  const context = await fresh();
  const page = await context.newPage();
  const { verifier, challenge } = pkce();
  const requested = authorizeUrl(clientId, otherPort, challenge);
  await toProvider(page, requested);
  await providerLogin(page, 'erin');
  const callback = await chooseAndConsent(context, page, otherPort);
  assert.equal(callback.origin, new URL(otherPort).origin);
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('state'), new URL(requested).searchParams.get('state'), 'the client\'s own state returns');
  const tokens = await redeem(callback, verifier, otherPort, clientId);

  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { aud: string | string[]; sub: string; iss: string };
  assert.deepEqual([claims.aud].flat(), [resource], 'the access token is Flux\'s, for the MCP resource');
  assert.equal(claims.iss, `${origin}/api/auth`);
  assert.equal(claims.sub, state.userId);
  const contexts = await mcp(tokens.access_token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
  assert.equal(contexts.status, 200, JSON.stringify(contexts.message));
  assert.deepEqual((toolValue(contexts.message).projects as { id: string }[]).map((project) => project.id), [state.projectId]);

  // The session records how the person signed in: the provider id, the provider's session id and when.
  const identity = (await pool.query(`SELECT i.method, i.idp_sid, i.confirmed_at > now() - interval '5 minutes' AS recent
    FROM auth_session_identities i JOIN auth_sessions s ON s.id = i.session_id WHERE s.user_id = $1 ORDER BY i.confirmed_at DESC LIMIT 1`, [state.userId])).rows[0];
  assert.equal(identity.method, providerId);
  assert.ok(identity.idp_sid, 'the provider\'s sid is kept');
  assert.equal(identity.recent, true);
  // No provider token is kept in auth_accounts.
  const stored = (await pool.query('SELECT access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at FROM auth_accounts WHERE user_id = $1', [state.userId])).rows;
  assert.ok(stored.length >= 1);
  assert.ok(stored.every((row) => Object.values(row).every((value) => value === null)), 'auth_accounts holds no IdP access, ID or refresh token');

  // The grant itself records how the consenting sign-in happened (#310 AC-3).
  const sessionId = (await api<{ session: { id: string } }>(context, 'GET', '/api/v1/me')).session.id;
  const grantFacts = () => grantAuthentication(state.userId!, clientId!);
  const before = await grantFacts();
  assert.equal(before.method, providerId, 'the grant names the provider');
  assert.ok(before.idpSid && before.idpSid === identity.idp_sid, 'the grant keeps the same provider session id as the session');
  assert.equal(before.recent, true);

  // The refresh grant keeps working.
  const refreshed = await fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource }) });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());

  // The browser session that consented ends. The grant keeps its provenance and still refreshes.
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId]);
  assert.equal((await pool.query('SELECT 1 FROM auth_session_identities WHERE session_id = $1', [sessionId])).rowCount, 0);
  assert.deepEqual(await grantFacts(), before, 'the grant keeps its authentication facts after the session is removed');
  const afterSession = await fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: (await refreshed.json() as { refresh_token: string }).refresh_token, client_id: clientId, resource }) });
  assert.equal(afterSession.status, 200, await afterSession.clone().text());
});

/** The immutable facts of the first minted family for this client (#310 AC-3). */
async function grantAuthentication(userId: string, client: string) {
  const row = (await pool.query(`SELECT b.auth_method, b.auth_idp_sid, b.auth_confirmed_at > now() - interval '10 minutes' AS recent
    FROM oauth_grant_authentication b JOIN oauth_refresh_token r ON r.authorization_code_id = b.authorization_code_id
    WHERE b.user_id = $1 AND r.client_id = $2 ORDER BY b.created_at LIMIT 1`, [userId, client])).rows[0];
  return { method: row?.auth_method as string | null, idpSid: row?.auth_idp_sid as string | null, recent: row?.recent as boolean | null };
}

test('a grant authorized with a password records password, and keeps that after the session ends', async () => {
  const context = await fresh();
  const page = await context.newPage();
  const email = `password-grant-${randomUUID()}@flux.test`;
  const signUp = await context.request.post(`${origin}/api/auth/sign-up/email`, { headers: { origin },
    data: { email, password: 'Correct-horse-battery-2026', name: 'Password Grant' } });
  if (signUp.status() === 403) { assert.equal((await signUp.json() as { code: string }).code, 'SIGNUP_CLOSED'); return; }
  assert.equal(signUp.status(), 200, await signUp.text());
  const userId = (await api<{ user: { id: string } }>(context, 'GET', '/api/v1/me')).user.id;
  const workspace = await api<{ id: string }>(context, 'POST', '/api/v1/workspaces', { name: 'Password lab' }, 201);
  const project = await api<{ id: string }>(context, 'POST', `/api/v1/workspaces/${workspace.id}/projects`, { name: 'Password project', visibility: 'restricted' }, 201);
  const agent = await api<{ id: string }>(context, 'POST', `/api/v1/workspaces/${workspace.id}/agents`, { name: 'Password agent', owner: 'self' }, 201);
  await api(context, 'POST', `/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, 201);
  const connection = await api<{ id: string }>(context, 'POST', '/api/v1/agent-connections',
    { agentId: agent.id, selectedProjectIds: [project.id], scopes: ['flux.context.read'] }, 201);
  const { verifier, challenge } = pkce();
  await page.goto(authorizeUrl(clientId, loopback, challenge, { scope: 'flux.context.read offline_access' }));
  const callback = await chooseAndConsent(context, page, loopback, connection.id);
  const tokens = await redeem(callback, verifier, loopback, clientId);
  const sessionId = (await api<{ session: { id: string } }>(context, 'GET', '/api/v1/me')).session.id;
  const before = await grantAuthentication(userId, clientId);
  assert.equal(before.method, 'password', 'a password sign-in is recorded as password');
  assert.equal(before.idpSid, null, 'and has no provider session');
  assert.equal(before.recent, true);
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId]);
  assert.deepEqual(await grantAuthentication(userId, clientId), before, 'the grant keeps the password facts after the session is removed');
  const refreshed = await fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource }) });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
});

test('a provider access token or ID token at /mcp gets 401', async () => {
  const issued = await fetch(`${keycloak}/realms/flux/protocol/openid-connect/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'probe', username: 'erin', password: idpPassword, scope: 'openid email' }) });
  assert.equal(issued.status, 200, await issued.clone().text());
  const tokens = await issued.json() as { access_token: string; id_token: string };
  assert.ok(tokens.access_token && tokens.id_token);
  for (const [name, token] of Object.entries(tokens)) {
    if (name !== 'access_token' && name !== 'id_token') continue;
    assert.equal((await mcp(token, 2, 'tools/list')).status, 401, `${name} from the provider`);
  }
  assert.equal((await mcp('not-a-token', 3, 'tools/list')).status, 401, 'negative control: nonsense');
});

test('a cancelled provider step returns to /login with the signed request, and the authorization then completes', async () => {
  const context = await fresh();
  const page = await context.newPage();
  const { verifier, challenge } = pkce();
  await toProvider(page, authorizeUrl(clientId, loopback, challenge));
  const toKeycloak = new URL(page.url());
  const flux = new URL(toKeycloak.searchParams.get('redirect_uri')!);
  // The provider refuses the sign-in, as when the person cancels.
  await page.goto(`${flux.origin}${flux.pathname}?error=access_denied&state=${encodeURIComponent(toKeycloak.searchParams.get('state')!)}`);
  await page.waitForURL((target) => target.pathname === '/login');
  assert.ok(new URL(page.url()).searchParams.get('sig'), 'the signed request is still on the address');
  await page.getByText('Single sign-on didn’t complete').waitFor();
  assert.equal((await context.request.get(`${origin}/api/v1/me`)).status(), 401, 'nobody was signed in');
  // Try again from the same page.
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
  await page.waitForURL((target) => target.origin === keycloak);
  await providerLogin(page, 'erin');
  const callback = await chooseAndConsent(context, page, loopback);
  assert.equal(callback.searchParams.get('state') !== null, true);
  await redeem(callback, verifier, loopback, clientId);
});

test('a tampered continuation is refused, on the provider request and on the connection choice', async () => {
  const context = await fresh();
  const page = await context.newPage();
  const { challenge } = pkce();
  await page.goto(authorizeUrl(clientId, loopback, challenge));
  const signed = page.url().split('?')[1]!;
  const tampered = signed.replace('flux.proposal.write', 'flux.action.execute');
  assert.notEqual(tampered, signed);
  const social = await context.request.post(`${origin}/api/auth/sign-in/social`, { headers: { origin },
    data: { provider: providerId, callbackURL: '/', disableRedirect: true, oauth_query: tampered } });
  assert.ok(social.status() >= 400 && social.status() < 500, `tampered provider sign-in: ${social.status()}`);
  assert.ok(!(await social.text()).includes('keycloak'), 'no provider redirect for a tampered request');
  const control = await context.request.post(`${origin}/api/auth/sign-in/social`, { headers: { origin },
    data: { provider: providerId, callbackURL: '/', disableRedirect: true, oauth_query: signed } });
  assert.equal(control.status(), 200, 'negative control: the untouched request starts the provider sign-in');
  assert.ok(((await control.json()) as { url: string }).url.startsWith(keycloak));
});

test('redirect rules hold on the provider path: another loopback port passes, another path or host does not', async () => {
  const { challenge } = pkce();
  const outcome = async (redirectUri: string) => {
    const response = await fetch(authorizeUrl(clientId, redirectUri, challenge), { redirect: 'manual', headers: { accept: 'text/html' } });
    const location = response.headers.get('location') ?? (await response.json().catch(() => null) as { url?: string } | null)?.url ?? '';
    return { status: response.status, toLogin: new URL(location, origin).pathname === '/login' };
  };
  const another = await outcome('http://127.0.0.1:20001/callback'); assert.equal(another.toLogin, true, `another port on 127.0.0.1: ${another.status}`);
  const localhostClient = await registerClient('http://localhost:19738/callback');
  const asLocalhost = await fetch(authorizeUrl(localhostClient, 'http://localhost:20002/callback', challenge), { redirect: 'manual', headers: { accept: 'text/html' } });
  const localhostTarget = asLocalhost.headers.get('location') ?? ((await asLocalhost.json().catch(() => null)) as { url?: string } | null)?.url ?? '';
  assert.equal(new URL(localhostTarget, origin).pathname, '/login', 'another port on localhost');
  for (const bad of ['http://127.0.0.1:19737/other', 'http://localhost:19737/callback', 'http://127.0.0.2:19737/callback', 'https://example.com/callback']) {
    assert.equal((await outcome(bad)).toLogin, false, `refused: ${bad}`);
  }
});

test('/login says the provider is reachable, and offers no password form (single sign-on only, #313)', async () => {
  const page = await (await fresh()).newPage();
  const { challenge } = pkce();
  await page.goto(authorizeUrl(clientId, loopback, challenge));
  assert.equal(await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel('Password').count(), 0, 'no password field while the provider is the only way in');
  const capabilities = await (await page.context().request.get(`${origin}/api/v1/auth/capabilities`)).json() as { sso: { reachable: boolean }; signup: string; passwordReset: string };
  assert.equal(capabilities.sso.reachable, true);
  assert.deepEqual([capabilities.signup, capabilities.passwordReset], ['off', 'unavailable']);
  // Negative control at the API: the password route is refused even when called directly.
  const direct = await page.context().request.post(`${origin}/api/auth/sign-in/email`, { data: { email: 'nobody@example.test', password: 'pw-direct-call-1' }, headers: { origin } });
  assert.equal(direct.status(), 403, 'password sign-in is refused under single sign-on');
  assert.equal((await direct.json() as { code: string }).code, 'SSO_ONLY');
});

// --- F-024 S4 (#311): the standing check of the person's account at the identity provider ---

async function keycloakAdmin() {
  const token = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: adminPassword }) });
  assert.equal(token.status, 200, await token.clone().text());
  const { access_token: accessToken } = await token.json() as { access_token: string };
  const call = async (method: string, path: string, body?: unknown) => fetch(`${keycloak}/admin/realms/flux${path}`, {
    method, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const userId = async (username: string) => {
    const [user] = await (await call('GET', `/users?username=${encodeURIComponent(username)}&exact=true`)).json() as { id: string }[];
    assert.ok(user, `the IdP user ${username}`);
    return user.id;
  };
  const flux = async () => {
    const [client] = await (await call('GET', '/clients?clientId=flux')).json() as { id: string; attributes: Record<string, string> }[];
    assert.ok(client);
    return client;
  };
  return {
    async setEnabled(username: string, enabled: boolean) {
      const id = await userId(username);
      const user = await (await call('GET', `/users/${id}`)).json() as Record<string, unknown>;
      const updated = await call('PUT', `/users/${id}`, { ...user, enabled });
      assert.equal(updated.status, 204, await updated.text());
    },
    /** `use.refresh.tokens` false makes Keycloak return no refresh token, even for offline_access. */
    async setRefreshTokens(on: boolean) {
      const client = await flux();
      const updated = await call('PUT', `/clients/${client.id}`, { ...client, attributes: { ...client.attributes, 'use.refresh.tokens': String(on) } });
      assert.equal(updated.status, 204, await updated.text());
    },
  };
}

async function waitFor<T>(check: () => Promise<T | null | false>, what: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const standingRow = async (userId: string) => (await pool.query(
  `SELECT state, reason, refresh_token_enc, last_outcome, confirmed_at, next_check_at FROM auth_idp_standing WHERE user_id = $1 AND provider_id = $2`, [userId, providerId])).rows[0] as
  { state: string; reason: string | null; refresh_token_enc: string | null; last_outcome: string | null; confirmed_at: Date | null; next_check_at: Date } | undefined;
/** Makes the checker in `api` pick the identity up on its next tick (every couple of seconds in this stack). */
const dueNow = (userId: string) => pool.query(`UPDATE auth_idp_standing SET next_check_at = now() WHERE user_id = $1 AND provider_id = $2`, [userId, providerId]);

const standing: { context?: BrowserContext; tokens?: { access_token: string; refresh_token: string } } = {};

test('standing: sign-in stored the provider refresh token sealed, and a healthy check renews the confirmation', async () => {
  const context = await fresh();
  const page = await context.newPage();
  const { verifier, challenge } = pkce();
  await toProvider(page, authorizeUrl(clientId, loopback, challenge));
  await providerLogin(page, 'erin');
  standing.tokens = await redeem(await chooseAndConsent(context, page, loopback), verifier, loopback, clientId);
  standing.context = context;

  const row = await standingRow(state.userId!);
  assert.equal(row?.state, 'ok');
  assert.ok(row?.refresh_token_enc?.startsWith('v1.'), 'a sealed token, not a bare JWT');
  assert.ok(!row!.refresh_token_enc!.includes('eyJ'), 'the provider token is not stored in the clear');
  assert.ok((await mcp(standing.tokens.access_token, 10, 'tools/list')).status === 200, 'negative control: standing lets the bearer through');

  await pool.query(`UPDATE auth_idp_standing SET confirmed_at = now() - interval '2 hours', last_outcome = NULL WHERE user_id = $1 AND provider_id = $2`, [state.userId, providerId]);
  await dueNow(state.userId!);
  const renewed = await waitFor(async () => { const now = await standingRow(state.userId!); return now?.last_outcome === 'success' && now ? now : null; }, 'a successful check');
  assert.equal(renewed.state, 'ok');
  assert.ok(Date.now() - renewed.confirmed_at!.getTime() < 60_000, 'confirmation is now');
  const lease = (await pool.query('SELECT lease_id FROM auth_idp_standing WHERE user_id = $1', [state.userId])).rows[0];
  assert.equal(lease.lease_id, null, 'the lease is released after the check');
});

test('standing: disabling the user at the provider suspends access without revoking anything, and enabling restores it', async () => {
  const admin = await keycloakAdmin();
  const { context, tokens } = standing;
  assert.equal((await context!.request.get(`${origin}/api/v1/me`)).status(), 200, 'negative control: the browser session works');
  const revokedBefore = (await pool.query('SELECT 1 FROM oauth_refresh_token WHERE user_id = $1 AND revoked IS NOT NULL', [state.userId])).rowCount;
  await admin.setEnabled('erin', false);
  await dueNow(state.userId!);
  const suspended = await waitFor(async () => { const row = await standingRow(state.userId!); return row?.state === 'sign_in_required' ? row : null; }, 'sign in required');
  assert.equal(suspended.reason, 'invalid_grant');

  assert.equal((await context!.request.get(`${origin}/api/v1/me`)).status(), 401, 'the browser session is gone');
  assert.equal((await pool.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [state.userId])).rowCount, 0, 'the sessions are deleted');
  const refused = await mcp(tokens!.access_token, 11, 'tools/list');
  assert.equal(refused.status, 401, 'a bearer the provider no longer stands behind');
  assert.match(refused.headers.get('www-authenticate') ?? '', /error="invalid_token", error_description="Sign in again with Keycloak\."/);
  const refresh = () => fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens!.refresh_token, client_id: clientId, resource }) });
  const refreshRefused = await refresh();
  assert.equal(refreshRefused.status, 400);
  const body = await refreshRefused.json() as { error: string; error_description: string };
  assert.equal(body.error, 'invalid_grant');
  assert.match(body.error_description, /^Sign in again with Keycloak\.$/);
  // Nothing was revoked: the connection and the person's OAuth refresh tokens are as they were.
  const revoked = await pool.query('SELECT 1 FROM oauth_refresh_token WHERE user_id = $1 AND revoked IS NOT NULL', [state.userId]);
  assert.equal(revoked.rowCount, revokedBefore, 'no MCP refresh token was revoked by the suspension');
  assert.equal((await pool.query('SELECT 1 FROM agent_connections WHERE id = $1 AND revoked_at IS NULL', [state.connectionId])).rowCount, 1, 'the connection stays the owner\'s');
  // The checks keep running for a suspended identity (N5): the next one is already scheduled.
  assert.ok((await standingRow(state.userId!))!.next_check_at.getTime() > Date.now() - 1000);

  await admin.setEnabled('erin', true);
  await dueNow(state.userId!);
  await waitFor(async () => (await standingRow(state.userId!))?.state === 'ok', 'standing restored by a later successful check');
  assert.equal((await mcp(tokens!.access_token, 12, 'tools/list')).status, 200, 'the kept access token works again');
  assert.equal((await refresh()).status, 200, 'a client that kept its refresh token can refresh');
  assert.equal((await context!.request.get(`${origin}/api/v1/me`)).status(), 401, 'the deleted browser session does not come back');
});

test('standing: a provider that returns no refresh token is refused with a clear message, and a normal sign-in works after', async () => {
  const admin = await keycloakAdmin();
  const signIn = async () => {
    const context = await fresh();
    const page = await context.newPage();
    await page.goto(`${origin}/sign-in`);
    await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
    await page.waitForURL((target) => target.origin === keycloak);
    await providerLogin(page, 'frank');
    await page.waitForURL((target) => target.origin === origin, { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    return { context, page };
  };
  await admin.setRefreshTokens(false);
  try {
    const refusedSignIn = await signIn();
    assert.equal(new URL(refusedSignIn.page.url()).searchParams.get('sso_reason'), 'no_refresh_token');
    await refusedSignIn.page.getByText('allow offline access for Flux').waitFor();
    assert.equal((await refusedSignIn.context.request.get(`${origin}/api/v1/me`)).status(), 401, 'nobody was signed in');
    const frank = await pool.query(`SELECT u.id FROM auth_users u WHERE u.email = 'frank@acme.test'`);
    assert.equal(frank.rowCount, 0, 'no account or session came of the refused sign-in');
  } finally { await admin.setRefreshTokens(true); }
  const accepted = await signIn();
  assert.equal((await accepted.context.request.get(`${origin}/api/v1/me`)).status(), 200, 'negative control: with the refresh token, sign-in works');
  const frankId = ((await (await accepted.context.request.get(`${origin}/api/v1/me`)).json()) as { user: { id: string } }).user.id;
  assert.equal((await standingRow(frankId))?.state, 'ok');
});

/** Moves the person's last provider confirmation back, as if that long had passed (the age is 12h for this run). */
const confirmedHoursAgo = async (hours: number) => {
  await pool.query(`UPDATE auth_accounts SET confirmed_at = now() - make_interval(hours => $3) WHERE user_id = $1 AND provider_id = $2`, [state.userId, providerId, hours]);
  // The standing check (S4) renews the same confirmation; hold its next check back so it cannot undo the aging.
  await pool.query(`UPDATE auth_idp_standing SET confirmed_at = now() - make_interval(hours => $3), next_check_at = now() + interval '1 day', lease_id = NULL, lease_until = NULL
    WHERE user_id = $1 AND provider_id = $2`, [state.userId, providerId, hours]);
};
const refreshGrant = (token: string) => fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource }) });

test('confirmation age (S2): within the age everything works, past it the browser, MCP and the refresh grant are refused', async () => {
  const context = await fresh();
  const page = await context.newPage();
  const { verifier, challenge } = pkce();
  await toProvider(page, authorizeUrl(clientId, loopback, challenge));
  await providerLogin(page, 'erin');
  const callback = await chooseAndConsent(context, page, loopback);
  let tokens = await redeem(callback, verifier, loopback, clientId);
  const confirmed = (await pool.query('SELECT confirmed_at > now() - interval \'5 minutes\' AS recent FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [state.userId, providerId])).rows;
  assert.deepEqual(confirmed, [{ recent: true }], 'the provider sign-in confirmed the identity');

  // Within the configured 12h (not the 7d default): all three still work.
  await confirmedHoursAgo(11);
  assert.equal((await mcp(tokens.access_token, 10, 'tools/list')).status, 200, 'MCP within the age');
  assert.equal((await context.request.get(`${origin}/api/v1/me`)).status(), 200, 'browser session within the age');
  const renewed = await refreshGrant(tokens.refresh_token);
  assert.equal(renewed.status, 200, await renewed.clone().text());
  tokens = await renewed.json() as typeof tokens;

  // Past it.
  await confirmedHoursAgo(13);
  const refused = await mcp(tokens.access_token, 11, 'tools/list');
  assert.equal(refused.status, 401, 'MCP past the age');
  assert.match(refused.headers.get('www-authenticate') ?? '', /error="invalid_token", error_description="Sign in again with Keycloak\."/);
  assert.match((refused.message as { error?: { message?: string } } | null)?.error?.message ?? '', /^Sign in again with Keycloak\.$/);
  assert.equal(refused.headers.get('cache-control'), 'no-store');
  const refresh = await refreshGrant(tokens.refresh_token);
  assert.equal(refresh.status, 400);
  const body = await refresh.json() as { error: string; error_description: string };
  assert.equal(body.error, 'invalid_grant');
  assert.match(body.error_description, /Sign in again/);
  // The authorization step no longer finds a session: it asks for the provider again.
  const { challenge: second } = pkce();
  await page.goto(authorizeUrl(clientId, loopback, second));
  assert.equal(new URL(page.url()).pathname, '/login', 'the authorization step returns to sign-in');
  assert.equal((await context.request.get(`${origin}/api/v1/me`)).status(), 401, 'the browser session is gone');

  // Negative control: with a provider configured, password sign-up is closed, so no password-only person can exist
  // beside the provider's age rules (#313). The former control (a password-only person outside the age) is superseded.
  const password = await fresh();
  const email = `confirmation-${randomUUID()}@example.test`;
  const closed = await password.request.post(`${origin}/api/auth/sign-up/email`, { data: { email, password: `pw-${randomUUID()}`, name: 'Pat' }, headers: { origin } });
  assert.equal(closed.status(), 403, 'password sign-up is closed under single sign-on');
  assert.equal((await closed.json() as { code: string }).code, 'SIGNUP_CLOSED');
});

test('confirmation age (S2): the client authorizes again through the provider and finds the connection it held chosen', async () => {
  await confirmedHoursAgo(13);
  const context = await fresh();
  const page = await context.newPage();
  const { verifier, challenge } = pkce();
  await toProvider(page, authorizeUrl(clientId, loopback, challenge));
  await providerLogin(page, 'erin');
  await page.waitForURL((target) => target.pathname === '/connect-agent', { timeout: 20_000 });
  const held = await api<{ connectionId: string | null }>(context, 'GET', `/api/v1/agent-oauth/held-connection?oauth_query=${encodeURIComponent(page.url().split('?')[1]!)}`);
  assert.equal(held.connectionId, state.connectionId, 'the connection this client held is offered first');
  const callback = await chooseAndConsent(context, page, loopback);
  const tokens = await redeem(callback, verifier, loopback, clientId);
  assert.equal((await mcp(tokens.access_token, 12, 'tools/list')).status, 200, 'the provider sign-in confirmed the person again');
  assert.equal((await refreshGrant(tokens.refresh_token)).status, 200);
  // Negative control: a client that never held a connection is offered none, and the question needs a signed request.
  const other = await registerClient('http://127.0.0.1:19740/callback');
  const { challenge: otherChallenge } = pkce();
  const otherPage = await context.newPage();
  await otherPage.goto(authorizeUrl(other, 'http://127.0.0.1:19740/callback', otherChallenge));
  await otherPage.waitForURL((target) => target.pathname === '/connect-agent', { timeout: 20_000 });
  const none = await api<{ connectionId: string | null }>(context, 'GET', `/api/v1/agent-oauth/held-connection?oauth_query=${encodeURIComponent(otherPage.url().split('?')[1]!)}`);
  assert.equal(none.connectionId, null);
  const forged = await context.request.get(`${origin}/api/v1/agent-oauth/held-connection?oauth_query=${encodeURIComponent(otherPage.url().split('?')[1]!.replace('flux.proposal.write', 'flux.action.execute'))}`);
  assert.equal(forged.status(), 400);
});
