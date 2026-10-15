import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Browser as ApiBrowser } from '../support/http.js';
import { mcp, oauthToken } from '../support/mcp.js';
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
const savedAuthority = '/state/oidc-password-authority.json';
const savedRecovery = '/state/oidc-recovery.json';
const savedRecoverySession = '/state/oidc-recovery-session.json';
const pat = { name: 'Pat Link', email: 'pat.link@example.test', password: `pw-${randomUUID()}` };
const quinn = { name: 'Quinn Link', email: 'quinn.link@example.test', password: `pw-${randomUUID()}` };
const rory = { name: 'Rory Recovery', email: `rory-${randomUUID()}@example.test`, password: `pw-${randomUUID()}` };

const { pool } = createDatabase(process.env.DATABASE_URL!);
// Remove Pat's provider identity so later Keycloak suites can create frank. Quinn keeps the workspace
// used by the authority cutover control; deleting its owner would violate the creator foreign key.
after(async () => {
  // Pat's account takes the provider's address at the cutover sign-in, so match that address too.
  if (phase === 'cutover') await pool.query('DELETE FROM auth_users WHERE email = ANY($1)', [[pat.email, 'frank@acme.test']]);
  await pool.end();
});

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
  const text = await response.text();
  return { status: response.status(), body: text ? JSON.parse(text) as T : null };
}

async function signUpAndIn(context: BrowserContext, person: typeof pat) {
  const up = await api(context, 'POST', '/api/auth/sign-up/email', { name: person.name, email: person.email, password: person.password });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const id = (await pool.query('SELECT id FROM auth_users WHERE email = $1', [person.email])).rows[0].id as string;
  return id;
}

/** Starts the provider sign-in from this browser's session and returns the provider page's URL. */
async function providerUrl(context: BrowserContext) {
  const started = await api<{ url: string }>(context, 'POST', '/api/auth/sign-in/social', { provider: process.env.FLUX_OIDC_PROVIDER_ID, callbackURL: '/settings/account' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return started.body!.url;
}

async function loginAtProvider(page: import('playwright').Page, username: string, url: string, password = idpPassword) {
  await page.goto(url);
  await page.waitForURL((u) => u.origin === keycloak, { timeout: 20_000 });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.waitForURL((u) => u.origin === origin && u.pathname.startsWith('/settings'), { timeout: 20_000 });
}

async function keycloakAdminToken(): Promise<string> {
  const adminPassword = process.env.FLUX_OIDC_TEST_ADMIN_PASSWORD!;
  const tokenResponse = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: adminPassword }) });
  assert.equal(tokenResponse.status, 200, 'Keycloak admin token');
  const { access_token: token } = await tokenResponse.json() as { access_token: string };
  return token;
}

async function createKeycloakUser(username: string, email: string, password: string): Promise<string> {
  const token = await keycloakAdminToken();
  const response = await fetch(`${keycloak}/admin/realms/flux/users`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // Keycloak 26.7 stops a user without a first and last name on its profile page, so the login would never finish.
    body: JSON.stringify({ username, email, firstName: 'Recovery', lastName: 'Fixture', emailVerified: true, enabled: true,
      credentials: [{ type: 'password', value: password, temporary: false }] }) });
  assert.equal(response.status, 201, 'create an isolated IdP identity for this recovery test');
  const location = response.headers.get('location');
  assert.ok(location, 'Keycloak returns the created user location');
  return location!.split('/').at(-1)!;
}

