import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { Browser, publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, expect } from './support/mcp.js';

// #287: OAuth clients reach Flux only through Client ID Metadata Documents (or, in test deployments,
// the token-gated integration fixture). A member's browser session cannot register a client named
// like a trusted tool with a redirect they control; consent shows where access goes; no Flux page
// can be framed. These requests use plain paths so the file also runs against the code before #287.

const FIXTURE_PATH = '/api/v1/integration/oauth-clients';
const scope = 'flux.context.read flux.proposal.write offline_access';

async function member(label: string) {
  const { browser } = await register(uniqueEmail(label), 'correct horse battery staple');
  const session = expect(await browser.request('GET', '/api/auth/get-session'), 200) as { user: { id: string } };
  return { browser, userId: session.user.id };
}

/** One signed-in owner with a personal agent, a granted project and a saved connection. */
async function owner(label: string) {
  const { browser, userId } = await member(label);
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Client registration' } }), 201);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
    { body: { name: 'Sensor study', visibility: 'restricted' } }), 201);
  const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
    { body: { name: 'Research agent', owner: 'self' } }), 201);
  expect(await browser.request('POST', `/api/v1/projects/${project.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = expect(await browser.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id,
    selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'] } }), 201);
  return { browser, userId, connectionId: String(connection.id) };
}

async function insertClient(clientId: string, name: string, redirectUris: string[], userId: string | null = null) {
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce,
     user_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, $8, now(), now())`,
  [randomUUID(), clientId, name, redirectUris, ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access'], userId]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
}

/** Chooses the connection for a started request and returns the signed consent query. */
async function consentQuery(browser: Browser, connectionId: string, oauthQuery: string) {
  expect(await browser.request('POST', `/api/v1/agent-connections/${connectionId}/select-for-oauth`, { body: { oauth_query: oauthQuery } }), 204);
  const continued = expect(await browser.request('POST', '/api/auth/oauth2/continue', { body: { postLogin: true, oauth_query: oauthQuery } }), 200);
  const destination = new URL(String(continued.url ?? continued.redirect_uri), publicOrigin);
  assert.equal(destination.pathname, '/consent');
  return destination.search.slice(1);
}

async function consentContext(browser: Browser, query: string) {
  return expect(await browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(query)}`), 200);
}

test('a member session cannot register, read, list, update, rotate or delete OAuth clients', async () => {
  const { browser, userId } = await member('oauth-client-member');
  const name = `Claude Code ${randomUUID()}`;
  const created = await browser.request('POST', '/api/auth/oauth2/create-client', { body: {
    client_name: name, application_type: 'native', redirect_uris: ['https://collector.example.net/oauth/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope } });
  assert.equal(created.status, 401, `create-client: ${created.status} ${created.text}`);
  assert.equal((await pool.query('SELECT 1 FROM oauth_client WHERE name = $1', [name])).rowCount, 0, 'no client row was written');

  // RFC 7591 dynamic registration stays off, with or without a session.
  const dynamic = await browser.request('POST', '/api/auth/oauth2/register', { body: {
    client_name: name, redirect_uris: ['https://collector.example.net/oauth/callback'], token_endpoint_auth_method: 'none' } });
  assert.equal(dynamic.status, 403, `register: ${dynamic.status} ${dynamic.text}`);
  const anonymous = await new Browser().request('POST', '/api/auth/oauth2/register', { body: {
    client_name: name, redirect_uris: ['https://collector.example.net/oauth/callback'], token_endpoint_auth_method: 'none' } });
  assert.equal(anonymous.status, 403, `anonymous register: ${anonymous.status} ${anonymous.text}`);
  // The provider's admin endpoints are server-only: the bridge cannot reach them.
  const admin = await browser.request('POST', '/api/auth/admin/oauth2/create-client', { body: {
    client_name: name, redirect_uris: ['https://collector.example.net/oauth/callback'], skip_consent: true } });
  assert.equal(admin.status, 404, `admin create-client: ${admin.status} ${admin.text}`);
  assert.equal((await pool.query('SELECT 1 FROM oauth_client WHERE name = $1', [name])).rowCount, 0, 'no client row was written');

  // Even a client recorded as this member's own cannot be managed through the session.
  const clientId = `flux-owned-${randomUUID()}`;
  await insertClient(clientId, 'Owned registration', ['http://127.0.0.1:19737/callback'], userId);
  const refused: [string, string, unknown][] = [
    ['GET', `/api/auth/oauth2/get-client?client_id=${clientId}`, undefined],
    ['GET', '/api/auth/oauth2/get-clients', undefined],
    ['POST', '/api/auth/oauth2/update-client', { client_id: clientId, update: { client_name: 'Claude Code',
      redirect_uris: ['https://collector.example.net/oauth/callback'] } }],
    ['POST', '/api/auth/oauth2/client/rotate-secret', { client_id: clientId }],
    ['POST', '/api/auth/oauth2/delete-client', { client_id: clientId }],
  ];
  for (const [method, path, body] of refused) {
    const response = await browser.request(method, path, body === undefined ? {} : { body });
    assert.equal(response.status, 401, `${method} ${path}: ${response.status} ${response.text}`);
  }
  const row = await pool.query<{ name: string; redirect_uris: string[] }>('SELECT name, redirect_uris FROM oauth_client WHERE client_id = $1', [clientId]);
  assert.deepEqual(row.rows, [{ name: 'Owned registration', redirect_uris: ['http://127.0.0.1:19737/callback'] }], 'the client is unchanged');
});

test('the token-gated fixture registers a test client that completes the real authorization flow', async () => {
  const token = process.env.FLUX_FIXTURE_TOKEN;
  assert.ok(token, 'FLUX_FIXTURE_TOKEN is set for the test deployment');
  const body = { name: 'Fixture client', redirectUris: ['http://127.0.0.1:19737/callback'], scopes: ['flux.context.read', 'flux.proposal.write', 'offline_access'] };
  const anonymous = new Browser();
  for (const authorization of [undefined, 'Bearer wrong-token', token]) {
    const response = await anonymous.request('POST', FIXTURE_PATH, { body, headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401, `${authorization ?? 'no'} authorization: ${response.status}`);
  }
  // A signed-in session is not the fixture's authority either.
  const { browser, connectionId } = await owner('oauth-client-fixture');
  assert.equal((await browser.request('POST', FIXTURE_PATH, { body })).status, 401);
  for (const invalid of [{ ...body, redirectUris: ['javascript:alert(1)'] }, { ...body, redirectUris: ['https://client.example/cb#x'] },
    { ...body, scopes: ['flux.admin'] }, { ...body, redirectUris: [] }]) {
    const response = await anonymous.request('POST', FIXTURE_PATH, { body: invalid, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  const registered = expect(await anonymous.request('POST', FIXTURE_PATH, { body, headers: { authorization: `Bearer ${token}` } }), 201);
  const clientId = String(registered.clientId);
  const stored = await pool.query<{ name: string; user_id: string | null; scopes: string[]; resource_id: string }>(`SELECT c.name, c.user_id, c.scopes, r.resource_id
    FROM oauth_client c JOIN oauth_client_resource r ON r.client_id = c.client_id WHERE c.client_id = $1`, [clientId]);
  assert.deepEqual(stored.rows, [{ name: 'Fixture client', user_id: null, scopes: body.scopes, resource_id: `${publicOrigin}/mcp` }]);
  const started = await beginOauth(browser, clientId, body.redirectUris[0]!, { prompt: 'consent', scope });
  const context = await consentContext(browser, await consentQuery(browser, connectionId, started.oauthQuery));
  assert.equal(context.clientName, 'Fixture client');
});

test('consent shows the redirect host and the client_id host, and flags a redirect off this computer', async () => {
  const { browser, connectionId } = await owner('oauth-client-consent');
  // A registered client whose redirect is a web address: a look-alike name sends access elsewhere.
  const webClient = `flux-web-${randomUUID()}`;
  await insertClient(webClient, 'Claude Code', ['https://collector.example.net/oauth/callback']);
  const web = await beginOauth(browser, webClient, 'https://collector.example.net/oauth/callback', { prompt: 'consent', scope });
  const shown = await consentContext(browser, await consentQuery(browser, connectionId, web.oauthQuery));
  assert.equal(shown.clientName, 'Claude Code');
  assert.deepEqual(shown.redirect, { kind: 'web', host: 'collector.example.net' });
  assert.equal(shown.clientIdHost, null);

  // A loopback redirect stays on the person's computer; any port is the same registration.
  const localClient = `flux-local-${randomUUID()}`;
  await insertClient(localClient, 'Local CLI', ['http://127.0.0.1:19737/callback']);
  const local = await beginOauth(browser, localClient, 'http://127.0.0.1:52000/callback', { prompt: 'consent', scope });
  const localShown = await consentContext(browser, await consentQuery(browser, connectionId, local.oauthQuery));
  assert.deepEqual(localShown.redirect, { kind: 'loopback', host: '127.0.0.1:52000' });
  assert.equal(localShown.clientIdHost, null);

  // A Client ID Metadata Document client: its client_id is an https URL whose host is shown. Docker has no
  // public metadata host, so the provider-signed query is built here with the deployment's secret.
  const secret = process.env.FLUX_AUTH_SECRET;
  assert.ok(secret, 'FLUX_AUTH_SECRET is shared with the test container');
  const metadataClient = `https://agent-tools.example.org/oauth/${randomUUID()}.json`;
  await insertClient(metadataClient, 'Agent tools', ['http://localhost:43123/callback']);
  const params = new URLSearchParams({ client_id: metadataClient, redirect_uri: 'http://localhost:43123/callback', response_type: 'code',
    code_challenge: 'cimd-consent-challenge', code_challenge_method: 'S256', state: randomUUID(), scope: 'flux.context.read',
    resource: `${publicOrigin}/mcp`, exp: String(Math.floor(Date.now() / 1000) + 600) });
  const canonical = new URLSearchParams([...params.entries()].sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  params.append('sig', createHmac('sha256', secret).update(canonical.toString()).digest('base64'));
  expect(await browser.request('POST', `/api/v1/agent-connections/${connectionId}/select-for-oauth`, { body: { oauth_query: params.toString() } }), 204);
  const metadataShown = await consentContext(browser, params.toString());
  assert.equal(metadataShown.clientIdHost, 'agent-tools.example.org');
  assert.deepEqual(metadataShown.redirect, { kind: 'loopback', host: 'localhost:43123' });
});

test('no Flux page can be framed: the authorization, choice and consent pages refuse it', async () => {
  const { browser } = await member('oauth-client-framing');
  const clientId = `flux-frame-${randomUUID()}`;
  await insertClient(clientId, 'Framing check', ['http://127.0.0.1:19737/callback']);
  const authorize = new URLSearchParams({ client_id: clientId, redirect_uri: 'http://127.0.0.1:19737/callback', response_type: 'code',
    code_challenge: 'framing-challenge', code_challenge_method: 'S256', state: randomUUID(), scope, resource: `${publicOrigin}/mcp` });
  const html = { accept: 'text/html' };
  const responses = {
    authorize: await browser.request('GET', `/api/auth/oauth2/authorize?${authorize}`, { headers: html }),
    choice: await browser.request('GET', '/connect-agent?client_id=x', { headers: html }),
    consent: await browser.request('GET', '/consent?client_id=x', { headers: html }),
    login: await new Browser().request('GET', '/login', { headers: html }),
    app: await browser.request('GET', '/', { headers: html }),
    api: await new Browser().request('GET', '/api/v1/agent-oauth/consent-context?oauth_query=x'),
  };
  for (const [name, response] of Object.entries(responses)) {
    assert.equal(response.headers.get('x-frame-options'), 'DENY', `${name} (${response.status}) sends X-Frame-Options`);
    assert.match(response.headers.get('content-security-policy') ?? '', /(?:^|;)\s*frame-ancestors 'none'\s*(?:;|$)/, `${name} sends frame-ancestors 'none'`);
  }
  assert.equal(responses.consent.status, 200);
  assert.match(responses.consent.text, /<div id="root">/, 'the consent page is the web app document');
});
