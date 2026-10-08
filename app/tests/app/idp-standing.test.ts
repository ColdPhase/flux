import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { idpStandingRepository, schema } from '@flux/db';
import type { OidcConfig } from '../../apps/server/src/identity/config.js';
import { createIdpStanding, openToken, sealKey, sealToken, signInAgainMessage } from '../../apps/server/src/identity/standing.js';
import { db, insertedHuman, pool } from './support/db.js';

// The standing check of a person's account at the identity provider (F-024 S4, #311), against the Compose
// database and a scripted provider. The Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts (scripts/check_oidc.sh).
const provider = () => `oidc-${randomUUID().slice(0, 12)}`;
const config = (providerId: string, standing: 'refresh' | 'off' = 'refresh'): OidcConfig => ({
  providerId, issuer: 'http://idp.test/realms/flux', clientId: 'flux', clientSecret: 'client-secret-xyz', label: 'Acme "login"', standing, standingIntervalMs: 900_000,
});
const authSecret = 'a'.repeat(40);

type Reply = { status: number; body?: unknown } | 'throw';
function scriptedProvider(replies: Reply[]) {
  const calls: { url: string; body: string; authorization?: string }[] = [];
  const fetcher = async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return { ok: true, status: 200, json: async () => ({ token_endpoint: 'http://idp.test/token', revocation_endpoint: 'http://idp.test/revoke' }) };
    }
    calls.push({ url, body: init.body ?? '', authorization: init.headers?.authorization });
    if (url.endsWith('/revoke')) return { ok: true, status: 200, json: async () => ({}) };
    const reply = replies.shift() ?? 'throw';
    if (reply === 'throw') throw new Error('timeout');
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
  };
  return { fetcher, calls, tokenCalls: () => calls.filter((call) => call.url.endsWith('/token')) };
}

function standingFor(providerId: string, replies: Reply[], standing: 'refresh' | 'off' = 'refresh') {
  const script = scriptedProvider(replies);
  const logs: string[] = [];
  const log = { info: (o: object, m: string) => logs.push(JSON.stringify([o, m])), warn: (o: object, m: string) => logs.push(JSON.stringify([o, m])), error: (o: object, m: string) => logs.push(JSON.stringify([o, m])) };
  const service = createIdpStanding({ db, oidc: config(providerId, standing), authSecret, log, fetcher: script.fetcher as never, retryMs: 60_000 });
  return { service, script, logs };
}