async function recoveryState() {
  return JSON.parse(readFileSync(savedRecovery, 'utf8')) as {
    userId: string; workspaceId: string; oldSubject: string; newSubject: string; heldSubject: string;
    recoveryUsername: string; recoveryPassword: string; clientId: string; accessToken: string; refreshToken: string;
  };
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
      // Settings offers the link in prepare mode (#315): a button named for the provider, shown to the signed-in owner.
      const page = await context.newPage();
      await page.goto(`${origin}/settings/account`);
      await page.getByRole('button', { name: 'Link Keycloak', exact: true }).waitFor({ timeout: 20_000 });
      await context.storageState({ path: saved });
    });
  });

  test('prepare: an ordinary provider sign-in without a link intent is refused and creates no account', async () => {
    await withBrowser(async (browser) => {
      // A fresh browser with no link cookie: the provider sign-in is ordinary, and prepare mode closes it (F-024 S5b).
      const context = await browser.newContext();
      const page = await context.newPage();
      const started = await api<{ url: string }>(context, 'POST', '/api/auth/sign-in/social', { provider: process.env.FLUX_OIDC_PROVIDER_ID,
        callbackURL: '/settings/account', errorCallbackURL: '/sign-in?sso=failed' });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      await page.goto(started.body!.url);
      await page.waitForURL((u) => u.origin === keycloak, { timeout: 20_000 });
      await page.locator('#username').fill('frank');
      await page.locator('#password').fill(idpPassword);
      await page.locator('#kc-login').click();
      await page.waitForURL((u) => u.origin === origin && u.pathname === '/sign-in', { timeout: 20_000 });
      assert.equal(new URL(page.url()).searchParams.get('sso_reason'), 'sign_in_closed', 'refused with the prepare-mode reason');
      await page.getByText('Single sign-on isn’t open for ordinary sign-in yet').waitFor({ timeout: 20_000 });
      assert.equal((await context.request.get(`${origin}/api/v1/me`)).status(), 401, 'no session was created');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_users WHERE email = $1', ['frank@acme.test'])).rows[0].n, 0,
        'no account was created from the provider identity');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_accounts WHERE provider_id = $1', [process.env.FLUX_OIDC_PROVIDER_ID])).rows[0].n, 0,
        'no provider identity was stored');
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
      assert.match(page.url(), /\/settings\/account\?link=linked$/, 'the link completed and returned to settings');
      const linked = (await pool.query('SELECT account_id FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [patId, process.env.FLUX_OIDC_PROVIDER_ID])).rows;
      assert.equal(linked.length, 1, 'the provider subject is linked to Pat');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_users WHERE email = $1', ['frank@acme.test'])).rows[0].n, 0,
        'no account was created from the provider identity; the link adds no email match');
      const [pat0] = (await pool.query('SELECT email, email_verified FROM auth_users WHERE id = $1', [patId])).rows;
      assert.deepEqual(pat0, { email: pat.email, email_verified: false }, 'Pat keeps the address and data');
      // Prepare mode (F-024 S5b): the link is prepared, not managed, but the owner cannot detach the provider identity.
      const state = await api<{ linked: boolean }>(context, 'GET', `/api/v1/identity/links/${process.env.FLUX_OIDC_PROVIDER_ID}`);
      assert.deepEqual(state.body, { providerId: process.env.FLUX_OIDC_PROVIDER_ID, linked: true }, 'Settings can read the link');
      const removal = await api<{ code: string }>(context, 'DELETE', `/api/v1/identity/links/${process.env.FLUX_OIDC_PROVIDER_ID}`);
      assert.equal(removal.status, 403, JSON.stringify(removal.body));
      assert.equal(removal.body!.code, 'PROVIDER_IDENTITY_OPERATOR_ONLY');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [patId, process.env.FLUX_OIDC_PROVIDER_ID])).rows[0].n, 1,
        'the refused removal left the link in place');
      // Settings shows the linked state instead of the link button.
      await page.goto(`${origin}/settings/account`);
      await page.getByText('Keycloak is linked to this account.').waitFor({ timeout: 20_000 });
      assert.equal(await page.getByRole('button', { name: 'Link Keycloak', exact: true }).count(), 0, 'no link button once linked');
    });
  });

  test('prepare: a subject already held by another account is refused, and the other account keeps it', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const quinnId = await signUpAndIn(context, quinn);
      // Mint a real password-authorized MCP family while conversion is open. It must fail after cutover.
      const client = new ApiBrowser();
      for (const cookie of await context.cookies()) client.cookies.set(cookie.name, cookie.value);
      const create = async (path: string, body: unknown) => {
        const response = await client.request('POST', path, { body });
        assert.equal(response.status, 201, response.text);
        return response.json as { id: string };
      };
      const workspace = await create('/api/v1/workspaces', { name: 'Cutover authority control' });
      const project = await create(`/api/v1/workspaces/${workspace.id}/projects`, { name: 'Cutover control', visibility: 'restricted' });
      const agent = await create(`/api/v1/workspaces/${workspace.id}/agents`, { name: 'Cutover control', owner: 'self' });
      await create(`/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' });
      const connection = await create('/api/v1/agent-connections', { agentId: agent.id, selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'] });
      const clientId = `cutover-${randomUUID()}`; const redirectUri = 'http://127.0.0.1:19738/callback';
      await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method,
        grant_types, response_types, scopes, require_pkce, created_at, updated_at)
        VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
      [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
      await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${origin}/mcp`]);
      const tokens = await oauthToken(client, connection.id, clientId, redirectUri);
      assert.equal((await mcp(tokens.access_token, 81, 'tools/list')).status, 200, 'prepare permits password-authorized bearer');
      const renewed = await context.request.post(`${origin}/api/auth/oauth2/token`, {
        headers: { origin }, form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${origin}/mcp` } });
      assert.equal(renewed.status(), 200, 'prepare permits refresh before cutover');
      writeFileSync(savedAuthority, JSON.stringify({ clientId, ...await renewed.json() as { access_token: string; refresh_token: string } }));
      const started = await api(context, 'POST', '/api/v1/identity/link');
      assert.equal(started.status, 200);
      const page = await context.newPage();
      const url = await providerUrl(context);
      await loginAtProvider(page, 'frank', url);
      assert.match(page.url(), /\/settings\/account\?link=identity_held$/, 'refused with a reason, not linked');
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
      assert.match(page.url(), /\/settings\/account\?link=/, 'the callback is answered, not signed in');
      assert.equal((await other.request.get(`${origin}/api/v1/me`)).status(), 401, 'no session was created by the link callback');
    });
  });

  test('prepare: seed an explicit old-issuer recovery account with real MCP authority', async () => {
    assert.ok(process.env.FLUX_OIDC_OLD_PROVIDER_ID, 'the explicit old-issuer fixture id is supplied');
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const userId = await signUpAndIn(context, rory);
      const client = new ApiBrowser();
      for (const cookie of await context.cookies()) client.cookies.set(cookie.name, cookie.value);
      const create = async (path: string, body: unknown) => {
        const response = await client.request('POST', path, { body });
        assert.equal(response.status, 201, response.text);
        return response.json as { id: string };
      };
      const workspace = await create('/api/v1/workspaces', { name: 'Issuer recovery history' });
      const project = await create(`/api/v1/workspaces/${workspace.id}/projects`, { name: 'Kept recovery project', visibility: 'restricted' });
      const agent = await create(`/api/v1/workspaces/${workspace.id}/agents`, { name: 'Recovery agent', owner: 'self' });
      await create(`/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' });
      const connection = await create('/api/v1/agent-connections', { agentId: agent.id, selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'] });
      const recoveryClientId = `issuer-recovery-${randomUUID()}`;
      const redirectUri = 'http://127.0.0.1:19739/callback';
      await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method,
        grant_types, response_types, scopes, require_pkce, created_at, updated_at)
        VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
      [randomUUID(), recoveryClientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
      await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
        [randomUUID(), recoveryClientId, `${origin}/mcp`]);
      const tokens = await oauthToken(client, connection.id, recoveryClientId, redirectUri);
      assert.equal((await mcp(tokens.access_token, 91, 'tools/list')).status, 200, 'the old login has live MCP authority before recovery');

      const oldSubject = `legacy-${randomUUID()}`;
      const recoveryUsername = `issuer-recovery-${randomUUID()}`;
      const recoveryPassword = idpPassword;
      const recoveryEmail = `${recoveryUsername}@example.test`;
      const newSubject = await createKeycloakUser(recoveryUsername, recoveryEmail, recoveryPassword);
      const patId = (await pool.query('SELECT id FROM auth_users WHERE email = $1', [pat.email])).rows[0].id as string;
      const [held] = (await pool.query('SELECT account_id FROM auth_accounts WHERE user_id = $1 AND provider_id = $2',
        [patId, process.env.FLUX_OIDC_PROVIDER_ID])).rows;
      assert.ok(held?.account_id, 'the normal current-provider link supplies a real held-subject control');
      await pool.query('INSERT INTO auth_accounts (id,user_id,account_id,provider_id) VALUES ($1,$2,$3,$4)',
        [randomUUID(), userId, oldSubject, process.env.FLUX_OIDC_OLD_PROVIDER_ID]);
      await pool.query(`INSERT INTO auth_idp_standing (user_id,provider_id,state,refresh_token_enc,refresh_token_sid,next_check_at)
        VALUES ($1,$2,'ok','sealed-old-issuer-token','old-provider-session',now() + interval '1 hour')`,
      [userId, process.env.FLUX_OIDC_OLD_PROVIDER_ID]);
      await context.storageState({ path: savedRecoverySession });
      writeFileSync(savedRecovery, JSON.stringify({ userId, workspaceId: workspace.id, oldSubject, newSubject, heldSubject: held.account_id,
        recoveryUsername, recoveryPassword, clientId: recoveryClientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token }));
    });
  });
}

