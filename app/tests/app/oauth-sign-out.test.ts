import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apiUrl, publicOrigin, register, signIn, uniqueEmail, waitForMail, Browser } from './support/http.js';
import { pool } from './support/db.js';
import { beginOauth, decideConsent, expect, mcp, oauthToken, type Tokens } from './support/mcp.js';
import { agentConnection, registerOauthClient } from './support/mcp-actions.js';

// #989: ending a person's other sessions (a password reset, "Sign out my other devices" with a password change, "Sign out all other
// devices") also disconnects their local AI clients. This is the audit probe (oauth_probe.py, #837) as a regression test: before the fix a
// client's refresh token still minted access tokens after the reset, and `/mcp` still answered with the owner's rights.

const password = 'correct horse battery staple';

async function refresh(clientId: string, token: string) {
  const response = await fetch(new URL('/api/auth/oauth2/token', apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource: `${publicOrigin}/mcp` }),
  });
  return { status: response.status, body: await response.json() as Tokens & { error?: string } };
}

/** A person with a space, an agent, and one local client signed in through the real consent page, with a runtime session. */
async function personWithClient(label: string) {
  const email = uniqueEmail(label);
  const { browser } = await register(email, password);
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: `${label} company` } }), 201);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: `${label} project`, visibility: 'restricted' } }), 201);
  const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: `${label} agent`, owner: 'self' } }), 201);
  const client = await agentConnection(pool, browser, String(agent.id), [String(project.id)]);
  assert.equal((await mcp(client.accessToken, 1, 'tools/list')).status, 200, 'the client works before');
  assert.equal((await refresh(client.clientId, client.tokens.refresh_token)).status, 200, 'and so does its refresh token');
  return { email, browser, workspaceId: String(workspace.id), projectId: String(project.id), agentId: String(agent.id), client };
}

/** The client holds nothing: no refresh, an access token that no tool answers to, a revoked connection and no open runtime session. */
async function assertDisconnected(who: Awaited<ReturnType<typeof personWithClient>>) {
  const { client } = who;
  const tokens = client.tokens;
  const refreshed = await refresh(client.clientId, tokens.refresh_token);
  assert.equal(refreshed.status, 400, 'the refresh token is revoked');
  assert.equal(refreshed.body.error, 'invalid_grant');
  const bearer = await mcp(tokens.access_token, 2, 'tools/list');
  assert.ok(bearer.status === 401 || bearer.status === 403, `the access token that has not expired is refused, got ${bearer.status}`);
  const rows = (await pool.query('SELECT revoked_at FROM agent_connections WHERE id = $1', [client.connectionId])).rows as { revoked_at: Date | null }[];
  assert.ok(rows[0]?.revoked_at, 'the connection is disconnected, as the Disconnect button does it');
  const runtimes = (await pool.query('SELECT count(*)::int AS n FROM agent_runtime_sessions WHERE connection_id = $1 AND revoked_at IS NULL', [client.connectionId])).rows[0];
  assert.equal(runtimes.n, 0, 'its runtime sessions are over');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM oauth_access_token WHERE user_id = (SELECT owner_user_id FROM agent_connections WHERE id = $1)', [client.connectionId])).rows[0].n, 0);
}

test('a password reset disconnects the local clients: no refresh, no /mcp, and the next sign-in asks on the consent page and gets the same agent back', async () => {
  const who = await personWithClient('reset-clients');
  assert.ok((await pool.query('SELECT 1 FROM agent_runtime_sessions WHERE connection_id = $1 AND revoked_at IS NULL', [who.client.connectionId])).rowCount, 'a runtime session is open');
  const peer = await personWithClient('reset-peer');

  assert.equal((await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email: who.email, redirectTo: `${publicOrigin}/reset-password` } })).status, 200);
  const token = (await waitForMail(who.email)).match(/reset-password\/([^?\s]+)/)?.[1];
  assert.ok(token);
  const newPassword = 'a different passphrase for the harbour';
  assert.equal((await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword } })).status, 200);

  assert.equal((await who.browser.request('GET', '/api/v1/me')).status, 401, 'the browser session ended (as before)');
  await assertDisconnected(who);

  // Someone else's client is not touched.
  assert.equal((await refresh(peer.client.clientId, peer.client.tokens.refresh_token)).status, 200);
  assert.equal((await mcp(peer.client.accessToken, 3, 'tools/list')).status, 200);

  // One click brings the client back: it is not "found" without a page any more, and Allow gives the same agent.
  const { browser: again } = await signIn(who.email, newPassword);
  const started = await beginOauth(again, who.client.clientId, 'http://127.0.0.1:19737/callback');
  assert.equal(started.consent, true, 'the consent page asks again');
  const allowed = expect(await decideConsent(again, started, true), 200);
  assert.ok(allowed.url ?? allowed.redirect_uri, 'Allow answers with the client\'s redirect');
  const connections = expect(await again.request('GET', '/api/v1/agent-connections'), 200) as unknown as { id: string; agentId: string; revokedAt: string | null }[];
  const live = connections.filter((item) => !item.revokedAt);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.agentId, who.agentId, 'C-20: what was assigned to the agent and what it did stay with one identity');
  assert.notEqual(live[0]!.id, who.client.connectionId, 'a new connection');
});

