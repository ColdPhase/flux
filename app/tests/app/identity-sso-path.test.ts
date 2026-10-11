import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { withoutIdpTokens } from '../../apps/server/src/identity/auth.js';
import { cachedReachability, discoveryReachable, waitForDiscovery } from '../../apps/server/src/identity/discovery.js';
import { pool } from './support/db.js';
import { register, signIn, uniqueEmail } from './support/http.js';
import { password } from './support/people.js';

// Provider sign-in on the MCP authorization path (F-024 S1, #310): what does not need a provider.
// The Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts (scripts/check_oidc.sh).
const issuer = { issuer: 'http://idp.test/realms/flux' };

describe('how a session signed in', () => {
  test('password sign-up and sign-in each record a password session with a confirmation time and no IdP session id', async () => {
    const email = uniqueEmail('session-identity');
    const { browser } = await register(email, password);
    await signIn(email, password);
    const me = (await browser.request('GET', '/api/v1/me')).json as { user: { id: string } };
    const rows = (await pool.query(`SELECT i.method, i.idp_sid, i.confirmed_at > now() - interval '5 minutes' AS recent
      FROM auth_session_identities i JOIN auth_sessions s ON s.id = i.session_id WHERE s.user_id = $1`, [me.user.id])).rows;
    assert.equal(rows.length, 2, 'one row per session');
    assert.ok(rows.every((row) => row.method === 'password' && row.idp_sid === null && row.recent === true));
  });

  test('revoking a session removes its record', async () => {
    const email = uniqueEmail('session-identity-revoke');
    const { browser } = await register(email, password);
    const me = (await browser.request('GET', '/api/v1/me')).json as { user: { id: string }; session: { id: string } };
    const other = await signIn(email, password);
    assert.equal((await other.browser.request('DELETE', `/api/v1/sessions/${me.session.id}`)).status, 204);
    assert.equal((await pool.query('SELECT 1 FROM auth_session_identities WHERE session_id = $1', [me.session.id])).rowCount, 0);
  });
});

describe('provider tokens are never stored on the account', () => {
  test('every provider token and its expiry is cleared, the identity and password hash are kept', () => {
    const written = { userId: 'u', providerId: 'oidc-abc', accountId: 'sub-1', accessToken: 'at', refreshToken: 'rt', idToken: 'it',
      accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: new Date(), scope: 'openid', password: 'hash' };
    assert.deepEqual(withoutIdpTokens(written), { ...written, accessToken: null, refreshToken: null, idToken: null,
      accessTokenExpiresAt: null, refreshTokenExpiresAt: null });
    assert.deepEqual(withoutIdpTokens({ scope: 'openid' }), { scope: 'openid' }, 'a write without tokens gains none');
  });
});

describe('the provider\'s discovery document is read lazily and retried', () => {
  const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });
  const full = { authorization_endpoint: 'a', token_endpoint: 't', jwks_uri: 'j' };

  test('reachable only with a usable document', async () => {
    assert.equal(await discoveryReachable(issuer, answer(full)), true);
    assert.equal(await discoveryReachable(issuer, answer({ ...full, jwks_uri: undefined })), false);
    assert.equal(await discoveryReachable(issuer, answer(full, false)), false);
    assert.equal(await discoveryReachable(issuer, async () => { throw new Error('down'); }), false);
  });

  test('a provider that comes up after a few tries is used; one that never does is reported after the last try', async () => {
    const waits: number[] = [];
    let calls = 0;
    const sleep = async (ms: number) => { waits.push(ms); };
    assert.equal(await waitForDiscovery(issuer, { attempts: 5, delayMs: 100, maxDelayMs: 300, sleep, probe: async () => ++calls === 3 }), true);
    assert.deepEqual(waits, [100, 200]);
    waits.length = 0; calls = 0;
    assert.equal(await waitForDiscovery(issuer, { attempts: 4, delayMs: 100, maxDelayMs: 300, sleep, probe: async () => { calls += 1; return false; } }), false);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [100, 200, 300], 'backoff doubles and stops at the cap, with no wait after the last try');
  });

  test('a busy sign-in page shares one probe for a few seconds', async () => {
    let probes = 0; let clock = 0;
    const reachable = cachedReachability(issuer, 5000, async () => { probes += 1; return probes > 1; }, () => clock);
    assert.equal(await reachable(), false);
    assert.equal(await reachable(), false, 'cached');
    assert.equal(probes, 1);
    clock = 5000;
    assert.equal(await reachable(), true, 'asked again after the interval');
  });
});