if (phase === 'cutover') {
  test('cutover: an unlinked password owner loses MCP bearer and refresh authority', async () => {
    const tokens = JSON.parse(readFileSync(savedAuthority, 'utf8')) as { clientId: string; access_token: string; refresh_token: string };
    const refused = await mcp(tokens.access_token, 82, 'tools/list');
    assert.equal(refused.status, 401, 'the bearer is refused at the MCP boundary');
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const response = await context.request.post(`${origin}/api/auth/oauth2/token`, {
        headers: { origin }, form: { grant_type: 'refresh_token', client_id: tokens.clientId, refresh_token: tokens.refresh_token, resource: `${origin}/mcp` } });
      assert.equal(response.status(), 400, 'the refresh grant is refused after cutover');
      assert.equal((await response.json() as { error: string }).error, 'invalid_grant');
    });
  });

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
      // Negative control: in SSO-only mode settings offers no link, because the provider is the only way in (#315).
      // Wait for the settings page itself, so the absence below is not just an unloaded page.
      await page.getByRole('heading', { name: 'Account', exact: true }).waitFor({ timeout: 20_000 });
      assert.equal(await page.getByRole('button', { name: 'Link Keycloak', exact: true }).count(), 0, 'no link row in SSO-only mode');
      assert.equal(await page.getByRole('heading', { name: 'Single sign-on' }).count(), 0, 'no single sign-on section in SSO-only mode');
      // The owner cannot detach the provider identity in SSO-only mode either (F-024 S5b): recovery is the operator's.
      const removed = await api<{ code: string }>(context, 'DELETE', `/api/v1/identity/links/${process.env.FLUX_OIDC_PROVIDER_ID}`);
      assert.equal(removed.status, 403, JSON.stringify(removed.body));
      assert.equal(removed.body!.code, 'PROVIDER_IDENTITY_OPERATOR_ONLY');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [patId, process.env.FLUX_OIDC_PROVIDER_ID])).rows[0].n, 1,
        'the refused unlink left the link in place');
      const me = await api<{ user: { id: string; email: string } }>(context, 'GET', '/api/v1/me');
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body!.user.id, patId, 'the same Flux account, with its data and memberships');
      // The same subject keeps the same Flux account; a sign-in takes the provider's verified address (#113).
      assert.equal(me.body!.user.email, 'frank@acme.test', 'the account takes the verified provider address on sign-in');
    });
  });
}