test('"Sign out all other devices" disconnects the local clients and keeps this browser, the assistant and other people\'s clients', async () => {
  const who = await personWithClient('sign-out-clients');
  const peer = await personWithClient('sign-out-peer');
  // The owner's own assistant is not a client: it lives on the same table and stays.
  const assistantAgent = expect(await who.browser.request('POST', `/api/v1/workspaces/${who.workspaceId}/agents`, { body: { name: 'Own assistant', owner: 'self' } }), 201);
  const assistantConnection = randomUUID();
  await pool.query(`INSERT INTO agent_connections (id, workspace_id, owner_user_id, agent_id, name, client_designation, compute_source)
    VALUES ($1, $2, (SELECT owner_user_id FROM agent_connections WHERE id = $3), $4, 'Own assistant', 'other', 'owner_assistant')`,
  [assistantConnection, who.workspaceId, who.client.connectionId, assistantAgent.id]);
  const other = (await signIn(who.email, password)).browser;
  assert.equal((await other.request('GET', '/api/v1/me')).status, 200);

  const out = await who.browser.request('POST', '/api/v1/sessions/revoke-others');
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { revoked: 1, disconnected: 1 }, 'one other device, one client');
  assert.equal((await other.request('GET', '/api/v1/me')).status, 401);
  assert.equal((await who.browser.request('GET', '/api/v1/me')).status, 200, 'this device stays signed in');
  await assertDisconnected(who);
  assert.equal((await pool.query('SELECT revoked_at FROM agent_connections WHERE id = $1', [assistantConnection])).rows[0].revoked_at, null, 'the assistant is not a client');
  assert.equal((await refresh(peer.client.clientId, peer.client.tokens.refresh_token)).status, 200, 'another person\'s client stays');

  const nothing = await who.browser.request('POST', '/api/v1/sessions/revoke-others');
  assert.deepEqual(nothing.json, { revoked: 0, disconnected: 0 }, 'a second time there is nothing to end');
});

test('a password change disconnects the clients only when it also signs out the other devices', async () => {
  const kept = await personWithClient('change-keeps');
  expect(await kept.browser.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: 'the first new passphrase here', revokeOtherSessions: false } }), 200);
  assert.equal((await refresh(kept.client.clientId, kept.client.tokens.refresh_token)).status, 200, 'without "sign out my other devices" the client stays');
  assert.equal((await mcp(kept.client.accessToken, 4, 'tools/list')).status, 200);

  const ended = await personWithClient('change-ends');
  assert.equal((await ended.browser.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: 'the second new passphrase here', revokeOtherSessions: true } })).status, 200);
  assert.equal((await ended.browser.request('GET', '/api/v1/me')).status, 200, 'the session that changed it continues');
  await assertDisconnected(ended);
});

test('Better Auth\'s own "revoke all" endpoints are off: sessions end only through Flux\'s routes', async () => {
  const { browser } = await register(uniqueEmail('revoke-routes'), password);
  for (const path of ['/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions']) {
    assert.equal((await browser.request('POST', path, { body: {} })).status, 404, path);
  }
  assert.equal((await browser.request('GET', '/api/v1/me')).status, 200);
});

test('a client connected with one click on the consent page is disconnected like any other', async () => {
  const { browser } = await register(uniqueEmail('consent-only'), password);
  expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Consent only company' } }), 201);
  const { clientId, redirectUri } = await registerOauthClient(pool);
  const tokens = await oauthToken(browser, clientId, redirectUri);
  assert.deepEqual((await browser.request('POST', '/api/v1/sessions/revoke-others')).json, { revoked: 0, disconnected: 1 }, 'a client connected by the consent page alone counts');
  assert.equal((await refresh(clientId, tokens.refresh_token)).status, 400);
});