async function person(providerId: string, options: { session?: boolean } = {}) {
  const human = await insertedHuman('standing');
  await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: human.id, accountId: randomUUID(), providerId });
  if (options.session !== false) {
    await db.insert(schema.authSessions).values({ id: randomUUID(), userId: human.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  }
  return human.id;
}
const row = async (userId: string) => (await pool.query('SELECT * FROM auth_idp_standing WHERE user_id = $1', [userId])).rows[0];
const sessions = async (userId: string) => (await pool.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [userId])).rowCount;
const due = (userId: string) => pool.query(`UPDATE auth_idp_standing SET next_check_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
const key = sealKey(authSecret);

describe('the sealed provider token', () => {
  test('round-trips, is bound to its person and provider, and does not hold the token in the clear', () => {
    const sealed = sealToken(key, 'u1', 'p1', 'refresh-token-value');
    assert.ok(sealed.startsWith('v1.') && !sealed.includes('refresh-token-value'));
    assert.equal(openToken(key, 'u1', 'p1', sealed), 'refresh-token-value');
    assert.equal(openToken(key, 'u2', 'p1', sealed), null, 'another person');
    assert.equal(openToken(key, 'u1', 'p2', sealed), null, 'another provider');
    assert.equal(openToken(sealKey('b'.repeat(40)), 'u1', 'p1', sealed), null, 'another secret');
    const [version, iv, tag, body] = sealed.split('.');
    assert.equal(openToken(key, 'u1', 'p1', [version, iv, tag, `${body}A`].join('.')), null, 'tampered');
    assert.notEqual(sealToken(key, 'u1', 'p1', 'refresh-token-value'), sealed, 'a fresh nonce each time');
    assert.notEqual(key.toString('utf8'), authSecret);
  });

  test('the 401 description keeps to the characters RFC 6750 allows', () => {
    assert.equal(signInAgainMessage('Acme "login"'), 'Sign in again with Acme login.');
    assert.equal(signInAgainMessage('a\\bé\n\tz'), 'Sign in again with abz.');
    assert.equal(signInAgainMessage('"\\'), 'Sign in again with your identity provider.');
  });
});

describe('a provider sign-in', () => {
  test('stores the token sealed, clears sign-in required and revokes only a token it replaces', async () => {
    const id = provider();
    const { service, script } = standingFor(id, []);
    const userId = await person(id);
    await service.recordSignIn(userId, 'first-token');
    const stored = await row(userId);
    assert.equal(stored.state, 'ok');
    assert.equal(openToken(key, userId, id, stored.refresh_token_enc), 'first-token');
    assert.equal(script.calls.filter((call) => call.url.endsWith('/revoke')).length, 0, 'nothing to revoke the first time');
    await service.recordSignIn(userId, 'first-token');
    assert.equal(script.calls.filter((call) => call.url.endsWith('/revoke')).length, 0, 'the same token is not revoked');
    await pool.query(`UPDATE auth_idp_standing SET state = 'sign_in_required', reason = 'invalid_grant' WHERE user_id = $1`, [userId]);
    assert.equal(await service.stands(userId), false);
    await service.recordSignIn(userId, 'second-token');
    assert.equal(await service.stands(userId), true, 'a new sign-in clears the state');
    const revocations = script.calls.filter((call) => call.url.endsWith('/revoke'));
    assert.equal(revocations.length, 1);
    assert.match(revocations[0]!.body, /token=first-token/);
    assert.match(revocations[0]!.body, /token_type_hint=refresh_token/);
  });
});

describe('the check', () => {
  test('success renews the confirmation and stores a rotated token in the same write', async () => {
    const id = provider();
    const { service, script, logs } = standingFor(id, [{ status: 200, body: { access_token: 'at', refresh_token: 'rotated-token' } }, { status: 200, body: { access_token: 'at' } }]);
    const userId = await person(id);
    await service.recordSignIn(userId, 'first-token');
    await pool.query(`UPDATE auth_idp_standing SET confirmed_at = now() - interval '3 hours' WHERE user_id = $1`, [userId]);
    await due(userId);
    assert.equal(await service.runOnce(), 1);
    const after = await row(userId);
    assert.equal(after.state, 'ok');
    assert.equal(after.last_outcome, 'success');
    assert.ok(Date.now() - after.confirmed_at.getTime() < 30_000);
    assert.equal(openToken(key, userId, id, after.refresh_token_enc), 'rotated-token');
    assert.equal(after.lease_id, null);
    assert.ok(after.next_check_at.getTime() > Date.now() + 800_000, 'the next check is a full interval away');
    const call = script.tokenCalls()[0]!;
    assert.match(call.body, /grant_type=refresh_token/);
    assert.match(call.body, /refresh_token=first-token/);
    assert.match(call.authorization ?? '', /^Basic /);
    // A response without a new token keeps the stored one.
    await due(userId);
    assert.equal(await service.runOnce(), 1);
    assert.equal(openToken(key, userId, id, (await row(userId)).refresh_token_enc), 'rotated-token');
    assert.ok(!logs.join('\n').includes('rotated-token') && !logs.join('\n').includes('first-token'), 'no provider token reaches a log');
  });

  test('invalid_grant is sign-in required: browser sessions go, nothing else is revoked, and checks go on until a success restores it', async () => {
    const id = provider();
    const { service } = standingFor(id, [{ status: 400, body: { error: 'invalid_grant', error_description: 'User disabled' } },
      { status: 400, body: { error: 'invalid_grant' } }, { status: 200, body: { access_token: 'at' } }]);
    const userId = await person(id);
    const bystander = await person(id);
    await service.recordSignIn(userId, 't1');
    await service.recordSignIn(bystander, 't2');
    await due(userId);
    await service.runOnce();
    const suspended = await row(userId);
    assert.equal(suspended.state, 'sign_in_required');
    assert.equal(suspended.reason, 'invalid_grant');
    assert.equal(await sessions(userId), 0, 'the browser sessions are deleted');
    assert.equal(await sessions(bystander), 1, 'negative control: someone else is untouched');
    assert.equal((await row(bystander)).state, 'ok');
    assert.equal(await service.stands(userId), false);
    assert.ok(suspended.refresh_token_enc, 'the token is kept: checks continue for a suspended identity');

    // Eligible only while a grant or session exists: give the suspended person an unrevoked MCP refresh token.
    const client = `client-${randomUUID()}`;
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
      VALUES ($1, $2, 'c', $3, 'none', '{authorization_code}', '{code}', '{offline_access}', true, now(), now())`, [randomUUID(), client, ['http://127.0.0.1/cb']]);
    await pool.query(`INSERT INTO oauth_refresh_token (id, token, client_id, user_id, expires_at, created_at, scopes) VALUES ($1, $2, $3, $4, now() + interval '1 day', now(), '{offline_access}')`,
      [randomUUID(), randomUUID(), client, userId]);
    await due(userId);
    await service.runOnce();
    assert.equal((await row(userId)).state, 'sign_in_required', 'a second invalid_grant changes nothing');
    await due(userId);
    await service.runOnce();
    const restored = await row(userId);
    assert.equal(restored.state, 'ok', 'a later successful check clears the state (N5)');
    assert.equal(restored.reason, null);
    assert.equal(await service.stands(userId), true);
    assert.equal(await sessions(userId), 0, 'the deleted browser sessions do not return');
    assert.equal((await pool.query('SELECT 1 FROM oauth_refresh_token WHERE user_id = $1 AND revoked IS NOT NULL', [userId])).rowCount, 0, 'nothing was revoked');
  });

  test('a timeout, 5xx, invalid_client or bad answer is unknown: nothing changes except a sooner retry', async () => {
    const id = provider();
    const outcomes: Reply[] = ['throw', { status: 503, body: {} }, { status: 401, body: { error: 'invalid_client' } }, { status: 200, body: { nonsense: true } }, { status: 400, body: { error: 'invalid_request' } }];
    const count = outcomes.length;
    const { service } = standingFor(id, outcomes);
    const userId = await person(id);
    await service.recordSignIn(userId, 't1');
    const before = (await row(userId)).confirmed_at.getTime();
    for (let attempt = 0; attempt < count; attempt += 1) {
      await due(userId);
      await service.runOnce();
      const unknown = await row(userId);
      assert.equal(unknown.state, 'ok');
      assert.equal(unknown.last_outcome, 'unknown');
      assert.equal(unknown.confirmed_at.getTime(), before, 'the confirmation is unchanged');
      assert.ok(unknown.next_check_at.getTime() < Date.now() + 120_000, 'retried within minutes');
      assert.equal(await sessions(userId), 1);
    }
  });

  test('the provider is called with no row lock and no open transaction, and one identity is never checked twice at once', async () => {
    const id = provider();
    const userId = await person(id);
    const observed: { lockable: boolean; open: number }[] = [];
    const script = scriptedProvider([]);
    const fetcher = async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      if (url.endsWith('/token')) {
        const probe = await pool.connect();
        try {
          await probe.query('BEGIN');
          let lockable = true;
          try { await probe.query('SELECT 1 FROM auth_idp_standing WHERE user_id = $1 FOR UPDATE NOWAIT', [userId]); } catch { lockable = false; }
          await probe.query('ROLLBACK');
          const open = (await probe.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`)).rows[0].n as number;
          observed.push({ lockable, open });
        } finally { probe.release(); }
        return { ok: true, status: 200, json: async () => ({ access_token: 'at' }) };
      }
      return script.fetcher(url, init);
    };
    const service = createIdpStanding({ db, oidc: config(id), authSecret, log: { info() {}, warn() {}, error() {} }, fetcher: fetcher as never });
    await service.recordSignIn(userId, 't1');
    await due(userId);
    const [first, second] = await Promise.all([service.runOnce(), service.runOnce()]);
    assert.equal(first + second, 1, 'two replicas never check one identity at once');
    assert.equal(observed.length, 1);
    assert.deepEqual(observed[0], { lockable: true, open: 0 }, 'the provider answered while no lock or transaction was held');
  });

  test('a lease expires so a crashed replica does not strand an identity, and a stale writer cannot overwrite a newer outcome', async () => {
    const id = provider();
    const rows = idpStandingRepository(db);
    const userId = await person(id);
    const { service } = standingFor(id, []);
    await service.recordSignIn(userId, 't1');
    await due(userId);
    const now = new Date();
    const [slow] = await rows.claim(now, 30_000, 5, 'lease-slow');
    assert.equal(slow?.userId, userId);
    assert.equal((await rows.claim(now, 30_000, 5, 'lease-other')).length, 0, 'leased');
    const later = new Date(now.getTime() + 31_000);
    const [fast] = await rows.claim(later, 30_000, 5, 'lease-fast');
    assert.equal(fast?.leaseId, 'lease-fast', 'the lease ran out');
    assert.equal(await rows.finish(fast!, { outcome: 'sign_in_required', reason: 'invalid_grant' }, later, later), true);
    assert.equal(await rows.finish(slow!, { outcome: 'success' }, later, later), false, 'the stale writer changes nothing');
    assert.equal((await row(userId)).state, 'sign_in_required');
  });

  test('only identities with a live session or MCP grant are checked', async () => {
    const id = provider();
    const { service, script } = standingFor(id, [{ status: 200, body: { access_token: 'at' } }]);
    const idle = await person(id, { session: false });
    await service.recordSignIn(idle, 't1');
    await due(idle);
    assert.equal(await service.runOnce(), 0);
    assert.equal(script.tokenCalls().length, 0);
  });
});

describe('startup', () => {
  test('an account without a stored token is in sign-in required; with the check off no row refuses anyone', async () => {
    const id = provider();
    const { service } = standingFor(id, []);
    const restored = await person(id);
    const fresh = await person(id);
    await service.recordSignIn(fresh, 't1');
    await service.reconcile();
    assert.equal((await row(restored)).state, 'sign_in_required');
    assert.equal((await row(restored)).reason, 'no_token');
    assert.equal(await service.stands(restored), false);
    assert.equal((await row(fresh)).state, 'ok', 'an account that has a token keeps its standing');

    const other = provider();
    const otherPerson = await person(other);
    await standingFor(other, []).service.reconcile();
    assert.equal(await idpStandingRepository(db).refuses(otherPerson), true);
    await standingFor(other, [], 'off').service.reconcile();
    assert.equal(await idpStandingRepository(db).refuses(otherPerson), false, 'off clears this provider\'s rows');
    assert.equal(await idpStandingRepository(db).refuses(restored), true, 'and no other provider\'s');
    assert.equal(await standingFor(other, [], 'off').service.runOnce(), 0, 'off never checks');
  });
});