if (phase === 'recovery') {
  test('recovery: issuer re-key keeps the Flux account, revokes old authority, and accepts the new verified subject', async () => {
    assert.ok(existsSync(savedRecovery), 'the explicit recovery fixture ran first');
    const savedRecoveryState = await recoveryState();
    const legacy = await pool.query('SELECT provider_id,account_id FROM auth_accounts WHERE user_id=$1 AND provider_id=$2',
      [savedRecoveryState.userId, process.env.FLUX_OIDC_OLD_PROVIDER_ID]);
    assert.deepEqual(legacy.rows, [], 'the old issuer mapping was atomically replaced');
    const active = await pool.query('SELECT provider_id,account_id FROM auth_accounts WHERE user_id=$1 AND provider_id=$2',
      [savedRecoveryState.userId, process.env.FLUX_OIDC_PROVIDER_ID]);
    assert.deepEqual(active.rows, [{ provider_id: process.env.FLUX_OIDC_PROVIDER_ID, account_id: savedRecoveryState.newSubject }]);
    const audit = await pool.query(`SELECT old_issuer,new_issuer,old_subject,new_subject,actor,reason
      FROM auth_identity_audit WHERE user_id=$1 AND action='rekey' ORDER BY created_at DESC LIMIT 1`, [savedRecoveryState.userId]);
    assert.deepEqual(audit.rows[0], { old_issuer: process.env.FLUX_OIDC_OLD_ISSUER, new_issuer: 'http://keycloak:8080/realms/flux',
      old_subject: savedRecoveryState.oldSubject, new_subject: savedRecoveryState.newSubject, actor: 'operator-cli', reason: 'issuer migration test' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_idp_standing WHERE user_id=$1 AND provider_id=$2',
      [savedRecoveryState.userId, process.env.FLUX_OIDC_OLD_PROVIDER_ID])).rows[0].n, 0, 'the obsolete offline IdP refresh state is removed');

    await withBrowser(async (browser) => {
      const oldSession = await browser.newContext({ storageState: savedRecoverySession });
      assert.equal((await oldSession.request.get(`${origin}/api/v1/me`)).status(), 401, 'the pre-recovery browser session ended');
      assert.equal((await mcp(savedRecoveryState.accessToken, 92, 'tools/list')).status, 401, 'the old MCP bearer no longer works');
      const refresh = await oldSession.request.post(`${origin}/api/auth/oauth2/token`, { headers: { origin }, form: {
        grant_type: 'refresh_token', client_id: savedRecoveryState.clientId, refresh_token: savedRecoveryState.refreshToken, resource: `${origin}/mcp`,
      } });
      assert.equal(refresh.status(), 400, 'the old MCP refresh grant is revoked');
      assert.equal((await refresh.json() as { error: string }).error, 'invalid_grant');

      const context = await browser.newContext();
      const page = await context.newPage();
      await loginAtProvider(page, savedRecoveryState.recoveryUsername, await providerUrl(context), savedRecoveryState.recoveryPassword);
      const me = await api<{ user: { id: string } }>(context, 'GET', '/api/v1/me');
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body!.user.id, savedRecoveryState.userId, 'verified sign-in resolves to the original Flux account');
      const workspaces = await api<{ id: string }[]>(context, 'GET', '/api/v1/workspaces');
      assert.ok(workspaces.body!.some((workspace) => workspace.id === savedRecoveryState.workspaceId), 'the original account data remains attached');
    });
  });
}
