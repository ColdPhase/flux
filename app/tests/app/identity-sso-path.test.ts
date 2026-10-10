import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { withoutIdpTokens } from '../../apps/server/src/identity/auth.js';
import { createConfirmation } from '../../apps/server/src/identity/confirmation.js';
import { loadOidcConfig, parseConfirmationMaxAge, type OidcConfig } from '../../apps/server/src/identity/config.js';
import { cachedReachability, discoveryReachable, waitForDiscovery } from '../../apps/server/src/identity/discovery.js';
import { db, pool } from './support/db.js';
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

describe('the confirmation age (F-024 S2, #312)', () => {
  const HOUR = 3_600_000;
  const oidc: OidcConfig = { providerId: 'oidc-test', issuer: 'http://idp.test/realms/flux', clientId: 'flux', clientSecret: 's', label: 'IdP', standing: 'off', standingIntervalMs: 900_000, confirmationMaxAgeMs: 12 * HOUR };
  const at = new Date('2026-10-10T12:00:00Z');
  const confirmation = createConfirmation(db, oidc, () => at);

  /** A person with a provider identity confirmed `hoursAgo` (null: never), and a session that signed in with `method`. */
  async function person(hoursAgo: number | null, method: string = oidc.providerId) {
    const userId = randomUUID(); const sessionId = randomUUID();
    await pool.query('INSERT INTO auth_users (id, name, email, email_verified) VALUES ($1, $2, $3, true)', [userId, 'P', `${userId}@example.test`]);
    await pool.query('INSERT INTO auth_accounts (id, user_id, account_id, provider_id, confirmed_at) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), userId, userId, oidc.providerId, hoursAgo === null ? null : new Date(at.getTime() - hoursAgo * HOUR)]);
    await pool.query(`INSERT INTO auth_sessions (id, user_id, token, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [sessionId, userId, randomUUID()]);
    await pool.query('INSERT INTO auth_session_identities (session_id, method) VALUES ($1, $2)', [sessionId, method]);
    return { userId, sessionId };
  }
  const sessionExists = async (id: string) => (await pool.query('SELECT 1 FROM auth_sessions WHERE id = $1', [id])).rowCount === 1;

  test('the setting takes whole hours or days from 1h to 30d, and 7d when empty', () => {
    assert.equal(parseConfirmationMaxAge(undefined), 7 * 24 * HOUR);
    assert.equal(parseConfirmationMaxAge(' '), 7 * 24 * HOUR);
    assert.equal(parseConfirmationMaxAge('1h'), HOUR);
    assert.equal(parseConfirmationMaxAge('36h'), 36 * HOUR);
    assert.equal(parseConfirmationMaxAge('30d'), 30 * 24 * HOUR);
    for (const bad of ['59m', '0h', '0d', '31d', '721h', '7', 'd', '1.5d', '-1h', '7days', '1h30m', '99999d']) {
      assert.throws(() => parseConfirmationMaxAge(bad), /FLUX_OIDC_CONFIRMATION_MAX_AGE must be from 1h to 30d/, bad);
    }
    const env = { FLUX_OIDC_ISSUER: 'https://id.example.org/realms/flux', FLUX_OIDC_CLIENT_ID: 'flux', FLUX_OIDC_CLIENT_SECRET_FILE: '/s' };
    assert.equal(loadOidcConfig(env, () => 'x')!.confirmationMaxAgeMs, 7 * 24 * HOUR);
    assert.equal(loadOidcConfig({ ...env, FLUX_OIDC_CONFIRMATION_MAX_AGE: '12h' }, () => 'x')!.confirmationMaxAgeMs, 12 * HOUR);
    assert.throws(() => loadOidcConfig({ ...env, FLUX_OIDC_CONFIRMATION_MAX_AGE: '31d' }, () => 'x'), /1h to 30d/);
  });

  test('a provider identity is lapsed only once its confirmation is older than the age', async () => {
    assert.equal(await confirmation.lapsed((await person(11)).userId), false, 'within the age');
    assert.equal(await confirmation.lapsed((await person(13)).userId), true, 'past the age');
    assert.equal(await confirmation.lapsed((await person(null)).userId), true, 'never confirmed');
  });

  test('the standing check\'s success also confirms, and the newest of the two counts', async () => {
    const { userId } = await person(100);
    const standingConfirmed = (hours: number) => pool.query(
      `INSERT INTO auth_idp_standing (user_id, provider_id, confirmed_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET confirmed_at = EXCLUDED.confirmed_at`, [userId, oidc.providerId, new Date(at.getTime() - hours * HOUR)]);
    await standingConfirmed(2);
    assert.equal(await confirmation.lapsed(userId), false, 'a recent standing success renews an old sign-in');
    await standingConfirmed(50);
    assert.equal(await confirmation.lapsed(userId), true, 'both old');
    await pool.query('UPDATE auth_accounts SET confirmed_at = $2 WHERE user_id = $1', [userId, new Date(at.getTime() - HOUR)]);
    assert.equal(await confirmation.lapsed(userId), false, 'a recent sign-in renews an old standing row');
  });

  test('negative controls: a password-only person, a stranger and an installation without a provider are never lapsed', async () => {
    const { userId } = await register(uniqueEmail('confirmation-password'), password).then(async ({ browser }) =>
      ({ userId: ((await browser.request('GET', '/api/v1/me')).json as { user: { id: string } }).user.id }));
    assert.equal(await confirmation.lapsed(userId), false, 'a password account has no provider identity');
    assert.equal(await confirmation.lapsed(randomUUID()), false);
    const expired = await person(1000);
    assert.equal(await createConfirmation(db, null, () => at).lapsed(expired.userId), false, 'no provider configured');
  });

  test('confirming a provider sign-in renews the identity', async () => {
    const { userId } = await person(100);
    assert.equal(await confirmation.lapsed(userId), true);
    await confirmation.confirm(userId, oidc.providerId);
    assert.equal(await confirmation.lapsed(userId), false);
  });

  test('a lapsed provider session ends and stays ended; a fresh one, and a password session of the same person, do not', async () => {
    const lapsed = await person(13);
    assert.equal(await confirmation.endIfLapsed(lapsed.sessionId), true);
    assert.equal(await sessionExists(lapsed.sessionId), false);
    assert.equal(await confirmation.endIfLapsed(lapsed.sessionId), false, 'already gone');
    const fresh = await person(11);
    assert.equal(await confirmation.endIfLapsed(fresh.sessionId), false);
    assert.equal(await sessionExists(fresh.sessionId), true);
    const password = await person(13, 'password');
    assert.equal(await confirmation.endIfLapsed(password.sessionId), false, 'S5b, not S2, decides password sessions');
    assert.equal(await sessionExists(password.sessionId), true);
  });
});
