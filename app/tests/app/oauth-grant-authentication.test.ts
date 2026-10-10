import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin, register, signIn, uniqueEmail } from './support/http.js';
import { beginOauth, expect, oauthToken, type Tokens } from './support/mcp.js';

// Real OAuth endpoints; the first session's verified-provider facts are a database fixture here.
// Real Keycloak authentication and the same durable snapshot are exercised by oidc-mcp.e2e.ts.
test('each minted family keeps its authorizing facts across reauthorization, abandoned codes, refresh and session deletion', async () => {
  const email = uniqueEmail('grant-provenance'); const password = 'Correct-horse-provenance-2026';
  const { browser } = await register(email, password);
  const me = expect(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string }; session: { id: string } };
  const userId = me.user.id; const firstSession = me.session.id;
  await pool.query(`UPDATE auth_session_identities SET method = 'oidc-fixture', idp_sid = 'first-provider-session' WHERE session_id = $1`, [firstSession]);
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Provenance control' } }), 201);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'Provenance project', visibility: 'restricted' } }), 201);
  const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: 'Provenance agent', owner: 'self' } }), 201);
  expect(await browser.request('POST', `/api/v1/projects/${project.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = expect(await browser.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id,
    selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'] } }), 201);
  const clientId = `provenance-${randomUUID()}`; const redirectUri = 'http://127.0.0.1:19739/callback';
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method,
    grant_types, response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const family = (tokens: Tokens) => (JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { flux_authentication_reference: string }).flux_authentication_reference;
  const facts = async (key: string) => (await pool.query('SELECT * FROM oauth_grant_authentication WHERE authorization_code_id = $1', [key])).rows[0];
  const first = await oauthToken(browser, String(connection.id), clientId, redirectUri);
  const firstFacts = await facts(family(first));
  assert.equal(firstFacts.auth_method, 'oidc-fixture'); assert.equal(firstFacts.auth_idp_sid, 'first-provider-session');
  const other = (await signIn(email, password)).browser;
  const second = await oauthToken(other, String(connection.id), clientId, redirectUri);
  assert.notEqual(family(first), family(second), 'separate refresh lineages for the same connection/client');
  assert.equal((await facts(family(second))).auth_method, 'password');
  assert.equal((await facts(family(second))).auth_idp_sid, null);
  assert.deepEqual(await facts(family(first)), firstFacts, 'later password authorization cannot relabel the first grant');
  const abandoned = await beginOauth(other, clientId, redirectUri);
  expect(await other.request('POST', `/api/v1/agent-connections/${connection.id}/select-for-oauth`, { body: { oauth_query: abandoned.oauthQuery } }), 204);
  expect(await other.request('POST', '/api/auth/oauth2/continue', { body: { postLogin: true, oauth_query: abandoned.oauthQuery } }), 200);
  assert.deepEqual(await facts(family(first)), firstFacts, 'a code issued but not redeemed changes no existing family');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM oauth_grant_authentication WHERE user_id = $1', [userId])).rows[0].n, 2, 'abandoned authorization creates no minted-grant provenance');
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [firstSession]);
  const response = await fetch(`${apiUrl}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token, resource: `${publicOrigin}/mcp` }) });
  assert.equal(response.status, 200, await response.clone().text());
  const renewed = await response.json() as Tokens;
  assert.equal(family(renewed), family(first), 'refresh keeps the same immutable authentication reference');
  assert.deepEqual(await facts(family(first)), firstFacts, 'the family retains facts after its browser session is deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM oauth_refresh_token WHERE user_id = $1 AND authorization_code_id = $2', [userId, family(first)])).rows[0].n, 2, 'both rotations point to the snapshot');
});
