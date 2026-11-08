import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin, register, uniqueEmail } from './support/http.js';
import { expect, oauthToken, type Tokens } from './support/mcp.js';
import { registerOauthClient } from './support/mcp-actions.js';

// Refresh-token rotation has one successor (#916). Better Auth rotates with a guarded update (`revoked IS NULL`) and creates the
// successor only after the guard passes, so requests refreshing with the same token at once make one new token pair. Flux has the
// 30-second retry window of docs/product/mcp-identity.md: a request that reads the token after its rotation gets that same pair again,
// and one that loses the guard gets `invalid_grant`. Nobody gets a second successor, and nothing inside the window ends the family.
// The client signs in as a person signs one in (#859): it opens the authorization URL and Allow on the consent page makes its connection.

async function scene() {
  const { browser } = await register(uniqueEmail('refresh-rotation'), 'correct horse battery staple');
  expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Refresh rotation' } }), 201);
  const { clientId, redirectUri } = await registerOauthClient(pool);
  const grant = async (): Promise<Tokens> => oauthToken(browser, clientId, redirectUri);
  const refresh = (refreshToken: string) => fetch(new URL('/api/auth/oauth2/token', apiUrl), { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: `${publicOrigin}/mcp` }) });
  const rows = async () => Number((await pool.query('SELECT count(*) FROM oauth_refresh_token WHERE client_id = $1', [clientId])).rows[0].count);
  const live = async () => Number((await pool.query('SELECT count(*) FROM oauth_refresh_token WHERE client_id = $1 AND revoked IS NULL', [clientId])).rows[0].count);
  const endRetryWindow = () => pool.query('UPDATE oauth_refresh_token SET rotation_replay_expires_at = now() - interval \'1 second\' WHERE client_id = $1 AND revoked IS NOT NULL', [clientId]);
  return { grant, refresh, rows, live, endRetryWindow };
}

test('concurrent refreshes with one token make one successor: the others get its pair again or invalid_grant', { timeout: 90_000 }, async () => {
  // Several independent connections, so a lucky ordering in one round cannot hide a second successor in another.
  for (let round = 0; round < 3; round++) {
    const f = await scene();
    const tokens = await f.grant();
    assert.equal(await f.rows(), 1, 'the grant starts with its one refresh token');
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const response = await f.refresh(tokens.refresh_token);
      return { status: response.status, body: await response.json() as Partial<Tokens> & { error?: string } };
    }));
    const granted = results.filter((result) => result.status === 200);
    assert.ok(granted.length >= 1, `round ${round}: one refresh wins (${JSON.stringify(results.map((result) => result.status))})`);
    const successors = new Set(granted.map((result) => result.body.refresh_token));
    assert.equal(successors.size, 1, 'every success carries the same new refresh token: one successor');
    assert.ok(!successors.has(tokens.refresh_token) && !successors.has(undefined), 'and it is a new one');
    for (const refused of results.filter((result) => result.status !== 200)) {
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error, 'invalid_grant');
      assert.equal(refused.body.refresh_token, undefined, 'a refused request is handed no token');
    }
    assert.equal(await f.rows(), 2, `round ${round}: the original and one successor, none made by a loser`);
    assert.equal(await f.live(), 1, 'and only the successor is live');
  }
});

test('a token used again after the retry window is refused, and its whole connection family goes with it', { timeout: 30_000 }, async () => {
  const f = await scene();
  const tokens = await f.grant();
  const first = await f.refresh(tokens.refresh_token);
  assert.equal(first.status, 200, 'the first use rotates');
  const successor = (await first.json()) as Tokens;
  assert.equal(await f.rows(), 2, 'the original and its successor');
  const retry = await f.refresh(tokens.refresh_token);
  assert.equal(retry.status, 200, 'a retry inside the window is answered');
  assert.equal(((await retry.json()) as Tokens).refresh_token, successor.refresh_token, 'with the same successor, not a second one');
  assert.equal(await f.rows(), 2);
  await f.endRetryWindow();
  const late = await f.refresh(tokens.refresh_token);
  assert.equal(late.status, 400, 'after the window the used token is refused');
  assert.equal(((await late.json()) as { error?: string }).error, 'invalid_grant');
  assert.equal(await f.rows(), 0, 'reuse of a rotated token ends the whole family, the successor included');
  assert.equal((await f.refresh(successor.refresh_token)).status, 400, 'so the successor no longer refreshes');
});
