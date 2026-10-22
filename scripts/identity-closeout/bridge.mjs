// Docker-only identity custody bridge. Invoked by bridge.py with a private /state mount.
// Product sessions and OAuth families are created by genuine browser/PKCE flows, never SQL inserts.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const { chromium } = require('playwright');
const { createDatabase } = await import('/app/packages/db/dist/index.js');
const { openToken, sealKey } = await import('/app/apps/server/dist/identity/standing.js');
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const providerId = process.env.FLUX_OIDC_PROVIDER_ID;
const phase = process.env.FLUX_IDENTITY_BRIDGE_PHASE;
const { pool } = createDatabase(process.env.DATABASE_URL);
const statePath = '/state/managed.json';
const observedResponses = [];
const proxy = http.createServer((request, response) => {
  const outgoing = http.request({ hostname: 'api', port: 8080, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode, answer.headers); answer.pipe(response);
  });
  outgoing.on('error', () => response.destroy()); request.pipe(outgoing);
});
await new Promise((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

async function api(context, method, path, body, expected = [200, 201, 204]) {
  const response = await context.request.fetch(`${origin}${path}`, { method, headers: { origin }, data: body });
  assert.ok(expected.includes(response.status()), `${method} ${path}: HTTP ${response.status()}`);
  const text = await response.text(); observedResponses.push(text);
  return response.status() === 204 ? null : JSON.parse(text);
}
async function provider(page) {
  await page.waitForURL((url) => url.origin === 'http://keycloak:8080');
  await page.locator('#username').fill('erin');
  await page.locator('#password').fill(process.env.FLUX_OIDC_TEST_PASSWORD);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === origin, { timeout: 30_000 });
}
async function signIn() {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`${origin}/sign-in`);
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
  await provider(page);
  const me = await api(context, 'GET', '/api/v1/me');
  return { context, page, userId: me.user.id };
}
async function mcp(token, name = 'flux_list_contexts', args = {}) {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  observedResponses.push(text);
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) : text;
  const body = data ? JSON.parse(data) : null;
  return { status: response.status, headers: response.headers, body, text };
}
async function refresh(family) {
  const response = await fetch(`${origin}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: family.refresh_token, client_id: family.clientId, resource: `${origin}/mcp` }) });
  return { status: response.status, body: await response.json() };
}
async function authorize(connectionId, index) {
  const clientId = `identity-bridge-${index}-${randomUUID()}`; const redirect = 'http://127.0.0.1:19849/callback';
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Operator bridge client', $3, 'none', '{authorization_code,refresh_token}', '{code}', '{flux.context.read,flux.proposal.write,flux.action.execute,offline_access}', true, now(), now())`, [randomUUID(), clientId, [redirect]]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1,$2,$3,now())', [randomUUID(), clientId, `${origin}/mcp`]);
  const verifier = randomBytes(32).toString('base64url'); const state = randomUUID();
  const url = new URL('/api/auth/oauth2/authorize', origin);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    scope: 'flux.context.read flux.proposal.write flux.action.execute offline_access', state, resource: `${origin}/mcp` }).toString();
  const context = await browser.newContext(); const page = await context.newPage(); await page.goto(url.toString());
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click(); await provider(page);
  await page.waitForURL(`${origin}/connect-agent?**`);
  const query = new URL(page.url()).search.slice(1);
  await api(context, 'POST', `/api/v1/agent-connections/${connectionId}/select-for-oauth`, { oauth_query: query }, [204]);
  let next = await api(context, 'POST', '/api/auth/oauth2/continue', { postLogin: true, oauth_query: query });
  let target = new URL(next.url ?? next.redirect_uri, origin);
  if (target.pathname === '/consent') {
    next = await api(context, 'POST', '/api/auth/oauth2/consent', { accept: true, oauth_query: target.search.slice(1) });
    target = new URL(next.url ?? next.redirect_uri, origin);
  }
  assert.equal(target.searchParams.get('state'), state); assert.equal(target.searchParams.get('iss'), `${origin}/api/auth`);
  const response = await fetch(`${origin}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: target.searchParams.get('code'), client_id: clientId,
      code_verifier: verifier, redirect_uri: redirect, resource: `${origin}/mcp` }) });
  assert.equal(response.status, 200, 'genuine provider-backed code exchange');
  const tokens = await response.json();
  await context.storageState({ path: `/state/browser-${index}.json` });
  return { ...tokens, clientId };
}
async function facts(state) {
  const clientIds = state.families.map((family) => family.clientId);
  const provenance = (await pool.query(`SELECT f.* FROM oauth_grant_authentication f WHERE f.authorization_code_id IN
    (SELECT authorization_code_id FROM oauth_refresh_token WHERE client_id = ANY($1)) ORDER BY f.authorization_code_id`, [clientIds])).rows;
  const bindings = (await pool.query(`SELECT b.* FROM agent_oauth_bindings b WHERE b.connection_id = $1 ORDER BY b.id`, [state.connectionId])).rows;
  const ledger = (await pool.query('SELECT * FROM flux_schema_version ORDER BY version')).rows;
  const sessionIds = state.facts?.sessionIdentities.map((row) => row.session_id);
  const sessionIdentities = sessionIds
    ? (await pool.query('SELECT * FROM auth_session_identities WHERE session_id = ANY($1) ORDER BY session_id', [sessionIds])).rows
    : (await pool.query(`SELECT i.* FROM auth_session_identities i JOIN auth_sessions s ON s.id = i.session_id WHERE s.user_id = $1 ORDER BY i.session_id`, [state.userId])).rows;
  return JSON.parse(JSON.stringify({ provenance, bindings, ledger, sessionIdentities }));
}
async function snapshot(context, state) {
  const value = await api(context, 'GET', `/api/v1/projects/${state.projectId}/export`);
  delete value.exportedAt; if (value.provenance) delete value.provenance.instanceOrigin;
  const file = await context.request.get(`${origin}/api/v1/files/${state.fileId}`);
  assert.equal(file.status(), 200);
  const bytes = await file.body(); assert.equal(bytes.toString('hex'), state.fileHex);
  return { project: value, fileSha256: createHash('sha256').update(bytes).digest('hex') };
}
async function storedSecrets(state) {
  // Freeze only this fixture's cadence, not its standing/confirmation. Its real sign-in supplied the row.
  await pool.query(`UPDATE auth_idp_standing SET next_check_at = now() + interval '1 day' WHERE user_id = $1`, [state.userId]);
  const rows = (await pool.query('SELECT refresh_token_enc FROM auth_idp_standing WHERE user_id = $1', [state.userId])).rows;
  assert.equal(rows.length, 1); assert.ok(rows[0].refresh_token_enc?.startsWith('v1.'));
  const plaintext = openToken(sealKey(process.env.FLUX_AUTH_SECRET), state.userId, providerId, rows[0].refresh_token_enc);
  assert.ok(plaintext);
  assert.ok([plaintext, rows[0].refresh_token_enc].every((value) => observedResponses.every((body) => !body.includes(value))),
    'observed public API/MCP responses contain neither the actual IdP refresh token nor its sealed value');
  await writeFile('/state/secrets.json', JSON.stringify([plaintext, rows[0].refresh_token_enc]), { mode: 0o600 });
  const account = (await pool.query('SELECT access_token, id_token, refresh_token FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [state.userId, providerId])).rows;
  assert.ok(account.length === 1 && account.every((row) => Object.values(row).every((value) => value === null)));
}

try {
  const receipt = { phase, source: process.env.FLUX_PROOF_SOURCE, browser: browser.version() };
  if (phase === 'link') {
    const fixture = JSON.parse(await readFile('/state/native-fixture.json', 'utf8'));
    const context = await browser.newContext(); const page = await context.newPage();
    await api(context, 'POST', '/api/auth/sign-in/email', { email: 'ada@demo.flux.test', password: process.env.FLUX_DEMO_OWNER_PASSWORD });
    await api(context, 'POST', '/api/v1/identity/link');
    const started = await api(context, 'POST', '/api/auth/sign-in/social', { provider: providerId, callbackURL: '/settings/account', errorCallbackURL: '/settings/account?link=failed', disableRedirect: true });
    await page.goto(started.url); await provider(page);
    await page.waitForURL((url) => url.pathname === '/settings/account' && url.searchParams.get('link') === 'linked');
    const me = await api(context, 'GET', '/api/v1/me'); assert.equal(me.user.id, fixture.adaId);
    receipt.sameOwnerLinked = true;
  } else if (phase === 'seed') {
    const fixture = JSON.parse(await readFile('/state/native-fixture.json', 'utf8'));
    const signed = await signIn(); assert.equal(signed.userId, fixture.adaId);
    const agents = await api(signed.context, 'GET', `/api/v1/workspaces/${fixture.workspaceId}/agents`);
    const own = agents.find((agent) => agent.owner.kind === 'human' && agent.owner.id === signed.userId && !agent.revokedAt);
    assert.ok(own, 'the existing native fixture agent remains the same owner\'s');
    const connection = await api(signed.context, 'POST', '/api/v1/agent-connections', { name: 'Managed custody bridge', clientDesignation: 'other',
      agentId: own.id, selectedProjectIds: [fixture.projectId], scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] });
    const state = { userId: signed.userId, projectId: fixture.projectId, connectionId: connection.id,
      fileId: fixture.fileId, fileHex: fixture.fileHex, families: [] };
    for (const index of [0, 1]) state.families.push(await authorize(connection.id, index));
    state.facts = await facts(state); state.snapshot = await snapshot(signed.context, state);
    assert.equal(state.facts.provenance.length, 2);
    assert.ok(state.facts.provenance.every((row) => row.auth_method === providerId));
    await storedSecrets(state); await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    for (const family of state.families) assert.equal((await mcp(family.access_token)).status, 200);
    receipt.realProviderFamilies = state.families.length; receipt.nonemptySealedCustody = true;
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(await facts(state), state.facts, 'original ledger timestamps and 83/86 family facts are unchanged');
    if (phase === 'upgraded') {
      const saved = await browser.newContext({ storageState: '/state/browser-0.json' });
      assert.equal((await api(saved, 'GET', '/api/v1/me')).user.id, state.userId);
      assert.deepEqual(await snapshot(saved, state), state.snapshot);
      for (const family of state.families) assert.equal((await mcp(family.access_token)).status, 200);
      await storedSecrets(state); receipt.populatedUpgradePreserved = true;
    } else if (phase === 'restored') {
      const saved = await browser.newContext({ storageState: '/state/browser-0.json' });
      assert.equal((await saved.request.get(`${origin}/api/v1/me`)).status(), 401);
      const row = (await pool.query('SELECT state, refresh_token_enc FROM auth_idp_standing WHERE user_id = $1', [state.userId])).rows;
      assert.deepEqual(row, [{ state: 'sign_in_required', refresh_token_enc: null }]);
      for (const family of state.families) {
        const rejected = await mcp(family.access_token); assert.equal(rejected.status, 401);
        assert.match(rejected.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
        const renewed = await refresh(family); assert.equal(renewed.status, 400); assert.equal(renewed.body.error, 'invalid_grant');
      }
      receipt.tokenlessBrowserMcpRefreshRefused = true;
    } else if (phase === 'recovered') {
      const signed = await signIn(); assert.equal(signed.userId, state.userId);
      assert.deepEqual(await snapshot(signed.context, state), state.snapshot);
      assert.deepEqual(await facts(state), state.facts);
      for (const family of state.families) {
        assert.equal((await mcp(family.access_token)).status, 200);
        assert.equal((await refresh(family)).status, 200);
      }
      assert.equal((await pool.query('SELECT revoked_at FROM agent_connections WHERE id = $1', [state.connectionId])).rows[0].revoked_at, null);
      await storedSecrets(state); receipt.genuineProviderRecovery = true; receipt.sameKeptGrantsAndOwner = true;
    } else throw new Error('Unknown bridge phase');
  }
  await writeFile(`/state/result-${phase}.json`, JSON.stringify(receipt, null, 2));
  console.log(`IDENTITY_BRIDGE ${JSON.stringify(receipt)}`);
} finally {
  await browser.close(); proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); await pool.end();
}
